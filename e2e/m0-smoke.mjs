// Milestone M0 acceptance checks (AC-01, AC-02 and signed webhook delivery) against a running
// mockwa — normally the built Docker image — and the example echo app. Dependency-free:
//
//   node e2e/m0-smoke.mjs
//
// Environment, required (e2e/targets.mjs): GRAPH_URL, CONSOLE_URL and ECHO_URL, each with an
// explicit port. Optional: APP_SECRET (the secret both mockwa and the echo app use).
// Runs every check, prints PASS/FAIL for each, and exits non-zero if any failed.

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { requireTargets } from "./targets.mjs";

const { GRAPH_URL, CONSOLE_URL, ECHO_URL } = requireTargets({
	suite: "M0 smoke",
	urls: ["GRAPH_URL", "CONSOLE_URL", "ECHO_URL"],
});
const APP_SECRET = process.env.APP_SECRET ?? "dev-app-secret";
const AUTH = { authorization: "Bearer m0-smoke-token" };

/**
 * The BSUID keys are additive (SPEC §1, "Canonical webhook payload fixtures"): Meta's captured
 * fixtures come from contacts without one, so they are left out of the comparison.
 */
const IDENTITY_KEYS = new Set(["user_id", "from_user_id", "recipient_user_id"]);

const results = [];
/** Filled by the AC-01 checks, read by the rest. */
const seeded = { phoneNumberId: "", contacts: [] };

async function check(name, run) {
	const startedAt = performance.now();

	try {
		await run();

		const elapsedMs = Math.round(performance.now() - startedAt);

		results.push({ name, passed: true });
		console.log(`PASS  ${name} (${String(elapsedMs)} ms)`);
	} catch (error) {
		const message = String(error?.message ?? error);

		results.push({ name, passed: false });
		console.log(`FAIL  ${name}\n      ${message.replaceAll("\n", "\n      ")}`);
	}
}

/** Fetches and parses JSON, with the body in the error when it is not JSON. */
async function getJson(url, init) {
	const response = await fetch(url, init);
	const text = await response.text();

	try {
		return { status: response.status, body: JSON.parse(text) };
	} catch {
		throw new Error(`expected JSON from ${url}, got ${String(response.status)}: ${text.slice(0, 200)}`);
	}
}

async function statusOf(url, init) {
	const response = await fetch(url, init);

	return response.status;
}

/** Polls `probe` until it returns something other than `false`, or a thrown error is all it gives. */
async function waitFor(description, probe, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		let result;

		try {
			result = await probe();
		} catch {
			// Not up yet: keep polling until the deadline.
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

/** The structure of a JSON value: keys and value types, array items by their first element. */
function shapeOf(value) {
	if (Array.isArray(value)) {
		return value.length === 0 ? [] : [shapeOf(value[0])];
	}

	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).filter(key => !IDENTITY_KEYS.has(key));

		return Object.fromEntries(keys.toSorted((a, b) => a.localeCompare(b)).map(key => [key, shapeOf(value[key])]));
	}

	return value === null ? "null" : typeof value;
}

/** Recomputed here, independently of both mockwa and the echo app. */
function expectedSignature(rawBody) {
	return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

function valueOf(delivery) {
	return delivery.body?.entry?.[0]?.changes?.[0]?.value;
}

async function deliveries() {
	const { body } = await getJson(`${ECHO_URL}/deliveries`);

	return body.deliveries;
}

async function inboundDelivery() {
	const all = await deliveries();

	return all.find(delivery => valueOf(delivery)?.messages !== undefined) ?? false;
}

// --- AC-01: both ports healthy, a default number and two identities, a send returns a wamid ---

await check("AC-01 port 8888 answers /health", async () => {
	await waitFor("8888 /health", async () => (await statusOf(`${GRAPH_URL}/health`)) === 200);
});

await check("AC-01 port 8025 answers /health", async () => {
	await waitFor("8025 /health", async () => (await statusOf(`${CONSOLE_URL}/health`)) === 200);
});

await check("AC-01 a default business number and two identities exist", async () => {
	const { body: state } = await getJson(`${CONSOLE_URL}/api/state`);
	const phoneNumber = state.wabas[0]?.phoneNumbers[0];

	assert.ok(phoneNumber, "no seeded phone number");
	seeded.phoneNumberId = phoneNumber.id;

	const { body: listed } = await getJson(`${CONSOLE_URL}/api/contacts`);

	seeded.contacts = listed.data;
	assert.ok(seeded.contacts.length >= 2, `expected at least two identities, got ${String(seeded.contacts.length)}`);
});

await check("AC-01 a send on 8888 returns a valid wamid", async () => {
	const { status, body } = await getJson(`${GRAPH_URL}/v25.0/${seeded.phoneNumberId}/messages`, {
		method: "POST",
		headers: { ...AUTH, "content-type": "application/json" },
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: seeded.contacts[0].waId,
			type: "text",
			text: { body: "hi" },
		}),
	});

	assert.equal(status, 200, JSON.stringify(body));
	assert.match(body.messages[0].id, /^wamid\.[\w+/=-]+$/);
});

// --- AC-02: each port refuses the other's routes -------------------------------------------

await check("AC-02 port 8888 answers 404 for console routes", async () => {
	for (const path of ["/", "/api", "/api/state", "/api/health", "/api/ws", "/phone", "/settings", "/webhooks"]) {
		const status = await statusOf(`${GRAPH_URL}${path}`);

		assert.equal(status, 404, `GET ${path} on 8888 answered ${String(status)}`);
	}
});

await check("AC-02 port 8025 answers 404 for Graph routes", async () => {
	const probes = [
		["GET", `/v25.0/${seeded.phoneNumberId}`],
		["GET", `/v25.0/${seeded.phoneNumberId}/message_templates`],
		["POST", `/v25.0/${seeded.phoneNumberId}/messages`],
	];

	for (const [method, path] of probes) {
		const status = await statusOf(`${CONSOLE_URL}${path}`, { method, headers: AUTH });

		assert.equal(status, 404, `${method} ${path} on 8025 answered ${String(status)}`);
	}
});

await check("AC-02 port 8025 still serves the console UI", async () => {
	const response = await fetch(`${CONSOLE_URL}/`);
	const html = await response.text();

	assert.equal(response.status, 200);
	assert.match(html, /<div id="root">/);
});

// --- Signed webhook delivery to an independent app -----------------------------------------

await check("webhook: an inbound message reaches the echo app, signed over the exact bytes", async () => {
	await fetch(`${ECHO_URL}/deliveries`, { method: "DELETE" });

	const { status, body } = await getJson(`${CONSOLE_URL}/api/inbound`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			phoneNumberId: seeded.phoneNumberId,
			from: seeded.contacts[0].waId,
			type: "text",
			text: { body: "hello echo" },
		}),
	});

	assert.equal(status, 201, JSON.stringify(body));

	const delivery = await waitFor("the inbound webhook", inboundDelivery);

	assert.equal(delivery.signatureValid, true, "the echo app rejected the signature");
	assert.equal(delivery.signature, expectedSignature(delivery.rawBody), "signature does not match the raw bytes");

	const fixtureUrl = new URL("../docs/fixtures/webhooks/text-message.json", import.meta.url);
	const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));

	assert.deepEqual(shapeOf(delivery.body), shapeOf(fixture), "payload structure differs from Meta's text fixture");
	assert.equal(valueOf(delivery).messages[0].text.body, "hello echo");
});

await check("webhook: the echo app's reply is accepted on 8888 and its statuses arrive signed", async () => {
	const inbound = await inboundDelivery();

	assert.ok(inbound, "no inbound delivery to reply to");

	const reply = await waitFor("the echo app's reply", async () => {
		const all = await deliveries();

		return all.find(delivery => delivery.rawBody === inbound.rawBody)?.reply ?? false;
	});

	assert.equal(reply.status, 200, JSON.stringify(reply.body));

	const replyId = reply.body.messages[0].id;
	const statuses = await waitFor("sent and delivered statuses", async () => {
		const all = await deliveries();
		const seen = all
			.flatMap(delivery => valueOf(delivery)?.statuses ?? [])
			.filter(entry => entry.id === replyId)
			.map(entry => entry.status);

		return seen.includes("sent") && seen.includes("delivered") ? seen : false;
	});

	assert.deepEqual(statuses.slice(0, 2), ["sent", "delivered"]);

	const all = await deliveries();

	for (const delivery of all) {
		assert.equal(delivery.signature, expectedSignature(delivery.rawBody), "a delivery was not signed over its bytes");
	}

	const conversation = `${seeded.phoneNumberId}:${seeded.contacts[0].waId}`;
	const { body: messages } = await getJson(`${CONSOLE_URL}/api/conversations/${conversation}/messages`);

	assert.ok(JSON.stringify(messages).includes("echo: hello echo"), "the reply is not in the conversation");
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
