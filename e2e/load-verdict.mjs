// The verdict of the M7 load test (e2e/m7-load.mjs), kept apart so it can be tested without a
// running instance, and re-judged from a saved report:
//
//   node e2e/load-verdict.mjs e2e/results/m7-load.json
//
// Prints the verdict and exits non-zero unless every criterion holds. The criteria are fixed
// before a run; they are listed in m7-load.mjs's header and below.

import { readFileSync } from "node:fs";

const MIB = 1024 * 1024;

/** The outcomes a measured send can end in; only `replied` counts as a success. */
export const SEND_OUTCOMES = ["replied", "send_error", "timeout", "pending"];

/** What must be back to zero once every visitor has left. */
export const CLEAN_AFTER_LEAVE_KEYS = [
	"sessions",
	"identities",
	"uploads",
	"sockets",
	"socketsOpening",
	"sessionLocks",
	"rateLimitKeys",
	"pendingRetries",
	"webhookDeliveries",
	"graphRequests",
];

export function percentile(sorted, p) {
	if (sorted.length === 0) {
		return null;
	}

	return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function mean(values) {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** Least-squares slope of `values` against `times` (ms), per minute. */
export function slopePerMinute(times, values) {
	const n = times.length;

	if (n < 2) {
		return 0;
	}

	const meanT = mean(times);
	const meanV = mean(values);
	let numerator = 0;
	let denominator = 0;

	for (let index = 0; index < n; index += 1) {
		numerator += (times[index] - meanT) * (values[index] - meanV);
		denominator += (times[index] - meanT) ** 2;
	}

	return denominator === 0 ? 0 : (numerator / denominator) * 60_000;
}

function countOutcomes(sends) {
	const counts = Object.fromEntries(SEND_OUTCOMES.map(outcome => [outcome, 0]));

	for (const send of sends) {
		counts[send.outcome] = (counts[send.outcome] ?? 0) + 1;
	}

	return counts;
}

/**
 * Every measured send is in the distribution: one that never got its reply (an error, a
 * timeout, still pending) counts as infinitely slow, so failures push the percentiles up
 * instead of quietly leaving the sample.
 */
function latencyOf(sends) {
	const all = sends.map(send => (send.outcome === "replied" ? send.latencyMs : Infinity)).toSorted((a, b) => a - b);
	const replied = all.filter(value => Number.isFinite(value));

	return {
		count: all.length,
		replied: replied.length,
		minMs: all[0] ?? null,
		p50Ms: percentile(all, 50),
		p90Ms: percentile(all, 90),
		p95Ms: percentile(all, 95),
		p99Ms: percentile(all, 99),
		maxMs: all.at(-1) ?? null,
		meanRepliedMs: mean(replied),
	};
}

function memoryOf(samples, sampleMs) {
	const times = samples.map(sample => sample.at);
	const heap = samples.map(sample => sample.memory.heapUsed);
	const rss = samples.map(sample => sample.memory.rss);
	const window = Math.max(1, Math.round(120_000 / sampleMs));

	return {
		samples: samples.length,
		heapSlopeMiBPerMinute: slopePerMinute(times, heap) / MIB,
		rssFirstTwoMinutesMiB: mean(rss.slice(0, window)) / MIB,
		rssLastTwoMinutesMiB: mean(rss.slice(-window)) / MIB,
		heapFirstTwoMinutesMiB: mean(heap.slice(0, window)) / MIB,
		heapLastTwoMinutesMiB: mean(heap.slice(-window)) / MIB,
	};
}

/** Whether a stats sample shows nothing left of the visitors. */
export function isClean(stats, baseline) {
	if (stats === undefined || stats === null) {
		return false;
	}

	const isEmpty = CLEAN_AFTER_LEAVE_KEYS.every(key => stats[key] === 0);
	const isListenersBack = baseline === undefined || stats.eventListeners <= baseline.eventListeners;

	return isEmpty && isListenersBack;
}

/**
 * Judges one run. `run` is what m7-load.mjs records:
 *   sends                  every send of the measured interval: { outcome, latencyMs }
 *   reportedSent           how many measured sends the client counted (must match `sends`)
 *   lateReplies            replies that arrived after their send had timed out
 *   unexpectedReplies      replies to no send this visitor is waiting for (duplicates)
 *   unexpectedDisconnects  sockets the instance closed while the visitor was still there
 *   crossVisitorEvents     events carrying another visitor's number or marker
 *   samples                the measured interval's resource samples (`at`, `memory`)
 *   sampleMs               their period
 *   baseline               the instance stats before any visitor arrived
 *   afterLeave             stats samples after every visitor left; the last one is judged
 */
export function judgeLoadRun(run) {
	const sends = run.sends ?? [];
	const outcomes = countOutcomes(sends);
	const latency = latencyOf(sends);
	const memory = memoryOf(run.samples ?? [], run.sampleMs);
	const settled = run.afterLeave?.at(-1);
	const isAccounted =
		sends.length > 0 &&
		sends.length === run.reportedSent &&
		SEND_OUTCOMES.reduce((total, outcome) => total + outcomes[outcome], 0) === sends.length;

	const verdict = {
		everyMeasuredSendAccountedFor: isAccounted,
		noSendErrors: outcomes.send_error === 0,
		noTimeouts: outcomes.timeout === 0,
		noUnfinishedSends: outcomes.pending === 0,
		noLateReplies: run.lateReplies === 0,
		noUnexpectedReplies: run.unexpectedReplies === 0,
		noUnexpectedDisconnects: run.unexpectedDisconnects === 0,
		noCrossVisitorData: run.crossVisitorEvents === 0,
		p95UnderOneSecond: latency.p95Ms !== null && latency.p95Ms < 1000,
		heapSlopeUnder2MiBPerMinute: memory.samples >= 2 && memory.heapSlopeMiBPerMinute < 2,
		rssLastWithin125PercentOfFirst:
			memory.samples >= 2 && memory.rssLastTwoMinutesMiB <= memory.rssFirstTwoMinutesMiB * 1.25,
		cleanAfterLeave: isClean(settled, run.baseline),
	};

	return {
		outcomes,
		latency,
		memory,
		settled: settled ?? null,
		verdict,
		isAccepted: Object.values(verdict).every(Boolean),
	};
}

/** The exit status a verdict gives the process. */
export function exitCodeOf(judgement) {
	return judgement.isAccepted ? 0 : 1;
}

// Run as a script: re-judge a saved report.
if (process.argv[1] === import.meta.filename) {
	const [file] = process.argv.slice(2);

	if (file === undefined) {
		console.error("usage: node e2e/load-verdict.mjs <report.json>");
		process.exit(2);
	}

	const report = JSON.parse(readFileSync(file, "utf8"));
	const judgement = judgeLoadRun(report.run);

	console.log(
		JSON.stringify({ outcomes: judgement.outcomes, latency: judgement.latency, verdict: judgement.verdict }, null, 2),
	);
	console.log(judgement.isAccepted ? "ACCEPTED" : "NOT ACCEPTED");
	process.exitCode = exitCodeOf(judgement);
}
