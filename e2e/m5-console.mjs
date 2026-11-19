// Milestone M5 acceptance checks (AC-13: console and docs) against a running mockwa — normally
// the built Docker image — and the example echo app playing the app under test. HTTP and
// WebSocket only; the browser half lives in e2e/m5-console.spec.mjs.
//
//   node e2e/m5-console.mjs
//
// The instance runs MOCKWA_CLOCK=virtual from M5_CLOCK_START with the default seed, its webhook
// pointed at the echo app (signed with M5_APP_SECRET). See .github/workflows/docker.yml.
//
// What it proves: every console clock move is announced (`clock.changed`); the customer service
// window is open before its boundary, closed exactly at it and reopened by a message, and
// "Expire now" closes one pair only; the Graph request log records successes and rejections with
// secrets masked and binary never stored as text; webhook attempts keep their exact bytes,
// headers and response, and a redelivery sends the same bytes with a valid signature; the
// scenario API is unchanged; and the seeds shipped for the Workbench and GotUnit guides accept
// exactly the sends those apps make.
//
// Environment, required (e2e/targets.mjs): M5_GRAPH_URL, M5_CONSOLE_URL and M5_ECHO_URL, each
// with an explicit port. Optional: M5_APP_SECRET (m5-app-secret), M5_CLOCK_START
// (2026-07-01T08:00:00.000Z). Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { requireTargets } from "./targets.mjs";

const {
	M5_GRAPH_URL: GRAPH_URL,
	M5_CONSOLE_URL: CONSOLE_URL,
	M5_ECHO_URL: ECHO_URL,
} = requireTargets({ suite: "M5 console and docs", urls: ["M5_GRAPH_URL", "M5_CONSOLE_URL", "M5_ECHO_URL"] });
const APP_SECRET = process.env.M5_APP_SECRET ?? "m5-app-secret";
const START_INSTANT = new Date(process.env.M5_CLOCK_START ?? "2026-07-01T08:00:00.000Z");
const START = START_INSTANT.toISOString();
const TOKEN = "m5-secret-token-0123456789";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const SECOND = 1000;
const HOUR = 3600 * SECOND;
const DAY = 24 * HOUR;
const PHONE_NUMBER_ID = "573542517421694";

/** Contacts nobody seeded, one per check. */
const BOUNDARY = "5511900005001";
const EXPIRED = "5511900005002";
const NEIGHBOUR = "5511900005003";
const LOGGED = "5511900005004";
const RETRIED = "5511900005005";

const results = [];

async function check(name, run) {
	const startedAt = performance.now();

	try {
		await run();
	} catch (error) {
		const message = String(error?.stack ?? error?.message ?? error);

		results.push({ name, passed: false });
		console.log(`FAIL  ${name}\n      ${message.replaceAll("\n", "\n      ")}`);

		return;
	}

	results.push({ name, passed: true });
	const elapsedMs = Math.round(performance.now() - startedAt);

	console.log(`PASS  ${name} (${String(elapsedMs)} ms)`);
}

// --- helpers ------------------------------------------------------------------------------------

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

async function waitFor(description, probe, timeoutMs = 10_000) {
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

		await new Promise(resolve => setTimeout(resolve, 100));
	}
}

function signatureFor(rawBody) {
	return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

async function reset() {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/reset`, jsonInit("POST"));

	assert.equal(status, 200, JSON.stringify(body));
	await fetch(`${ECHO_URL}/fail`, { method: "DELETE" });
	await fetch(`${ECHO_URL}/deliveries`, { method: "DELETE" });
}

async function clock() {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/clock`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function advance(by) {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/clock/advance`, jsonInit("POST", { by }));

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function inbound(from, text) {
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/inbound`,
		jsonInit("POST", { phoneNumberId: PHONE_NUMBER_ID, from, type: "text", text: { body: text } }),
	);

	assert.equal(status, 201, JSON.stringify(body));
}

function send(body, headers = AUTH, phoneNumberId = PHONE_NUMBER_ID, query = "") {
	return getJson(
		`${GRAPH_URL}/v25.0/${phoneNumberId}/messages${query}`,
		jsonInit("POST", { messaging_product: "whatsapp", ...body }, headers),
	);
}

async function window(waId) {
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/service-window?phoneNumberId=${PHONE_NUMBER_ID}&waId=${waId}`,
	);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function requests(query = "") {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/graph-requests?limit=200${query}`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function requestDetail(id) {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/graph-requests/${String(id)}`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function deliveries() {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/webhook-deliveries?limit=200`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function deliveryWith(text) {
	const all = await deliveries();

	return all.find(delivery => delivery.requestBody.includes(text));
}

async function echoDeliveries() {
	const { body } = await getJson(`${ECHO_URL}/deliveries`);

	return body.deliveries;
}

/** A console WebSocket that keeps every frame it sees, until closed. */
async function listen() {
	const url = new URL("/api/ws", CONSOLE_URL);

	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

	const socket = new globalThis.WebSocket(url);
	const events = [];

	socket.addEventListener("message", message => {
		events.push(JSON.parse(String(message.data)));
	});
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});

	return {
		events,
		next: (type, predicate = () => true) =>
			waitFor(`a ${type} event`, () => events.find(event => event.type === type && predicate(event.payload))),
		[Symbol.dispose]: () => {
			socket.close();
		},
	};
}

// --- Clock ----------------------------------------------------------------------------------------

await check(
	"setup: virtual clock at its start after a reset, and the reset is announced as clock.changed",
	async () => {
		using socket = await listen();

		await reset();

		const now = await clock();

		assert.equal(now.mode, "virtual");
		assert.equal(now.now, START);

		const event = await socket.next("clock.changed");

		assert.equal(event.payload.clock.now, START);
	},
);

await check("every clock move through the API is announced with the new time (what the console follows)", async () => {
	using socket = await listen();
	const moved = await advance("90s");
	const event = await socket.next("clock.changed", payload => payload.clock.now === moved.to);

	assert.equal(event.payload.clock.mode, "virtual");
	assert.deepEqual(event.payload.clock, moved.clock);
});

// --- Service window -------------------------------------------------------------------------------

await check("the window is open before its boundary, closed exactly at it, and reopened by a message", async () => {
	await reset();
	await inbound(BOUNDARY, "hello");

	const opened = await window(BOUNDARY);

	assert.equal(opened.isOpen, true);
	assert.equal(opened.lastInboundAt, START);
	const boundary = new Date(START_INSTANT.getTime() + DAY);

	assert.equal(opened.expiresAt, boundary.toISOString());

	await advance(DAY - SECOND);
	const justBefore = await window(BOUNDARY);

	assert.equal(justBefore.isOpen, true, "one second before the boundary");

	await advance(SECOND);

	const closed = await window(BOUNDARY);
	const now = await clock();

	assert.equal(closed.isOpen, false, "at the boundary");
	assert.equal(closed.expiresAt, now.now);

	// The server agrees with what the badge shows: a free-form send now fails with 131047.
	const { status, body } = await send({ to: BOUNDARY, type: "text", text: { body: "too late" } });

	assert.equal(status, 200, JSON.stringify(body));
	await advance("1s");

	const failedStatus = await waitFor("the 131047 failed status", async () => {
		const all = await deliveries();

		return all.find(delivery => delivery.requestBody.includes('"failed"') && delivery.requestBody.includes("131047"));
	});

	assert.ok(failedStatus.requestBody.includes(body.messages[0].id));

	await inbound(BOUNDARY, "back again");

	const reopened = await window(BOUNDARY);

	assert.equal(reopened.isOpen, true);
	const afterReopen = await clock();

	assert.equal(reopened.lastInboundAt, afterReopen.now);
});

await check(
	"Expire now closes one pair at the current time, announces it, and the next message reopens it",
	async () => {
		await reset();
		await inbound(EXPIRED, "hi");
		await inbound(NEIGHBOUR, "hi too");

		using socket = await listen();
		const before = await clock();
		const { status, body } = await getJson(
			`${CONSOLE_URL}/api/service-window/expire`,
			jsonInit("POST", { phoneNumberId: PHONE_NUMBER_ID, waId: EXPIRED }),
		);

		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.data.isOpen, false);
		assert.equal(body.data.expiredManuallyAt, before.now);

		const event = await socket.next("service_window.changed");

		assert.equal(event.payload.serviceWindow.waId, EXPIRED);

		const after = await clock();
		const neighbour = await window(NEIGHBOUR);

		assert.equal(after.now, before.now, "the clock did not move");
		assert.equal(neighbour.isOpen, true, "another contact keeps its window");

		// Frozen clock: the reopening message carries the same instant, and still reopens it.
		await inbound(EXPIRED, "still here");

		const reopened = await window(EXPIRED);

		assert.equal(reopened.isOpen, true);
		assert.equal(reopened.expiredManuallyAt, null);

		const unknown = await getJson(
			`${CONSOLE_URL}/api/service-window/expire`,
			jsonInit("POST", { phoneNumberId: "999999999999999", waId: EXPIRED }),
		);

		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.error.code, "unknown_phone_number");
	},
);

// --- Graph request log ----------------------------------------------------------------------------

await check(
	"the request log records successes, rejections and injected failures, with the app and number",
	async () => {
		await reset();

		const ok = await send({
			to: LOGGED,
			type: "template",
			template: { name: "hello_whaloc", language: { code: "en" } },
		});

		assert.equal(ok.status, 200, JSON.stringify(ok.body));

		const unknownTemplate = await send({
			to: LOGGED,
			type: "template",
			template: { name: "nope", language: { code: "en" } },
		});

		assert.equal(unknownTemplate.status, 400);
		assert.equal(unknownTemplate.body.error.code, 132_001);

		const windowRestricted = await send({ to: LOGGED, type: "text", text: { body: "no window" } });

		assert.equal(windowRestricted.status, 200, "a window failure is a status webhook, not an HTTP error");

		const rule = await getJson(
			`${CONSOLE_URL}/api/injection-rules`,
			jsonInit("POST", { target: "messages.send", trigger: { kind: "next", count: 1 }, preset: "server_error_500" }),
		);

		assert.equal(rule.status, 201, JSON.stringify(rule.body));

		const injected = await send({
			to: LOGGED,
			type: "template",
			template: { name: "hello_whaloc", language: { code: "en" } },
		});

		assert.equal(injected.status, 500);

		const unknownNumber = await send({ to: LOGGED, type: "text", text: { body: "x" } }, AUTH, "111111111111111");

		assert.equal(unknownNumber.status, 400);

		const logged = await requests();
		const messages = logged.filter(entry => entry.path.endsWith("/messages")).toReversed();

		assert.deepEqual(
			messages.map(entry => [entry.status, entry.errorCode]),
			[
				[200, null],
				[400, 132_001],
				[200, null],
				[500, 1],
				[400, 100],
			],
		);

		for (const entry of messages) {
			assert.equal(entry.method, "POST");
			assert.equal(entry.appKey, "default");
			assert.ok(!entry.tokenMasked.includes(TOKEN.slice(0, 10)), entry.tokenMasked);
			assert.ok(entry.tokenMasked.endsWith(TOKEN.slice(-4)), entry.tokenMasked);
			assert.equal(entry.receivedAt, START, "simulator time");
		}

		assert.deepEqual(
			messages.map(entry => entry.phoneNumberId),
			[PHONE_NUMBER_ID, PHONE_NUMBER_ID, PHONE_NUMBER_ID, PHONE_NUMBER_ID, null],
		);

		const detail = await requestDetail(messages[1].id);

		assert.equal(detail.requestBody.kind, "json");
		assert.match(detail.requestBody.text, /"name":\s*"nope"/);
		assert.equal(detail.responseBody.kind, "json");
		assert.match(detail.responseBody.text, /132001/);
		assert.equal(detail.requestHeaders["authorization"], `Bearer ${messages[1].tokenMasked}`);

		const filtered = await requests(`&phoneNumberId=${PHONE_NUMBER_ID}`);

		assert.ok(filtered.every(entry => entry.phoneNumberId === PHONE_NUMBER_ID));
	},
);

await check("the request log masks secrets in the query, headers and JSON, at any depth", async () => {
	await reset();
	await send(
		{ to: LOGGED, type: "text", text: { body: "x" }, extra: { password: "hunter2", nested: [{ api_key: "k-123" }] } },
		{ ...AUTH, "x-api-key": "header-secret", cookie: "session=abc" },
		PHONE_NUMBER_ID,
		"?access_token=query-secret&fields=id",
	);

	const [entry] = await requests();
	const detail = await requestDetail(entry.id);
	const everything = JSON.stringify(detail);

	for (const secret of [TOKEN, "hunter2", "k-123", "header-secret", "session=abc", "query-secret"]) {
		assert.ok(!everything.includes(secret), `${secret} leaked: ${everything.slice(0, 400)}`);
	}

	assert.match(detail.query, /access_token=/);
	assert.match(detail.query, /fields=id/);
});

await check(
	"a malformed JSON body is answered as before but never stored: not in the detail, list or export",
	async () => {
		await reset();

		const secret = "m5-review-dummy-secret";
		const raw = `{"password":"${secret}"`;
		const response = await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}/messages`, {
			method: "POST",
			headers: { ...AUTH, "content-type": "application/json" },
			body: raw,
		});

		assert.equal(response.status, 400);

		const answer = await response.json();
		const [entry] = await requests();
		const detail = await requestDetail(entry.id);
		const exported = await fetch(`${CONSOLE_URL}/api/graph-requests/export`);
		const everything = JSON.stringify([detail, await requests(), await exported.json()]);

		assert.equal(typeof answer.error.code, "number");
		assert.equal(detail.status, 400);
		assert.equal(detail.errorCode, answer.error.code);
		assert.equal(detail.requestBody.kind, "omitted");
		assert.equal(detail.requestBody.contentType, "application/json");
		assert.equal(detail.requestBody.size, Buffer.byteLength(raw));
		assert.match(detail.requestBody.omittedReason, /^malformed JSON/);
		assert.ok(!everything.includes(secret), `the secret leaked: ${everything.slice(0, 400)}`);
	},
);

await check("media uploads are described, never stored: multipart fields, resumable bytes", async () => {
	await reset();

	const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
	const form = new globalThis.FormData();

	form.append("messaging_product", "whatsapp");
	form.append("file", new globalThis.Blob([bytes], { type: "image/png" }), "pixel.png");

	const upload = await getJson(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}/media`, {
		method: "POST",
		headers: AUTH,
		body: form,
	});

	assert.equal(upload.status, 200, JSON.stringify(upload.body));

	const state = await getJson(`${CONSOLE_URL}/api/state`);
	const session = await getJson(
		`${GRAPH_URL}/v25.0/${state.body.app.id}/uploads?file_length=${String(bytes.length)}&file_type=image/png&file_name=pixel.png`,
		{ method: "POST", headers: AUTH },
	);

	assert.equal(session.status, 200, JSON.stringify(session.body));

	const chunk = await getJson(`${GRAPH_URL}/v25.0/${session.body.id}`, {
		method: "POST",
		headers: { ...AUTH, file_offset: "0", "content-type": "application/octet-stream" },
		body: bytes,
	});

	assert.equal(chunk.status, 200, JSON.stringify(chunk.body));

	const logged = await requests();
	const multipart = await requestDetail(logged.find(entry => entry.path.endsWith("/media")).id);
	const binary = await requestDetail(logged.find(entry => entry.path.includes("upload:")).id);

	assert.equal(multipart.requestBody.kind, "multipart");

	const file = multipart.requestBody.fields.find(field => field.name === "file");

	assert.equal(file.file.filename, "pixel.png");
	assert.equal(file.file.contentType, "image/png");
	assert.equal(file.file.size, bytes.length);
	assert.equal(file.value, undefined, "the bytes are not stored");
	assert.equal(binary.requestBody.kind, "binary");
	assert.equal(binary.requestBody.size, bytes.length);
	assert.equal(binary.requestBody.text, undefined);
});

await check("the log is bounded, exported on its own, not part of a state export, and cleared by a reset", async () => {
	await reset();

	const { body: health } = await getJson(`${CONSOLE_URL}/api/graph-requests/export`);
	const limit = health.limit;

	assert.equal(limit, 500);

	for (let index = 0; index < limit + 5; index += 1) {
		await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}`, { headers: AUTH });
	}

	const exported = await fetch(`${CONSOLE_URL}/api/graph-requests/export`);
	const disposition = exported.headers.get("content-disposition") ?? "";
	const file = await exported.json();

	assert.match(disposition, /attachment/);
	assert.equal(file.data.length, limit);

	const snapshot = await getJson(`${CONSOLE_URL}/api/export`);

	assert.ok(!JSON.stringify(snapshot.body).includes("graph_requests"), "not part of a state export");

	await reset();
	assert.deepEqual(await requests(), []);

	await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}`, { headers: AUTH });

	const cleared = await fetch(`${CONSOLE_URL}/api/graph-requests`, { method: "DELETE" });

	assert.equal(cleared.status, 204);
	assert.deepEqual(await requests(), []);
});

await check("the log shows the app's own Graph calls (the echo app's reply)", async () => {
	await reset();
	await inbound(LOGGED, "ping from the phone");

	const reply = await waitFor("the echo app's reply in the request log", async () => {
		const logged = await requests();

		for (const entry of logged) {
			if (!entry.path.endsWith("/messages")) {
				continue;
			}

			const detail = await requestDetail(entry.id);

			if (detail.requestBody.text?.includes("echo: ping from the phone")) {
				return detail;
			}
		}

		return false;
	});

	assert.equal(reply.status, 200);
	assert.equal(reply.phoneNumberId, PHONE_NUMBER_ID);
});

// --- Webhook inspector ----------------------------------------------------------------------------

await check("an attempt keeps the exact bytes, headers, response and outcome the receiver saw", async () => {
	await reset();
	await inbound(LOGGED, "inspect me");

	const received = await waitFor("the echo app's copy", async () => {
		const all = await echoDeliveries();

		return all.find(delivery => delivery.rawBody.includes("inspect me"));
	});
	const stored = await deliveryWith("inspect me");

	assert.equal(stored.requestBody, received.rawBody, "byte for byte");
	assert.equal(stored.requestHeaders["x-hub-signature-256"], received.signature);
	assert.equal(received.signature, signatureFor(received.rawBody));
	assert.equal(received.signatureValid, true, "the receiver verified it (the echo app reports this, mockwa cannot)");
	assert.equal(stored.responseStatus, 200);
	assert.equal(stored.outcome, "delivered");
});

await check("a redelivery sends the stored body again, with a valid signature", async () => {
	const original = await deliveryWith("inspect me");
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/webhook-deliveries/${original.id}/redeliver`,
		jsonInit("POST"),
	);

	assert.equal(status, 201, JSON.stringify(body));

	const copies = await waitFor("the redelivered copy", async () => {
		const received = await echoDeliveries();
		const all = received.filter(delivery => delivery.rawBody.includes("inspect me"));

		return all.length === 2 ? all : false;
	});

	assert.equal(copies[1].rawBody, copies[0].rawBody);
	assert.equal(copies[1].rawBody, original.requestBody);
	assert.equal(copies[1].signature, signatureFor(original.requestBody));
	assert.equal(copies[1].signatureValid, true);
	assert.notEqual(body.data[0].chainId, original.chainId, "a new chain");
});

await check("a failed attempt keeps its status and retry state until the retry lands", async () => {
	await reset();
	await fetch(`${ECHO_URL}/fail`, jsonInit("PUT", { status: 500, count: 1 }));
	await inbound(RETRIED, "retry me");

	const failed = await waitFor("the failed attempt", async () => {
		const all = await deliveries();

		return all.find(delivery => delivery.requestBody.includes("retry me") && delivery.responseStatus === 500);
	});

	assert.equal(failed.outcome, "retrying");
	assert.ok(failed.nextAttemptAt !== null);

	await advance("10s");

	const delivered = await waitFor("the retried attempt", async () => {
		const all = await deliveries();

		return all.find(delivery => {
			return (
				delivery.chainId === failed.chainId &&
				delivery.attempt === failed.attempt + 1 &&
				delivery.outcome === "delivered"
			);
		});
	});

	assert.equal(delivered.requestBody, failed.requestBody);
	assert.equal(delivered.requestHeaders["x-hub-signature-256"], failed.requestHeaders["x-hub-signature-256"]);
});

// --- Scenarios (API and CLI compatibility is M4's; this is what the console view relies on) ------

await check(
	"validate leaves state intact and names what is wrong; a failed run reports expected, observed and skipped",
	async () => {
		await reset();
		await inbound(LOGGED, "keep me");

		const invalid = await getJson(
			`${CONSOLE_URL}/api/scenarios/validate`,
			jsonInit("POST", { name: "bad", steps: [{ send: { as: "Nobody", text: "hi" } }] }),
		);

		assert.equal(invalid.status, 400);
		assert.equal(invalid.body.error.code, "invalid_scenario");
		assert.match(invalid.body.error.message, /Nobody/);
		const kept = await window(LOGGED);

		assert.equal(kept.isOpen, true, "nothing was reset");

		const example = JSON.parse(
			readFileSync(new URL("../examples/scenarios/service-window.json", import.meta.url), "utf8"),
		);
		const valid = await getJson(`${CONSOLE_URL}/api/scenarios/validate`, jsonInit("POST", example));

		assert.equal(valid.status, 200, JSON.stringify(valid.body));

		const unmet = JSON.parse(readFileSync(new URL("fixtures/m4-unmet.json", import.meta.url), "utf8"));
		const run = await getJson(`${CONSOLE_URL}/api/scenarios/run`, jsonInit("POST", unmet));

		assert.equal(run.status, 200, JSON.stringify(run.body));
		assert.equal(run.body.data.passed, false);
		assert.deepEqual(
			run.body.data.steps.map(step => step.status),
			["passed", "failed", "skipped"],
		);
		assert.ok(JSON.stringify(run.body.data.steps[1].failure.expected).includes("Hello, Dina!"));
		assert.ok(JSON.stringify(run.body.data.steps[1].failure.observed).includes("echo: hi"));
	},
);

// --- Integration guides ---------------------------------------------------------------------------

/** Resets into a guide's seed (a scenario world uses the MOCKWA_SEED format) with one idle step. */
async function loadSeed(file) {
	const wabas = JSON.parse(readFileSync(new URL(`../examples/integrations/${file}`, import.meta.url), "utf8"));
	const run = await getJson(
		`${CONSOLE_URL}/api/scenarios/run`,
		jsonInit("POST", { name: `load ${file}`, wabas, steps: [{ advance: "1s" }] }),
	);

	assert.equal(run.status, 200, JSON.stringify(run.body));
	assert.equal(run.body.data.world.numbers[0].id, PHONE_NUMBER_ID, "the guide's IDs are the default ones");
}

function templateSend(to, name, language, values) {
	return send(
		{
			recipient_type: "individual",
			to,
			type: "template",
			template: {
				name,
				language: { code: language },
				components: [{ type: "body", parameters: values.map(text => ({ type: "text", text })) }],
			},
		},
		{ authorization: "Bearer test-integration-token" },
	);
}

await check(
	"the Workbench guide's seed accepts Workbench's exact send, and refuses a wrong parameter count",
	async () => {
		await loadSeed("workbench-seed.json");

		const ok = await templateSend("60123000001", "workbench_otp", "en", ["123456"]);

		assert.equal(ok.status, 200, JSON.stringify(ok.body));

		const wrong = await templateSend("60123000001", "workbench_otp", "en", ["123456", "extra"]);

		assert.equal(wrong.status, 400, JSON.stringify(wrong.body));
		assert.equal(wrong.body.error.code, 132_000);
	},
);

await check("the GotUnit guide's seed accepts both template modes", async () => {
	await loadSeed("gotunit-seed.json");

	const production = await templateSend("60123000001", "ren_otp", "en_US", ["654321"]);

	assert.equal(production.status, 200, JSON.stringify(production.body));

	const metaTest = await templateSend("60123000001", "jaspers_market_order_confirmation_v1", "en_US", [
		"GotUnit",
		"654321",
		"Jul 1, 2026",
	]);

	assert.equal(metaTest.status, 200, JSON.stringify(metaTest.body));
	await reset();
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
