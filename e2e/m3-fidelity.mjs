// Milestone M3 acceptance checks (API fidelity) against a running mockwa — normally the built
// Docker image — and the example echo app playing the app under test. Dependency-free apart
// from the `docker` CLI, which the restart check uses:
//
//   node e2e/m3-fidelity.mjs
//
// The instance runs the default seed with Meta's default 24-hour window, a file database on a
// volume, and the opt-in limits set low enough to reach: MOCKWA_THROUGHPUT=5,
// MOCKWA_PAIR_RATE_LIMIT=1m/2 and MOCKWA_MESSAGING_LIMIT=2. The echo app answers every inbound
// message through the Graph API, so its replies are free-form sends that the window judges. The
// 24-hour boundary is reached with caller-supplied inbound timestamps, not by waiting a day; the
// exact instant is pinned by the server's unit tests. See .github/workflows/docker.yml.
//
// Environment, required (e2e/targets.mjs): M3_GRAPH_URL, M3_CONSOLE_URL and M3_ECHO_URL, each
// with an explicit port, and M3_CONTAINER (the container the restart check stops and starts).
// Optional: M3_APP_SECRET (m3-app-secret). Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { requireTargets } from "./targets.mjs";

const {
	M3_GRAPH_URL: GRAPH_URL,
	M3_CONSOLE_URL: CONSOLE_URL,
	M3_ECHO_URL: ECHO_URL,
	M3_CONTAINER: CONTAINER,
} = requireTargets({
	suite: "M3 fidelity",
	urls: ["M3_GRAPH_URL", "M3_CONSOLE_URL", "M3_ECHO_URL"],
	names: ["M3_CONTAINER"],
});
const APP_SECRET = process.env.M3_APP_SECRET ?? "m3-app-secret";
const AUTH = { authorization: "Bearer m3-checks" };
const DAY_MS = 86_400_000;

/** Contacts nobody seeded: each check gets its own, so no window leaks from one to the next. */
const OPEN = "5511900003001";
const CLOSED = "5511900003002";
const NEAR_BOUNDARY = "5511900003003";
const NEVER_WROTE = "5511900003004";
const PAIR = "5511900003005";
const OVER_LIMIT = "5511900003006";
const INJECTED = ["5511900003007", "5511900003008"];
/** The pair rate limit is per contact, so a burst meant for throughput goes to many contacts. */
const crowd = index => `55119000031${String(index).padStart(2, "0")}`;

const STATUS_FAILED_FIXTURE = JSON.parse(
	readFileSync(new URL("../docs/fixtures/webhooks/status-failed.json", import.meta.url), "utf8"),
);

const results = [];
const context = { phoneNumberId: "" };

async function check(name, run) {
	const startedAt = performance.now();

	try {
		await run();
	} catch (error) {
		const message = String(error?.message ?? error);

		results.push({ name, passed: false });
		console.log(`FAIL  ${name}\n      ${message.replaceAll("\n", "\n      ")}`);

		return;
	}

	const elapsedMs = Math.round(performance.now() - startedAt);

	results.push({ name, passed: true });
	console.log(`PASS  ${name} (${String(elapsedMs)} ms)`);
}

async function getJson(url, init) {
	const response = await fetch(url, init);
	const text = await response.text();

	return { status: response.status, headers: response.headers, body: text === "" ? null : JSON.parse(text) };
}

function jsonInit(method, body, headers = {}) {
	return {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body !== undefined && { body: JSON.stringify(body) }),
	};
}

async function waitFor(description, probe, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		let result;

		try {
			result = await probe();
		} catch {
			// Not there yet.
		}

		if (result !== false && result !== null && result !== undefined) {
			return result;
		}

		if (Date.now() > deadline) {
			throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${description}`);
		}

		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Recomputed here, independently of both mockwa and the echo app. */
function signatureFor(rawBody) {
	return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

/** The keys of every object, recursively — what "structurally the same as Meta's" compares. */
function shapeOf(value) {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}

	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).toSorted((a, b) => a.localeCompare(b));

		return Object.fromEntries(keys.map(key => [key, shapeOf(value[key])]));
	}

	return typeof value;
}

function send(body) {
	return getJson(
		`${GRAPH_URL}/v25.0/${context.phoneNumberId}/messages`,
		jsonInit("POST", { messaging_product: "whatsapp", ...body }, AUTH),
	);
}

function sendText(to, text) {
	return send({ to, type: "text", text: { body: text } });
}

function sendTemplate(to) {
	return send({ to, type: "template", template: { name: "hello_whaloc", language: { code: "en" } } });
}

async function inbound(from, text, timestamp) {
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/inbound`,
		jsonInit("POST", {
			phoneNumberId: context.phoneNumberId,
			from,
			type: "text",
			text: { body: text },
			...(timestamp !== undefined && { timestamp }),
		}),
	);

	assert.equal(status, 201, JSON.stringify(body));
}

async function deliveries() {
	const { body } = await getJson(`${ECHO_URL}/deliveries`);

	return body.deliveries;
}

/** The echo app's reply to the inbound message carrying `text`: its HTTP status and wamid. */
async function echoReplyTo(text) {
	return waitFor(`the echo app's reply to "${text}"`, async () => {
		const all = await deliveries();
		const delivery = all.find(candidate => candidate.rawBody.includes(text) && candidate.reply !== null);

		return delivery?.reply ?? false;
	});
}

/** Every status webhook the echo app received for one wamid, in arrival order. */
async function statusesFor(wamid) {
	const all = await deliveries();

	return all.flatMap(delivery => {
		const statuses = (delivery.body?.entry ?? [])
			.flatMap(entry => entry.changes ?? [])
			.flatMap(change => change.value?.statuses ?? []);

		return statuses.filter(status => status.id === wamid).map(status => ({ status, delivery }));
	});
}

function waitForStatus(wamid, name) {
	return waitFor(`a "${name}" status for ${wamid}`, async () => {
		const found = await statusesFor(wamid);

		return found.find(entry => entry.status.status === name) ?? false;
	});
}

async function serviceWindow(waId) {
	const { body } = await getJson(
		`${CONSOLE_URL}/api/service-window?phoneNumberId=${context.phoneNumberId}&waId=${waId}`,
	);

	return body.data;
}

async function isWindowOpen(waId) {
	const window = await serviceWindow(waId);

	return window.isOpen;
}

async function statusNames(wamid) {
	const statuses = await statusesFor(wamid);

	return statuses.map(entry => entry.status.status);
}

async function httpStatusOf(request) {
	const response = await request;

	return response.status;
}

function isoAgo(ms) {
	const then = new Date(Date.now() - ms);

	return then.toISOString();
}

function dockerRun(...args) {
	return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

// --- Setup ----------------------------------------------------------------------------------

await check("setup: the seeded phone number, a clean slate and the configured rules", async () => {
	const { body: state } = await getJson(`${CONSOLE_URL}/api/state`);

	context.phoneNumberId = state.wabas[0].phoneNumbers[0].id;
	assert.ok(context.phoneNumberId, "no seeded phone number");
	assert.deepEqual(state.behavior.messaging, {
		serviceWindowMs: DAY_MS,
		throughput: { messagesPerSecond: 5 },
		pairRateLimit: { intervalMs: 60_000, burst: 2 },
		messagingLimit: 2,
	});
	await fetch(`${ECHO_URL}/deliveries`, { method: "DELETE" });
});

// --- The 24-hour customer service window ----------------------------------------------------

await check("window: a reply inside the window is sent and delivered, signed over the exact bytes", async () => {
	await inbound(OPEN, "m3-open hello");

	const reply = await echoReplyTo("m3-open hello");

	assert.equal(reply.status, 200, JSON.stringify(reply.body));

	const wamid = reply.body.messages[0].id;
	const delivered = await waitForStatus(wamid, "delivered");

	assert.equal(delivered.delivery.signatureValid, true);
	assert.equal(delivered.delivery.signature, signatureFor(delivered.delivery.rawBody));
	const names = await statusNames(wamid);

	assert.ok(!names.includes("failed"));
	assert.equal(await isWindowOpen(OPEN), true);
});

await check("window: a reply to a message older than 24 hours is accepted, then fails with 131047", async () => {
	const stale = isoAgo(DAY_MS + 60_000);

	await inbound(CLOSED, "m3-closed hello", stale);

	const reply = await echoReplyTo("m3-closed hello");

	// Accepted like any send: the window is judged after, and reported on the status webhook.
	assert.equal(reply.status, 200, JSON.stringify(reply.body));
	assert.match(reply.body.messages[0].id, /^wamid\./);

	const wamid = reply.body.messages[0].id;
	const failed = await waitForStatus(wamid, "failed");

	assert.equal(failed.delivery.signatureValid, true);
	assert.deepEqual(failed.status.errors, [
		{
			code: 131_047,
			title: "Re-engagement message",
			message: "Re-engagement message",
			error_data: { details: "More than 24 hours have passed since the recipient last replied to the sender number." },
			href: "/documentation/business-messaging/whatsapp/support/error-codes",
		},
	]);
	assert.deepEqual(shapeOf(failed.delivery.body), shapeOf(STATUS_FAILED_FIXTURE), "differs from Meta's failed fixture");
	await sleep(1500);
	assert.deepEqual(await statusNames(wamid), ["failed"], "a failed send must not also be sent or delivered");
	assert.equal(await isWindowOpen(CLOSED), false);
});

await check("window: one minute before the 24 hours run out, the reply still goes through", async () => {
	const nearlyStale = isoAgo(DAY_MS - 60_000);

	await inbound(NEAR_BOUNDARY, "m3-boundary hello", nearlyStale);

	const reply = await echoReplyTo("m3-boundary hello");

	await waitForStatus(reply.body.messages[0].id, "delivered");

	const window = await serviceWindow(NEAR_BOUNDARY);

	assert.equal(window.isOpen, true);
	assert.equal(Date.parse(window.expiresAt) - Date.parse(window.lastInboundAt), DAY_MS);
});

await check("window: an approved template reaches someone who never wrote; free-form text does not", async () => {
	const template = await sendTemplate(NEVER_WROTE);

	assert.equal(template.status, 200, JSON.stringify(template.body));
	await waitForStatus(template.body.messages[0].id, "delivered");

	const text = await sendText(NEVER_WROTE, "m3 unsolicited");

	assert.equal(text.status, 200, JSON.stringify(text.body));

	const failed = await waitForStatus(text.body.messages[0].id, "failed");

	assert.equal(failed.status.errors[0].code, 131_047);
});

// --- Throughput, pair rate and messaging limit ----------------------------------------------

await check("throughput: past 5 per second the send is refused with 429 / 130429 and Retry-After", async () => {
	await sleep(1100);

	const responses = await Promise.all(
		Array.from({ length: 12 }, (_, index) => sendText(crowd(index), `m3 throughput ${String(index)}`)),
	);
	const accepted = responses.filter(response => response.status === 200);
	const refused = responses.filter(response => response.status === 429);

	// Twelve sends land in at most two one-second windows, so at most ten get through.
	assert.ok(accepted.length >= 5 && accepted.length <= 10, `accepted ${String(accepted.length)}`);
	assert.equal(accepted.length + refused.length, 12);
	assert.equal(refused[0].headers.get("retry-after"), "1");
	assert.deepEqual(refused[0].body.error.code, 130_429);
	assert.equal(refused[0].body.error.message, "(#130429) Rate limit hit");
	assert.equal(refused[0].body.error.type, "OAuthException");
	assert.ok(refused[0].body.error.fbtrace_id, "every Graph error carries an fbtrace_id");
});

await check("pair rate: a third send to one contact within the minute is refused with 400 / 131056", async () => {
	await sleep(1100);

	assert.equal(await httpStatusOf(sendTemplate(PAIR)), 200);
	assert.equal(await httpStatusOf(sendTemplate(PAIR)), 200);

	const refused = await sendTemplate(PAIR);

	assert.equal(refused.status, 400);
	assert.equal(refused.headers.get("retry-after"), null);
	assert.equal(refused.body.error.code, 131_056);
	assert.equal(refused.body.error.message, "(#131056) (Business Account, Consumer account) pair rate limit hit");
});

await check("messaging limit: a third new user outside the window fails with mockwa's simulated 990001", async () => {
	// NEVER_WROTE and PAIR were the two business-initiated recipients so far.
	const { body: before } = await getJson(`${CONSOLE_URL}/api/messaging-rules`);

	assert.equal(before.data.usage[0].used, 2);

	const over = await sendTemplate(OVER_LIMIT);

	assert.equal(over.status, 200, JSON.stringify(over.body));

	const failed = await waitForStatus(over.body.messages[0].id, "failed");

	assert.equal(failed.status.errors[0].code, 990_001);
	assert.match(failed.status.errors[0].title, /^\[mockwa\] /);
	assert.equal(failed.delivery.signatureValid, true);
});

// --- Deterministic failure injection --------------------------------------------------------

await check("injection: a messages.status rule fails exactly the next reply's status webhook", async () => {
	await sleep(1100);

	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/injection-rules`,
		jsonInit("POST", {
			target: "messages.status",
			preset: "failed_status",
			errorCode: 131_026,
			trigger: { kind: "next", count: 1 },
		}),
	);

	assert.equal(status, 201, JSON.stringify(body));

	await inbound(INJECTED[0], "m3-injected one");

	const first = await echoReplyTo("m3-injected one");
	const failed = await waitForStatus(first.body.messages[0].id, "failed");

	assert.equal(failed.status.errors[0].code, 131_026);

	await inbound(INJECTED[1], "m3-injected two");

	const second = await echoReplyTo("m3-injected two");

	await waitForStatus(second.body.messages[0].id, "delivered");
	await fetch(`${CONSOLE_URL}/api/injection-rules/${body.data.id}`, { method: "DELETE" });
});

await check("injection: a messages.send rule still answers the request itself, with Meta's headers", async () => {
	await sleep(1100);

	const { body } = await getJson(
		`${CONSOLE_URL}/api/injection-rules`,
		jsonInit("POST", { target: "messages.send", preset: "rate_limit_429", trigger: { kind: "next", count: 1 } }),
	);
	const refused = await sendText(crowd(20), "m3 injected 429");

	assert.equal(refused.status, 429);
	assert.equal(refused.body.error.code, 130_429);
	assert.equal(refused.headers.get("retry-after"), "60");
	assert.ok(refused.headers.get("x-business-use-case-usage"), "no X-Business-Use-Case-Usage header");
	const after = await sendText(crowd(21), "m3 after the injected 429");

	assert.equal(after.status, 200);
	await fetch(`${CONSOLE_URL}/api/injection-rules/${body.data.id}`, { method: "DELETE" });
});

// --- Compatibility --------------------------------------------------------------------------

await check("every webhook the echo app received was signed with the app secret", async () => {
	const all = await deliveries();

	assert.ok(all.length > 0);

	for (const delivery of all) {
		assert.equal(delivery.signatureValid, true, `bad signature on ${delivery.rawBody.slice(0, 120)}`);
	}
});

await check("the window lives in the database: it is still open after a container restart", async () => {
	dockerRun("restart", CONTAINER);
	await waitFor(
		"the container to be healthy again",
		() => dockerRun("inspect", "--format", "{{.State.Health.Status}}", CONTAINER) === "healthy",
		90_000,
	);

	assert.equal(await isWindowOpen(OPEN), true);
	assert.equal(await isWindowOpen(CLOSED), false);
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
