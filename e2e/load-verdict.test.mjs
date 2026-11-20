// The load test's verdict (e2e/load-verdict.mjs) must reject a failed run: `node --test
// e2e/load-verdict.test.mjs` (part of `npm test`). No instance is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { CLEAN_AFTER_LEAVE_KEYS, exitCodeOf, judgeLoadRun } from "./load-verdict.mjs";

const VERDICT_CLI = fileURLToPath(new URL("load-verdict.mjs", import.meta.url));
const MIB = 1024 * 1024;

const CLEAN = {
	...Object.fromEntries(CLEAN_AFTER_LEAVE_KEYS.map(key => [key, 0])),
	eventListeners: 1,
};

/** A run that passes every criterion: 1,000 quick replies, flat memory, a clean instance. */
function goodRun() {
	const sends = Array.from({ length: 1000 }, (_, index) => ({ outcome: "replied", latencyMs: 5 + (index % 20) }));
	const samples = Array.from({ length: 60 }, (_, index) => {
		return {
			at: index * 10_000,
			memory: { heapUsed: 100 * MIB + (index % 3) * MIB, rss: 340 * MIB },
		};
	});

	return {
		sends,
		reportedSent: sends.length,
		lateReplies: 0,
		unexpectedReplies: 0,
		unexpectedDisconnects: 0,
		crossVisitorEvents: 0,
		samples,
		sampleMs: 10_000,
		baseline: { ...CLEAN },
		afterLeave: [{ ...CLEAN, sessions: 3 }, { ...CLEAN }],
	};
}

/** Replaces the first `count` sends' outcomes. */
function withOutcome(run, outcome, count) {
	const sends = run.sends.map((send, index) => (index < count ? { outcome, latencyMs: null } : send));

	return { ...run, sends };
}

function failedCriteria(run) {
	const { verdict } = judgeLoadRun(run);

	return Object.entries(verdict)
		.filter(([, isMet]) => !isMet)
		.map(([name]) => name);
}

function cli(run) {
	const directory = mkdtempSync(nodePath.join(tmpdir(), "mockwa-load-verdict-"));
	const file = nodePath.join(directory, "report.json");

	try {
		writeFileSync(file, JSON.stringify({ run }));

		const result = spawnSync(process.execPath, [VERDICT_CLI, file], { encoding: "utf8", timeout: 30_000 });

		return { status: result.status, output: `${result.stdout}${result.stderr}` };
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

describe("the load-test verdict", () => {
	it("accepts a run that meets every criterion", () => {
		const judgement = judgeLoadRun(goodRun());

		assert.deepEqual(failedCriteria(goodRun()), []);
		assert.equal(judgement.isAccepted, true);
		assert.equal(exitCodeOf(judgement), 0);
	});

	it("rejects send errors, even a single one", () => {
		const run = withOutcome(goodRun(), "send_error", 1);

		assert.deepEqual(failedCriteria(run), ["noSendErrors"]);
	});

	it("rejects timeouts", () => {
		const run = withOutcome(goodRun(), "timeout", 3);

		assert.deepEqual(failedCriteria(run), ["noTimeouts"]);
	});

	it("rejects sends still unanswered at the end", () => {
		const run = withOutcome(goodRun(), "pending", 1);

		assert.deepEqual(failedCriteria(run), ["noUnfinishedSends"]);
	});

	it("keeps unanswered sends in the latency distribution, as infinitely slow", () => {
		const run = withOutcome(goodRun(), "timeout", 60);
		const { latency } = judgeLoadRun(run);

		assert.equal(latency.count, 1000);
		assert.equal(latency.replied, 940);
		assert.equal(latency.p95Ms, Infinity);
		assert.ok(failedCriteria(run).includes("p95UnderOneSecond"));
	});

	it("rejects unexpected disconnects, late replies and duplicate replies", () => {
		assert.deepEqual(failedCriteria({ ...goodRun(), unexpectedDisconnects: 2 }), ["noUnexpectedDisconnects"]);
		assert.deepEqual(failedCriteria({ ...goodRun(), lateReplies: 1 }), ["noLateReplies"]);
		assert.deepEqual(failedCriteria({ ...goodRun(), unexpectedReplies: 1 }), ["noUnexpectedReplies"]);
	});

	it("rejects cross-visitor data", () => {
		assert.deepEqual(failedCriteria({ ...goodRun(), crossVisitorEvents: 1 }), ["noCrossVisitorData"]);
	});

	it("rejects a send count that does not match the sends recorded, and an empty run", () => {
		assert.deepEqual(failedCriteria({ ...goodRun(), reportedSent: 1001 }), ["everyMeasuredSendAccountedFor"]);
		assert.ok(failedCriteria({ ...goodRun(), sends: [], reportedSent: 0 }).includes("everyMeasuredSendAccountedFor"));
	});

	it("rejects a slow run", () => {
		const run = goodRun();
		const slow = { ...run, sends: run.sends.map(send => ({ ...send, latencyMs: 1500 })) };

		assert.deepEqual(failedCriteria(slow), ["p95UnderOneSecond"]);
	});

	it("rejects growing memory", () => {
		const run = goodRun();
		const growing = {
			...run,
			samples: run.samples.map((sample, index) => {
				return {
					at: sample.at,
					memory: { heapUsed: 100 * MIB + index * MIB, rss: 340 * MIB + index * 4 * MIB },
				};
			}),
		};

		assert.deepEqual(failedCriteria(growing), ["heapSlopeUnder2MiBPerMinute", "rssLastWithin125PercentOfFirst"]);
	});

	for (const key of CLEAN_AFTER_LEAVE_KEYS) {
		it(`rejects ${key} left behind after the visitors leave`, () => {
			const run = goodRun();

			assert.deepEqual(failedCriteria({ ...run, afterLeave: [{ ...CLEAN, [key]: 1 }] }), ["cleanAfterLeave"]);
		});
	}

	it("rejects event listeners left above the baseline, and a run with no sample after leaving", () => {
		assert.deepEqual(failedCriteria({ ...goodRun(), afterLeave: [{ ...CLEAN, eventListeners: 2 }] }), [
			"cleanAfterLeave",
		]);
		assert.deepEqual(failedCriteria({ ...goodRun(), afterLeave: [] }), ["cleanAfterLeave"]);
	});

	it("exits 0 for an accepted report and non-zero for a failed one", () => {
		const accepted = cli(goodRun());

		assert.equal(accepted.status, 0, accepted.output);
		assert.match(accepted.output, /^ACCEPTED$/m);

		const failed = cli({ ...withOutcome(goodRun(), "send_error", 2), unexpectedDisconnects: 1 });

		assert.equal(failed.status, 1, failed.output);
		assert.match(failed.output, /NOT ACCEPTED/);
	});
});
