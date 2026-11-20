// Milestone M7 load test (architecture AC-18): many simulated visitors on a public instance,
// each with a real session, a live socket and a steady stream of messages that the echo app
// answers. Every message carries a unique marker; the reply has to reach the visitor that sent it,
// on that visitor's socket, and nothing of any other visitor may ever arrive there.
//
//   node e2e/m7-load.mjs
//
// Environment, required (e2e/targets.mjs): LOAD_CONSOLE_URL (with an explicit port) and
// LOAD_CONTAINER (sampled with `docker stats` and `docker inspect`). Optional:
//   LOAD_ADMIN_TOKEN    m7-admin-token-0123456789
//   LOAD_VISITORS       200     visitors, all live at once
//   LOAD_WARMUP_S       60      seconds of traffic before measuring (not counted)
//   LOAD_MEASURE_S      600     seconds measured
//   LOAD_INTERVAL_MS    5000    each visitor sends one message per interval (phases spread evenly)
//   LOAD_TIMEOUT_MS     10000   a reply later than this is a timeout
//   LOAD_SAMPLE_S       10      resource sampling period
//   LOAD_OUTPUT         e2e/results/m7-load.json   the full report
//
// All visitors come from this one machine, so the instance needs test-specific quotas that admit
// them from one address (see docs/deployment.md, "Load testing"): MOCKWA_PUBLIC_SESSIONS_PER_IP
// and MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE at least LOAD_VISITORS, and
// MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE above LOAD_VISITORS × 60000 / LOAD_INTERVAL_MS.
//
// Acceptance (decided before the run, printed with the result; judged by e2e/load-verdict.mjs):
//   - every measured send is accounted for, and every one got its reply: no send error, no
//     timeout, nothing still unanswered at the end, no late, duplicate or unexpected reply, no
//     socket closed under a visitor;
//   - no cross-visitor data or event, ever;
//   - send-to-phone latency p95 < 1000 ms over every measured send (an unanswered one counts
//     as infinitely slow, so failures cannot drop out of the distribution);
//   - memory stable over the measured interval: the least-squares slope of the heap is below
//     2 MiB/min, and the mean RSS of the last 2 minutes is at most 1.25 × that of the first 2;
//   - after every visitor leaves: no session, identity, upload, socket (open or opening),
//     session lock, rate-limit key, pending retry, webhook delivery or Graph request row is
//     left, and the event listeners are back to the baseline, within 3 minutes.
// Exits non-zero when any of them fails.

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { WebSocket } from "ws";
import { exitCodeOf, isClean, judgeLoadRun, percentile } from "./load-verdict.mjs";
import { requireTargets } from "./targets.mjs";

const { LOAD_CONSOLE_URL: CONSOLE_URL, LOAD_CONTAINER: CONTAINER } = requireTargets({
	suite: "M7 load test",
	urls: ["LOAD_CONSOLE_URL"],
	names: ["LOAD_CONTAINER"],
});
const ADMIN = { authorization: `Bearer ${process.env.LOAD_ADMIN_TOKEN ?? "m7-admin-token-0123456789"}` };
const VISITORS = Number(process.env.LOAD_VISITORS ?? "200");
const WARMUP_MS = Number(process.env.LOAD_WARMUP_S ?? "60") * 1000;
const MEASURE_MS = Number(process.env.LOAD_MEASURE_S ?? "600") * 1000;
const INTERVAL_MS = Number(process.env.LOAD_INTERVAL_MS ?? "5000");
const TIMEOUT_MS = Number(process.env.LOAD_TIMEOUT_MS ?? "10000");
const SAMPLE_MS = Number(process.env.LOAD_SAMPLE_S ?? "10") * 1000;
const OUTPUT = process.env.LOAD_OUTPUT ?? "e2e/results/m7-load.json";
const RUN_ID = Date.now().toString(36);

const MIB = 1024 * 1024;

// --- helpers ------------------------------------------------------------------------------------

async function sleep(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

async function admin(path) {
	const response = await fetch(`${CONSOLE_URL}${path}`, { headers: ADMIN });

	assert.equal(response.status, 200, `${path}: ${String(response.status)}`);

	return response.json();
}

/** `docker stats` once: CPU in percent of one core, memory in bytes. */
/**
 * Asynchronous on purpose: `docker stats --no-stream` takes a second or two, and a synchronous
 * call would freeze this client's event loop, stamping every reply that lands meanwhile as late.
 */
async function dockerStats() {
	const line = await new Promise((resolve, reject) => {
		execFile("docker", ["stats", "--no-stream", "--format", "{{json .}}", CONTAINER], (error, stdout) => {
			if (error) {
				reject(error);
			} else {
				resolve(stdout);
			}
		});
	});
	const stats = JSON.parse(line);
	const toBytes = text => {
		const match = /^([\d.]+)\s*([KMGT]?i?B)$/.exec(text.trim());
		const scale = { B: 1, KiB: 1024, MiB: MIB, GiB: 1024 * MIB, KB: 1000, MB: 1e6, GB: 1e9 };

		return match === null ? NaN : Number(match[1]) * (scale[match[2]] ?? 1);
	};

	return {
		cpuPercent: Number(stats.CPUPerc.replace("%", "")),
		memBytes: toBytes(stats.MemUsage.split("/", 1)[0]),
		memLimitBytes: toBytes(stats.MemUsage.split("/", 2)[1]),
	};
}

/** The instance's own figures: sessions, sockets, logs and memory. */
async function instanceStats() {
	const body = await admin("/api/public/stats");

	return body.data;
}

// --- the visitors -------------------------------------------------------------------------------

const phoneNumbers = await admin("/api/phone-numbers");
const PHONE_NUMBER_ID = phoneNumbers.data[0].id;

const totals = {
	/** Measured sends, counted where they are made (checked against `sends`). */
	sent: 0,
	sendErrorStatuses: {},
	lateReplies: 0,
	unexpectedReplies: 0,
	unexpectedDisconnects: 0,
	crossVisitorEvents: 0,
};
/** One record per send of the measured interval: `{ outcome, latencyMs }`, see load-verdict.mjs. */
const sends = [];
const crossVisitorSamples = [];
let phase = "warmup";

class LoadVisitor {
	constructor(index) {
		this.index = index;
		this.cookie = "";
		this.session = null;
		this.waId = "";
		this.allWaIds = new Set();
		this.ws = null;
		this.pending = new Map();
		/** Markers whose send timed out, so a reply that still comes is told apart from a duplicate. */
		this.timedOut = new Set();
		this.sequence = 0;
		this.isLeaving = false;
	}

	marker(sequence) {
		return `lt-${RUN_ID}-${String(this.index)}-${String(sequence)}`;
	}

	async start() {
		for (let attempt = 0; ; attempt += 1) {
			const response = await fetch(`${CONSOLE_URL}/api/public/session`, {
				method: "POST",
				headers: { origin: CONSOLE_URL },
			});

			if (response.status === 201) {
				this.cookie = response.headers
					.getSetCookie()
					.find(header => header.startsWith("mockwa_visitor="))
					.split(";", 1)[0];

				const body = await response.json();

				this.session = body.data;
				this.waId = body.data.identities[0].waId;
				this.allWaIds = new Set(body.data.identities.map(identity => identity.waId));

				return;
			}

			assert.ok(
				attempt < 5,
				`visitor ${String(this.index)} could not start: ${String(response.status)} ${await response.text()}`,
			);
			await sleep(1000);
		}
	}

	async connect() {
		const url = `${CONSOLE_URL.replace(/^http/, "ws")}/api/phone/identities/${this.waId}/ws`;

		this.ws = new WebSocket(url, { headers: { origin: CONSOLE_URL, cookie: this.cookie } });
		this.ws.on("message", data => this.receive(JSON.parse(String(data))));
		this.ws.on("close", code => {
			if (this.isLeaving) {
				return;
			}

			totals.unexpectedDisconnects += 1;
			console.log(`visitor ${String(this.index)}: socket closed unexpectedly (${String(code)})`);
		});
		this.ws.on("error", () => {});
		await new Promise((resolve, reject) => {
			this.ws.once("open", resolve);
			this.ws.once("unexpected-response", (_request, response) =>
				reject(new Error(`socket refused: ${String(response.statusCode)}`)),
			);
		});
	}

	receive(event) {
		const text = JSON.stringify(event);
		const message = event.payload?.message;

		// Ownership: an event names this visitor's number, and only markers this visitor sent.
		const markers = text.match(new RegExp(String.raw`lt-${RUN_ID}-(\d+)-\d+`, "g")) ?? [];
		const foreignMarker = markers.find(marker => !marker.startsWith(`lt-${RUN_ID}-${String(this.index)}-`));
		const isForeignNumber = message !== undefined && !this.allWaIds.has(message.contactWaId);

		if (foreignMarker !== undefined || isForeignNumber) {
			totals.crossVisitorEvents += 1;
			crossVisitorSamples.push({ visitor: this.index, event: text.slice(0, 500) });

			return;
		}

		if (event.type !== "message.created" || message.direction !== "outbound") {
			return;
		}

		const body = message.payload?.text?.body ?? "";
		const match = /^echo: (lt-\S+)$/.exec(body);

		if (match === null) {
			return;
		}

		const sent = this.pending.get(match[1]);

		if (sent === undefined) {
			if (this.timedOut.delete(match[1])) {
				totals.lateReplies += 1;
			} else {
				// A second copy, or a reply to something this visitor never sent.
				totals.unexpectedReplies += 1;
			}

			return;
		}

		this.pending.delete(match[1]);

		if (sent.record !== null) {
			sent.record.outcome = "replied";
			sent.record.latencyMs = performance.now() - sent.at;
		}
	}

	async send() {
		const sequence = this.sequence;

		this.sequence += 1;

		const marker = this.marker(sequence);
		const sentAt = performance.now();
		const record = phase === "measure" ? { outcome: "pending", latencyMs: null } : null;

		if (record !== null) {
			sends.push(record);
			totals.sent += 1;
		}

		this.pending.set(marker, { at: sentAt, record });

		const timer = setTimeout(() => {
			if (!this.pending.delete(marker)) {
				return;
			}

			this.timedOut.add(marker);

			if (record !== null) {
				record.outcome = "timeout";
			}
		}, TIMEOUT_MS);

		timer.unref();

		let status;

		try {
			status = await this.post(marker);
		} catch (error) {
			status = "network";
			console.log(`visitor ${String(this.index)}: send failed: ${String(error.message)}`);
		}

		if (status !== 201) {
			this.pending.delete(marker);
			totals.sendErrorStatuses[status] = (totals.sendErrorStatuses[status] ?? 0) + 1;

			if (record !== null) {
				record.outcome = "send_error";
			}
		}
	}

	/** Sends one marker as the visitor's text; the response status. */
	async post(marker) {
		const response = await fetch(`${CONSOLE_URL}/api/phone/identities/${this.waId}/chats/${PHONE_NUMBER_ID}/messages`, {
			method: "POST",
			headers: {
				origin: CONSOLE_URL,
				cookie: this.cookie,
				"x-csrf-token": this.session.csrfToken,
				"content-type": "application/json",
			},
			body: JSON.stringify({ type: "text", text: { body: marker } }),
		});

		await response.arrayBuffer();

		return response.status;
	}

	async leave() {
		this.isLeaving = true;
		this.ws?.close();
		await fetch(`${CONSOLE_URL}/api/public/session`, {
			method: "DELETE",
			headers: { origin: CONSOLE_URL, cookie: this.cookie, "x-csrf-token": this.session.csrfToken },
		});
	}
}

// --- the run ------------------------------------------------------------------------------------

const limits = JSON.parse(
	execFileSync("docker", ["inspect", "--format", "{{json .HostConfig}}", CONTAINER], { encoding: "utf8" }),
);
const environment = JSON.parse(
	execFileSync("docker", ["inspect", "--format", "{{json .Config.Env}}", CONTAINER], { encoding: "utf8" }),
).filter(
	entry => entry.startsWith("MOCKWA_PUBLIC_") || entry.startsWith("MOCKWA_MODE") || entry.startsWith("MOCKWA_STATUS"),
);
const configuration = {
	visitors: VISITORS,
	warmupSeconds: WARMUP_MS / 1000,
	measureSeconds: MEASURE_MS / 1000,
	intervalMs: INTERVAL_MS,
	targetMessagesPerSecond: (VISITORS * 1000) / INTERVAL_MS,
	timeoutMs: TIMEOUT_MS,
	nanoCpus: limits.NanoCpus,
	cpus: limits.NanoCpus / 1e9,
	memoryLimitBytes: limits.Memory,
	instanceEnvironment: environment,
};

console.log(`configuration: ${JSON.stringify(configuration)}`);
assert.ok(limits.NanoCpus > 0, "the container must run with a CPU limit (docker run --cpus)");

const baseline = await instanceStats();

console.log(`baseline: ${JSON.stringify(baseline)}`);

const visitors = Array.from({ length: VISITORS }, (_, index) => new LoadVisitor(index));
const startupStartedAt = performance.now();

for (let batch = 0; batch < VISITORS; batch += 20) {
	await Promise.all(visitors.slice(batch, batch + 20).map(async visitor => visitor.start()));
}

await Promise.all(visitors.map(async visitor => visitor.connect()));

const startupMs = performance.now() - startupStartedAt;

console.log(`${String(VISITORS)} visitors started and connected in ${String(Math.round(startupMs))} ms`);

const samples = [];
const runStartedAt = performance.now();
let isRunning = true;

const sampler = (async () => {
	while (isRunning) {
		const at = performance.now() - runStartedAt;
		const docker = await dockerStats();
		const instance = await instanceStats();

		samples.push({ at, phase, ...docker, ...instance });
		await sleep(SAMPLE_MS);
	}
})();

const senders = visitors.map(async visitor => {
	await sleep((visitor.index * INTERVAL_MS) / VISITORS);

	while (isRunning) {
		const tickAt = performance.now();

		void visitor.send();

		await sleep(Math.max(0, INTERVAL_MS - (performance.now() - tickAt)));
	}
});

await sleep(WARMUP_MS);
phase = "measure";

const measureStartedAt = performance.now();

console.log("warm-up done; measuring");

for (let elapsed = 0; elapsed < MEASURE_MS; elapsed += 60_000) {
	await sleep(Math.min(60_000, MEASURE_MS - elapsed));

	const settledSends = sends.filter(send => send.outcome !== "pending");
	const sorted = settledSends
		.map(send => (send.outcome === "replied" ? send.latencyMs : Infinity))
		.toSorted((a, b) => a - b);
	const elapsedSeconds = Math.round((performance.now() - measureStartedAt) / 1000);
	const p50 = Math.round(percentile(sorted, 50) ?? 0);
	const p95 = Math.round(percentile(sorted, 95) ?? 0);
	const count = outcome => sends.filter(send => send.outcome === outcome).length;

	console.log(
		`t+${String(elapsedSeconds)}s sent=${String(sends.length)} replied=${String(count("replied"))} ` +
			`p50=${String(p50)} p95=${String(p95)} errors=${String(count("send_error"))} ` +
			`timeouts=${String(count("timeout"))} cross=${String(totals.crossVisitorEvents)}`,
	);
}

const measuredMs = performance.now() - measureStartedAt;

phase = "drain";
isRunning = false;
await Promise.all(senders);
// Replies to the last measured sends may still be on their way.
await sleep(TIMEOUT_MS + 1000);

for (const visitor of visitors) {
	await visitor.leave();
}

await sampler;

// After everyone left: within 3 minutes (well over one cleanup period), everything that
// followed the visitors is gone.
const afterLeave = [];

for (let wait = 0; wait < 18; wait += 1) {
	await sleep(10_000);

	const instance = await instanceStats();

	afterLeave.push({ at: (wait + 1) * 10, ...(await dockerStats()), ...instance });

	if (wait >= 1 && isClean(instance, baseline)) {
		break;
	}
}

// --- the verdict --------------------------------------------------------------------------------

const measuredSamples = samples.filter(sample => sample.phase === "measure");
const run = {
	sends,
	reportedSent: totals.sent,
	lateReplies: totals.lateReplies,
	unexpectedReplies: totals.unexpectedReplies,
	unexpectedDisconnects: totals.unexpectedDisconnects,
	crossVisitorEvents: totals.crossVisitorEvents,
	samples: measuredSamples,
	sampleMs: SAMPLE_MS,
	baseline,
	afterLeave,
};
const judgement = judgeLoadRun(run);
const report = {
	configuration,
	startupMs,
	measuredSeconds: measuredMs / 1000,
	achievedMessagesPerSecond: sends.length / (measuredMs / 1000),
	totals,
	outcomes: judgement.outcomes,
	latency: judgement.latency,
	memory: judgement.memory,
	cpu: {
		meanPercentMeasured:
			measuredSamples.reduce((total, sample) => total + sample.cpuPercent, 0) / measuredSamples.length,
		maxPercentMeasured: Math.max(...measuredSamples.map(sample => sample.cpuPercent)),
	},
	settled: judgement.settled,
	crossVisitorSamples: crossVisitorSamples.slice(0, 20),
	verdict: judgement.verdict,
	// Every sample, warm-up included, for the charts.
	samples,
	// Everything the verdict was computed from: `node e2e/load-verdict.mjs <this file>` re-judges it.
	run,
};

mkdirSync(nodePath.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(report, null, 2));

const { outcomes, latency, memory, cpu, settled, verdict } = report;

console.log(JSON.stringify({ totals, outcomes, latency, memory, cpu, settled, verdict }, null, 2));
console.log(`report: ${OUTPUT}`);
console.log(judgement.isAccepted ? "ACCEPTED" : "NOT ACCEPTED");
process.exitCode = exitCodeOf(judgement);
