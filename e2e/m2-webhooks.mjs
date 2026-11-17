// Milestone M2 acceptance checks (AC-06 routing and AC-07 retries) against a running mockwa —
// normally the built Docker image — and two copies of the example echo app, one per app.
// Dependency-free apart from the `docker` CLI, which the restart check uses:
//
//   node e2e/m2-webhooks.mjs
//
// The instance is started with e2e/fixtures/m2-seed.json (two WABAs, one number each),
// MOCKWA_APPS=e2e/fixtures/m2-apps.json (Sales App on 3003, Support App on 3004, each subscribed
// to one WABA), a file database on a volume, and a short MOCKWA_WEBHOOK_RETRY_SCHEDULE so a
// retry is due within seconds. See .github/workflows/docker.yml for the exact command.
//
// Environment, required (e2e/targets.mjs): M2_GRAPH_URL, M2_CONSOLE_URL, M2_SALES_ECHO_URL and
// M2_SUPPORT_ECHO_URL, each with an explicit port, and M2_CONTAINER (the container the restart
// check stops and starts). Optional: M2_ECHO_HOST (host.docker.internal: how the container
// reaches the echo apps). Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { requireTargets } from "./targets.mjs";

const {
	M2_GRAPH_URL: GRAPH_URL,
	M2_CONSOLE_URL: CONSOLE_URL,
	M2_SALES_ECHO_URL: SALES_ECHO_URL,
	M2_SUPPORT_ECHO_URL: SUPPORT_ECHO_URL,
	M2_CONTAINER: CONTAINER,
} = requireTargets({
	suite: "M2 webhooks",
	urls: ["M2_GRAPH_URL", "M2_CONSOLE_URL", "M2_SALES_ECHO_URL", "M2_SUPPORT_ECHO_URL"],
	names: ["M2_CONTAINER"],
});
const ECHO_HOST = process.env.M2_ECHO_HOST ?? "host.docker.internal";

function readFixture(name) {
	const url = new URL(`fixtures/${name}`, import.meta.url);

	return JSON.parse(readFileSync(url, "utf8"));
}

const [SALES, SUPPORT] = readFixture("m2-apps.json");
const [SALES_WABA, SUPPORT_WABA] = readFixture("m2-seed.json");
const SALES_PHONE = SALES_WABA.phoneNumbers[0].id;
const SUPPORT_PHONE = SUPPORT_WABA.phoneNumbers[0].id;
const SALES_CUSTOMER = SALES_WABA.contacts[0].waId;
const SUPPORT_CUSTOMER = SUPPORT_WABA.contacts[0].waId;

const results = [];

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
	if (text === "") {
		return { status: response.status, body: null };
	}

	let body;

	try {
		body = JSON.parse(text);
	} catch {
		throw new Error(`expected JSON from ${url}, got ${String(response.status)}: ${text.slice(0, 200)}`);
	}

	return { status: response.status, body };
}

function jsonInit(method, body, headers = {}) {
	return {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body !== undefined && { body: JSON.stringify(body) }),
	};
}

/** A Graph call as one of the apps: the access token is what tells mockwa which app it is. */
function asApp(app, path, method = "GET", body) {
	return getJson(`${GRAPH_URL}/v25.0/${path}`, jsonInit(method, body, { authorization: `Bearer ${app.accessToken}` }));
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
function signatureFor(secret, rawBody) {
	return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

async function echoDeliveries(echoUrl) {
	const { body } = await getJson(`${echoUrl}/deliveries`);

	return body.deliveries;
}

/** What one echo app received that carries `text`, oldest first. */
async function receivedCarrying(echoUrl, text) {
	const received = await echoDeliveries(echoUrl);

	return received.filter(delivery => delivery.rawBody.includes(text));
}

/** The first delivery carrying `text` an echo app received, or `undefined`. */
async function firstCarrying(echoUrl, text) {
	const [first] = await receivedCarrying(echoUrl, text);

	return first;
}

function sortedStrings(values) {
	return values.toSorted((a, b) => a.localeCompare(b));
}

async function resetEchoes() {
	for (const echoUrl of [SALES_ECHO_URL, SUPPORT_ECHO_URL]) {
		await fetch(`${echoUrl}/deliveries`, { method: "DELETE" });
		await fetch(`${echoUrl}/fail`, { method: "DELETE" });
	}
}

/** A customer writes in; the text is unique, so each check can find its own webhook. */
async function inbound(phoneNumberId, from, text) {
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/inbound`,
		jsonInit("POST", { phoneNumberId, from, type: "text", text: { body: text } }),
	);

	assert.equal(status, 201, `POST /api/inbound answered ${String(status)}: ${JSON.stringify(body)}`);
}

/** mockwa's own log of every attempt carrying `text`, oldest first. */
async function loggedAttempts(text) {
	const { body } = await getJson(`${CONSOLE_URL}/api/webhook-deliveries?limit=100`);

	return body.data.filter(delivery => delivery.requestBody.includes(text)).toReversed();
}

function setOverrideBody(path) {
	return { override_callback_uri: `http://${ECHO_HOST}:3003/webhook?route=${path}`, verify_token: SALES.verifyToken };
}

await check("both apps are registered, each subscribed to its own WABA", async () => {
	const { body } = await getJson(`${CONSOLE_URL}/api/apps`);
	const names = body.data.apps.map(app => app.name);

	assert.deepEqual(sortedStrings(names), ["Sales App", "Support App", "whaloc"]);
	assert.ok(body.data.apps.every(app => app.hasAppSecret === !app.isDefault));

	const raw = JSON.stringify(body);

	assert.ok(!raw.includes(SALES.appSecret) && !raw.includes(SUPPORT.appSecret), "an App Secret was served");

	const subscribed = body.data.subscriptions
		.filter(subscription => !subscription.isImplicit)
		.map(subscription => `${subscription.appKey}:${subscription.wabaId}`);

	assert.deepEqual(sortedStrings(subscribed), [`${SALES.id}:${SALES_WABA.id}`, `${SUPPORT.id}:${SUPPORT_WABA.id}`]);
});

await check("AC-06 each WABA's webhooks reach its own app, signed with that app's secret", async () => {
	await resetEchoes();
	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac06-sales");
	await inbound(SUPPORT_PHONE, SUPPORT_CUSTOMER, "ac06-support");

	const sales = await waitFor("the Sales delivery", () => firstCarrying(SALES_ECHO_URL, "ac06-sales"));
	const support = await waitFor("the Support delivery", () => firstCarrying(SUPPORT_ECHO_URL, "ac06-support"));

	assert.equal(sales.signature, signatureFor(SALES.appSecret, sales.rawBody));
	assert.equal(support.signature, signatureFor(SUPPORT.appSecret, support.rawBody));
	assert.ok(sales.signatureValid && support.signatureValid);
	// Neither app sees the other WABA's traffic.
	assert.deepEqual(await receivedCarrying(SALES_ECHO_URL, "ac06-support"), []);
	assert.deepEqual(await receivedCarrying(SUPPORT_ECHO_URL, "ac06-sales"), []);
});

await check("AC-06 a WABA override set through the Graph API moves the app's messages", async () => {
	await resetEchoes();

	const set = await asApp(SALES, `${SALES_WABA.id}/subscribed_apps`, "POST", setOverrideBody("waba"));

	assert.deepEqual(set.body, { success: true });

	const listed = await asApp(SALES, `${SALES_WABA.id}/subscribed_apps`);

	assert.equal(listed.body.data[0].override_callback_uri, setOverrideBody("waba").override_callback_uri);

	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac06-waba-override");

	const delivery = await waitFor("the overridden delivery", () => firstCarrying(SALES_ECHO_URL, "ac06-waba-override"));

	assert.equal(delivery.url, "/webhook?route=waba");
	assert.ok(delivery.signatureValid, "an override is still signed with the app's secret");
});

await check("AC-06 a phone-number override wins over the WABA override, for messages", async () => {
	await resetEchoes();

	const set = await asApp(SALES, SALES_PHONE, "POST", { webhook_configuration: setOverrideBody("phone") });

	assert.deepEqual(set.body, { success: true });

	const configuration = await asApp(SALES, `${SALES_PHONE}?fields=webhook_configuration`);

	assert.deepEqual(configuration.body, {
		webhook_configuration: {
			phone_number: setOverrideBody("phone").override_callback_uri,
			whatsapp_business_account: setOverrideBody("waba").override_callback_uri,
			application: SALES.callbackUrl,
		},
		id: SALES_PHONE,
	});

	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac06-phone-override");

	const delivery = await waitFor("the phone-override delivery", () =>
		firstCarrying(SALES_ECHO_URL, "ac06-phone-override"),
	);

	assert.equal(delivery.url, "/webhook?route=phone");
});

await check("AC-06 template status webhooks ignore the overrides and go to the app's callback", async () => {
	await resetEchoes();

	const name = `m2_status_${String(Date.now())}`;
	const created = await asApp(SALES, `${SALES_WABA.id}/message_templates`, "POST", {
		name,
		language: "en",
		category: "UTILITY",
		components: [{ type: "BODY", text: "Your visit is confirmed." }],
	});

	assert.equal(created.status, 200, JSON.stringify(created.body));

	const delivery = await waitFor("the template status webhook", async () => {
		const received = await receivedCarrying(SALES_ECHO_URL, name);

		return received.find(candidate => candidate.rawBody.includes("message_template_status_update"));
	});

	assert.equal(delivery.url, "/webhook");
	assert.ok(delivery.signatureValid);

	// Back to plain routing for the retry checks: an empty URI and a bare POST remove the overrides.
	await asApp(SALES, SALES_PHONE, "POST", { webhook_configuration: { override_callback_uri: "" } });
	await asApp(SALES, `${SALES_WABA.id}/subscribed_apps`, "POST");
});

await check("AC-07 a 204 is not a success: the delivery is retried until a 200", async () => {
	await resetEchoes();
	await getJson(`${SALES_ECHO_URL}/fail`, jsonInit("PUT", { status: 204, count: 1 }));
	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac07-no-content");

	const answered = await waitFor("a 204 then a 200", async () => {
		const received = await receivedCarrying(SALES_ECHO_URL, "ac07-no-content");

		return received.length >= 2 ? received : false;
	});

	assert.deepEqual(
		answered.map(delivery => delivery.answeredStatus),
		[204, 200],
	);
	// A retry is the same request: same bytes, same signature, so a receiver can deduplicate.
	assert.equal(answered[0].rawBody, answered[1].rawBody);
	assert.equal(answered[0].signature, answered[1].signature);

	const logged = await loggedAttempts("ac07-no-content");

	assert.deepEqual(
		logged.map(attempt => [attempt.attempt, attempt.responseStatus]),
		[
			[1, 204],
			[2, 200],
		],
	);
	assert.ok(
		logged.every(attempt => attempt.chainId === logged[0].chainId),
		"the attempts are one chain",
	);
	assert.equal(logged.at(-1).outcome, "delivered");
});

function dockerRun(...args) {
	return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

async function waitHealthy() {
	await waitFor(
		"the container to be healthy again",
		() => dockerRun("inspect", "--format", "{{.State.Health.Status}}", CONTAINER) === "healthy",
		90_000,
	);
}

await check("AC-07 a 500 is retried, and a pending retry survives a container restart", async () => {
	await resetEchoes();
	await getJson(`${SALES_ECHO_URL}/fail`, jsonInit("PUT", { status: 500 }));
	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac07-restart");

	const first = await waitFor("the first, failed attempt", async () => {
		const [attempt] = await loggedAttempts("ac07-restart");

		return attempt?.nextAttemptAt === null ? false : attempt;
	});

	assert.equal(first.responseStatus, 500);
	assert.equal(first.outcome, "retrying");

	dockerRun("stop", CONTAINER);

	const stoppedAt = Date.now();

	// The receiver is fixed while mockwa is down; only a stored retry can still deliver.
	await fetch(`${SALES_ECHO_URL}/fail`, { method: "DELETE" });
	dockerRun("start", CONTAINER);
	await waitHealthy();

	const delivered = await waitFor(
		"the retry after the restart",
		async () => {
			const attempts = await loggedAttempts("ac07-restart");

			return attempts.find(attempt => attempt.responseStatus === 200);
		},
		60_000,
	);

	assert.ok(Date.parse(delivered.createdAt) > stoppedAt, "the 200 came before the restart");
	assert.equal(delivered.chainId, first.chainId);

	const received = await receivedCarrying(SALES_ECHO_URL, "ac07-restart");

	assert.equal(received.at(-1).answeredStatus, 200);
	assert.equal(received.at(-1).signature, signatureFor(SALES.appSecret, received.at(-1).rawBody));
});

await check("AC-07 cancelling a retry stops the chain", async () => {
	await resetEchoes();
	await getJson(`${SALES_ECHO_URL}/fail`, jsonInit("PUT", { status: 503 }));
	await inbound(SALES_PHONE, SALES_CUSTOMER, "ac07-cancel");

	const [first] = await waitFor("the failed attempt", async () => {
		const attempts = await loggedAttempts("ac07-cancel");

		return attempts.length > 0 ? attempts : false;
	});
	const cancelled = await getJson(`${CONSOLE_URL}/api/webhook-deliveries/${first.id}/cancel-retry`, { method: "POST" });

	assert.equal(cancelled.status, 200);
	assert.equal(cancelled.body.data[0].nextAttemptAt, null);
	assert.equal(cancelled.body.data[0].outcome, "failed");

	await fetch(`${SALES_ECHO_URL}/fail`, { method: "DELETE" });
	// Longer than the retry schedule: nothing may arrive.
	await sleep(6000);

	const received = await receivedCarrying(SALES_ECHO_URL, "ac07-cancel");

	assert.equal(received.length, 1);
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} M2 checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
