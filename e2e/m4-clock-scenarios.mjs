// Milestone M4 acceptance checks (virtual clock and scenarios) against a running mockwa —
// normally the built Docker image — and the example echo app playing the app under test.
// Dependency-free apart from the `docker` CLI, which runs `mockwa scenario` inside the
// container and restarts it:
//
//   node e2e/m4-clock-scenarios.mjs
//
// The instance runs MOCKWA_CLOCK=virtual from M4_CLOCK_START, the default seed, a file
// database on a volume, and slow status rungs so a few minutes of virtual time hold several
// events: MOCKWA_STATUS_DELAYS=sent:0,delivered:120000,read:240000 (delivered at +2m, read
// 4m after that). examples/scenarios is mounted at /scenarios and e2e/fixtures at /fixtures.
// See .github/workflows/docker.yml.
//
// Waits on the echo app are bounded in real time (it answers over HTTP, on its own clock):
// mockwa's virtual clock does not move the app's clock, and nothing here assumes it does.
//
// Environment, required (e2e/targets.mjs): M4_GRAPH_URL, M4_CONSOLE_URL and M4_ECHO_URL, each
// with an explicit port, and M4_CONTAINER (the container the CLI runs in and the restart check
// restarts). Optional: M4_APP_SECRET (m4-app-secret), M4_CLOCK_START (2026-06-01T08:00:00.000Z),
// M4_INNER_CONSOLE_URL (the console as seen from inside the container, http://127.0.0.1:8025).
// Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { requireTargets } from "./targets.mjs";

const {
	M4_GRAPH_URL: GRAPH_URL,
	M4_CONSOLE_URL: CONSOLE_URL,
	M4_ECHO_URL: ECHO_URL,
	M4_CONTAINER: CONTAINER,
} = requireTargets({
	suite: "M4 clock and scenarios",
	urls: ["M4_GRAPH_URL", "M4_CONSOLE_URL", "M4_ECHO_URL"],
	names: ["M4_CONTAINER"],
});
const APP_SECRET = process.env.M4_APP_SECRET ?? "m4-app-secret";
const START_INSTANT = new Date(process.env.M4_CLOCK_START ?? "2026-06-01T08:00:00.000Z");
const START = START_INSTANT.toISOString();
const INNER_CONSOLE_URL = process.env.M4_INNER_CONSOLE_URL ?? "http://127.0.0.1:8025";
const AUTH = { authorization: "Bearer m4-checks" };
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Contacts nobody seeded, one per check. */
const TIMELINE = "5511900004001";
const CANCELLED = "5511900004002";
const WINDOWED = "5511900004003";
const RESTARTED = "5511900004004";

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

// --- HTTP, Docker and time helpers ----------------------------------------------------------

async function getJson(url, init) {
	const response = await fetch(url, init);
	const text = await response.text();

	return { status: response.status, body: text === "" ? null : JSON.parse(text) };
}

function jsonInit(method, body, headers = {}) {
	return {
		method,
		headers: { "content-type": "application/json", ...headers },
		...(body !== undefined && { body: JSON.stringify(body) }),
	};
}

/** Polls `probe` in real time until it returns something truthy, for at most `timeoutMs`. */
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

function dockerRun(...args) {
	return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** `mockwa …` inside the container: its exit code and what it printed. */
function mockwaCli(...args) {
	const run = spawnSync("docker", ["exec", CONTAINER, "mockwa", ...args], { encoding: "utf8", timeout: 120_000 });

	return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function at(offsetMs) {
	const instant = new Date(Date.parse(START) + offsetMs);

	return instant.toISOString();
}

function epochSeconds(offsetMs) {
	return String(Math.floor((Date.parse(START) + offsetMs) / 1000));
}

/** Recomputed here, independently of both mockwa and the echo app. */
function signatureFor(rawBody) {
	return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

// --- mockwa and echo app helpers ------------------------------------------------------------

async function clock() {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/clock`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function moveClock(route, body) {
	const response = await getJson(`${CONSOLE_URL}/api/clock/${route}`, jsonInit("POST", body));

	assert.equal(response.status, 200, JSON.stringify(response.body));

	return response.body.data;
}

async function reset() {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/reset`, jsonInit("POST"));

	assert.equal(status, 200, JSON.stringify(body));
	await fetch(`${ECHO_URL}/fail`, { method: "DELETE" });
	await fetch(`${ECHO_URL}/deliveries`, { method: "DELETE" });
}

async function failDeliveries(failure) {
	const response = await fetch(`${ECHO_URL}/fail`, jsonInit("PUT", failure));

	assert.equal(response.status, 200);
}

function send(body) {
	return getJson(
		`${GRAPH_URL}/v25.0/${context.phoneNumberId}/messages`,
		jsonInit("POST", { messaging_product: "whatsapp", ...body }, AUTH),
	);
}

async function sendText(to, text) {
	const { status, body } = await send({ to, type: "text", text: { body: text } });

	assert.equal(status, 200, JSON.stringify(body));

	return body.messages[0].id;
}

async function sendTemplate(to) {
	const { status, body } = await send({
		to,
		type: "template",
		template: { name: "hello_whaloc", language: { code: "en" } },
	});

	assert.equal(status, 200, JSON.stringify(body));

	return body.messages[0].id;
}

async function inbound(from, text) {
	const { status, body } = await getJson(
		`${CONSOLE_URL}/api/inbound`,
		jsonInit("POST", { phoneNumberId: context.phoneNumberId, from, type: "text", text: { body: text } }),
	);

	assert.equal(status, 201, JSON.stringify(body));
}

async function echoDeliveries() {
	const { body } = await getJson(`${ECHO_URL}/deliveries`);

	return body.deliveries;
}

/** The wamid of the echo app's reply to the inbound message carrying `text`. */
async function echoReplyTo(text) {
	return waitFor(`the echo app's reply to "${text}"`, async () => {
		const all = await echoDeliveries();
		const delivery = all.find(candidate => candidate.rawBody.includes(`"${text}"`) && candidate.reply !== null);

		return delivery?.reply?.body?.messages?.[0]?.id ?? false;
	});
}

/** Every status webhook the echo app received for one wamid, in arrival order. */
async function statusesFor(wamid) {
	const all = await echoDeliveries();

	return all.flatMap(delivery => {
		const statuses = JSON.parse(delivery.rawBody)
			.entry.flatMap(entry => entry.changes)
			.flatMap(change => change.value.statuses ?? []);

		return statuses.filter(status => status.id === wamid).map(status => ({ status, delivery }));
	});
}

async function waitForStatus(wamid, name) {
	return waitFor(`a "${name}" status for ${wamid}`, async () => {
		const found = await statusesFor(wamid);

		return found.find(entry => entry.status.status === name && entry.delivery.answeredStatus === 200) ?? false;
	});
}

async function mockwaDeliveries(limit = 200) {
	const { status, body } = await getJson(`${CONSOLE_URL}/api/webhook-deliveries?limit=${String(limit)}`);

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

/**
 * A small XML 1.0 well-formedness check (balanced, properly nested tags; quoted attributes; no
 * stray `<` or `&` in text) — enough to prove a JUnit report parses, with no XML dependency.
 */
function assertWellFormedXml(xml) {
	const body = xml.replace(/^<\?xml [^?]*\?>\s*/, "");
	const tags = /<[^>]*>/g;
	const stack = [];
	let cursor = 0;
	let roots = 0;

	for (const match of body.matchAll(tags)) {
		const text = body.slice(cursor, match.index);

		assert.ok(!/<|&(?!(amp|lt|gt|quot|apos|#\d+);)/.test(text), `bad character data: ${text.slice(0, 80)}`);
		cursor = match.index + match[0].length;

		const tag = match[0];
		const closing = /^<\/([\w.-]+)\s*>$/.exec(tag);

		if (closing !== null) {
			assert.equal(stack.pop(), closing[1], `mismatched </${closing[1]}>`);
			continue;
		}

		const opening = /^<([\w.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>$/.exec(tag);

		assert.ok(opening !== null, `malformed tag: ${tag.slice(0, 120)}`);

		if (stack.length === 0) {
			roots += 1;
		}

		if (opening[3] !== "/") {
			stack.push(opening[1]);
		}
	}

	assert.equal(body.slice(cursor).trim(), "", "text after the root element");
	assert.deepEqual(stack, [], "unclosed elements");
	assert.equal(roots, 1, "exactly one root element");
}

// --- Setup ----------------------------------------------------------------------------------

await check("setup: the instance runs on the virtual clock, and a reset puts it at the start", async () => {
	const { body: state } = await getJson(`${CONSOLE_URL}/api/state`);

	context.phoneNumberId = state.wabas[0].phoneNumbers[0].id;
	assert.ok(context.phoneNumberId, "no seeded phone number");

	await reset();

	const view = await clock();

	assert.equal(view.mode, "virtual");
	assert.equal(view.now, START);
	assert.deepEqual(view.pending, []);
});

// --- AC-10: advancing fires exactly the events due, in order, at virtual times ---------------

await check(
	"AC-10: advancing 5 virtual minutes fires exactly the events due, in order, with virtual timestamps",
	async () => {
		await inbound(TIMELINE, "timeline");

		const wamid = await echoReplyTo("timeline");

		// The `sent` rung is due at once and runs without an advance; delivered waits for the clock.
		await waitForStatus(wamid, "sent");

		const before = await clock();

		assert.equal(before.now, START, "the clock moved by itself");
		assert.deepEqual(
			before.pending.map(event => [event.label, event.dueAt]),
			[[`status delivered ${wamid}`, at(2 * MINUTE)]],
		);

		// The delivered webhook fails once, so its retry (+10s) is scheduled during the advance.
		await failDeliveries({ status: 500, count: 1 });

		const move = await moveClock("advance", { by: "5m" });

		assert.equal(move.from, START);
		assert.equal(move.to, at(5 * MINUTE));
		assert.deepEqual(
			move.fired.map(event => [event.label, event.dueAt]),
			[
				[`status delivered ${wamid}`, at(2 * MINUTE)],
				["webhook retry", at(2 * MINUTE + 10 * SECOND)],
			],
		);
		// Later events stay pending, with their own due time: read is 4 minutes after delivered.
		assert.deepEqual(
			move.clock.pending.map(event => [event.label, event.dueAt]),
			[[`status read ${wamid}`, at(6 * MINUTE)]],
		);
		assert.equal(move.clock.now, at(5 * MINUTE));

		// The app received the delivered status twice — the failed attempt and its retry — with the
		// same bytes, stamped with the virtual instant it fell due, and no read status yet.
		const received = await statusesFor(wamid);
		const delivered = received.filter(entry => entry.status.status === "delivered");

		assert.deepEqual(
			delivered.map(entry => entry.delivery.answeredStatus),
			[500, 200],
		);
		assert.equal(delivered[0].delivery.rawBody, delivered[1].delivery.rawBody);
		assert.equal(delivered[0].status.timestamp, epochSeconds(2 * MINUTE));
		assert.ok(
			received.every(entry => entry.status.status !== "read"),
			"read arrived early",
		);

		const log = await mockwaDeliveries(20);
		const retry = log.find(row => row.attempt === 2);

		assert.equal(retry?.createdAt, at(2 * MINUTE + 10 * SECOND));
	},
);

await check("AC-10: run-next moves to the next event only, and an idle clock stays where it is", async () => {
	const view = await clock();
	const [next] = view.pending;
	const move = await moveClock("run-next");

	assert.deepEqual(
		move.fired.map(event => event.label),
		[next.label],
	);
	assert.equal(move.to, next.dueAt);
	assert.deepEqual(move.clock.pending, []);

	const idle = await moveClock("run-next");

	assert.deepEqual(idle.fired, []);
	assert.equal(idle.to, next.dueAt);
});

await check("the clock refuses to move backwards and validates what it is given", async () => {
	const back = await getJson(`${CONSOLE_URL}/api/clock/set`, jsonInit("POST", { to: START }));

	assert.equal(back.status, 400);
	assert.equal(back.body.error.code, "clock_backwards");

	const vague = await getJson(`${CONSOLE_URL}/api/clock/advance`, jsonInit("POST", { by: "five minutes" }));

	assert.equal(vague.status, 400);
});

// --- Cancellation -----------------------------------------------------------------------------

await check("a cancelled retry leaves the queue and never fires", async () => {
	await reset();
	await failDeliveries({ status: 500 });
	await inbound(CANCELLED, "cancel me");

	const first = await waitFor("the failed delivery", async () => {
		const log = await mockwaDeliveries(20);

		return log.find(row => row.outcome === "retrying") ?? false;
	});
	const queued = await clock();

	assert.deepEqual(
		queued.pending.map(event => [event.label, event.dueAt]),
		[["webhook retry", at(10 * SECOND)]],
	);

	const cancelled = await fetch(`${CONSOLE_URL}/api/webhook-deliveries/${first.id}/cancel-retry`, { method: "POST" });

	assert.equal(cancelled.status, 200);

	const move = await moveClock("advance", { by: "1h" });

	assert.deepEqual(move.fired, []);
	assert.deepEqual(move.clock.pending, []);
	const received = await echoDeliveries();

	assert.equal(received.length, 1);
});

// --- The 24-hour window on virtual time --------------------------------------------------------

await check(
	"window: open a millisecond before 24h, closed at it; templates still go; an inbound reopens it",
	async () => {
		await reset();
		await inbound(WINDOWED, "open the window");
		await echoReplyTo("open the window");

		await moveClock("set", { to: at(DAY - 1) });

		const inside = await sendText(WINDOWED, "one millisecond to go");

		await waitForStatus(inside, "sent");

		await moveClock("advance", { by: 1 });

		const boundary = await sendText(WINDOWED, "at the boundary");
		const failed = await waitForStatus(boundary, "failed");

		assert.equal(failed.status.errors[0].code, 131_047);
		assert.equal(failed.status.timestamp, epochSeconds(DAY));

		const template = await sendTemplate(WINDOWED);

		await waitForStatus(template, "sent");

		await moveClock("advance", { by: "1h" });
		await inbound(WINDOWED, "I'm back");
		await echoReplyTo("I'm back");

		const reopened = await sendText(WINDOWED, "welcome back");

		await waitForStatus(reopened, "sent");
	},
);

// --- AC-11: two runs from the same reset state are identical ----------------------------------

async function runBooking(run) {
	await fetch(`${ECHO_URL}/deliveries`, { method: "DELETE" });

	const output = `/tmp/m4-booking-${String(run)}.json`;
	const cli = mockwaCli(
		"scenario",
		"run",
		"/scenarios/booking-conversation.json",
		"--url",
		INNER_CONSOLE_URL,
		"--json",
		output,
	);

	assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);

	const [result] = JSON.parse(dockerRun("exec", CONTAINER, "cat", output));
	const log = await mockwaDeliveries();
	const received = await echoDeliveries();

	return {
		stdout: cli.stdout,
		result: result.result,
		log: log.map(row => {
			return {
				id: row.id,
				chainId: row.chainId,
				attempt: row.attempt,
				createdAt: row.createdAt,
				outcome: row.outcome,
				body: row.requestBody,
				signature: row.requestHeaders["x-hub-signature-256"],
			};
		}),
		// Concurrent deliveries may reach the app in either order over the network; the bytes
		// and signatures are what must not change.
		received: received
			.map(delivery => `${String(delivery.signature)} ${delivery.rawBody}`)
			.toSorted((left, right) => left.localeCompare(right)),
		signaturesValid: received.every(delivery => delivery.signature === signatureFor(delivery.rawBody)),
	};
}

await check(
	"AC-11: two runs from the same reset state give identical IDs, webhook bytes, signatures and results",
	async () => {
		const first = await runBooking(1);
		const second = await runBooking(2);

		assert.equal(first.result.passed, true, first.stdout);
		assert.match(first.stdout, /PASS booking conversation/);
		assert.ok(first.log.length >= 10, `only ${String(first.log.length)} deliveries`);
		assert.equal(first.signaturesValid, true);
		assert.deepEqual(second.result, first.result);
		assert.deepEqual(second.log, first.log);
		assert.deepEqual(second.received, first.received);
		assert.equal(second.received.length, first.log.length);
	},
);

await check("the service-window example passes through the CLI", async () => {
	const cli = mockwaCli("scenario", "run", "/scenarios/service-window.json", "--url", INNER_CONSOLE_URL);

	assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
	assert.match(cli.stdout, /PASS service window/);
});

// --- AC-12: an unmet expectation fails loudly ---------------------------------------------------

await check(
	"AC-12: an unmet expectation names the step, expected vs observed; exit 1 and valid JUnit XML",
	async () => {
		const report = "/tmp/m4-unmet.xml";
		const cli = mockwaCli("scenario", "run", "/fixtures/m4-unmet.json", "--url", INNER_CONSOLE_URL, "--junit", report);

		assert.equal(cli.status, 1, `${cli.stdout}\n${cli.stderr}`);
		assert.match(cli.stdout, /FAIL unmet expectation/);
		assert.match(cli.stdout, /✗ 2\. the app greets Dina by name/);
		assert.match(cli.stdout, /expected: \{[\s\S]*"text": "Hello, Dina!"/);
		assert.match(cli.stdout, /observed: [\s\S]*"text": "echo: hi"/);
		assert.match(cli.stdout, /- 3\. advance 1m {2}\(skipped\)/);
		assert.match(cli.stdout, /1 scenario\(s\): 0 passed, 1 failed/);

		const xml = dockerRun("exec", CONTAINER, "cat", report);

		assertWellFormedXml(xml);
		assert.match(xml, /<testsuites name="mockwa scenarios" tests="3" failures="1" errors="0" skipped="1"/);
		assert.match(
			xml,
			/<testcase classname="mockwa\.scenario\.unmet expectation" name="2\. the app greets Dina by name"/,
		);
		assert.match(xml, /<failure message="[^"]+" type="expect">/);
		assert.match(xml, /&quot;text&quot;: &quot;Hello, Dina!&quot;/);
		assert.match(xml, /<skipped message="an earlier step failed"\/>/);
	},
);

await check("the CLI exits 2 for a file it cannot use, and resets nothing", async () => {
	const before = await clock();
	const cli = mockwaCli("scenario", "run", "/scenarios/missing.json", "--url", INNER_CONSOLE_URL);

	assert.equal(cli.status, 2, `${cli.stdout}\n${cli.stderr}`);
	assert.match(cli.stderr, /missing\.json: cannot read it/);
	const after = await clock();

	assert.equal(after.now, before.now);
});

// --- Restart ----------------------------------------------------------------------------------

await check(
	"restart: the clock's position and a pending retry survive it, and the retry sends the same bytes",
	async () => {
		await reset();
		await failDeliveries({ status: 500 });
		await inbound(RESTARTED, "across a restart");
		await waitFor("the failed delivery", async () => {
			const log = await mockwaDeliveries(20);

			return log.some(row => row.outcome === "retrying");
		});
		await moveClock("advance", { by: "5s" });

		dockerRun("restart", CONTAINER);
		await waitFor(
			"the container to be healthy again",
			() => dockerRun("inspect", "--format", "{{.State.Health.Status}}", CONTAINER) === "healthy",
			90_000,
		);

		const resumed = await clock();

		assert.equal(resumed.now, at(5 * SECOND));
		assert.deepEqual(
			resumed.pending.map(event => [event.label, event.dueAt]),
			[["webhook retry", at(10 * SECOND)]],
		);

		await fetch(`${ECHO_URL}/fail`, { method: "DELETE" });

		const move = await moveClock("advance", { by: "5s" });

		assert.deepEqual(
			move.fired.map(event => event.label),
			["webhook retry"],
		);

		const received = await echoDeliveries();
		const attempts = received.filter(delivery => delivery.rawBody.includes("across a restart"));

		assert.deepEqual(
			attempts.map(delivery => delivery.answeredStatus),
			[500, 200],
		);
		assert.equal(attempts[1].rawBody, attempts[0].rawBody);
		assert.equal(attempts[1].signature, attempts[0].signature);
		await echoReplyTo("across a restart");
	},
);

// --- Compatibility --------------------------------------------------------------------------

await check("every webhook the echo app received was signed over its exact bytes", async () => {
	const all = await echoDeliveries();

	assert.ok(all.length > 0);

	for (const delivery of all) {
		assert.equal(delivery.signatureValid, true, `bad signature on ${delivery.rawBody.slice(0, 120)}`);
		assert.equal(delivery.signature, signatureFor(delivery.rawBody));
	}
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
