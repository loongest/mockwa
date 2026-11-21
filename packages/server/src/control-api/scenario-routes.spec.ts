import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScenarioInput } from "../config/index.ts";
import type { ScenarioResult } from "../domain/index.ts";
import { startCaptureServer, type CaptureServer, type CapturedRequest } from "../testing/capture-server.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * `/api/scenarios` end to end (SPEC §4, "Scenarios"): the composed app on the virtual clock,
 * and a small echo app behind the capture server that answers each webhook through the Graph
 * API — asynchronously, the way a real app under test does.
 */

const START = "2026-04-01T08:00:00.000Z";
const ALICE = "60120000001";
const BOB = "60120000002";
const SECRET = "scenario-secret";

interface InboundWebhook {
	from: string;
	type: string;
	text?: { body: string };
	interactive?: { type: string; button_reply?: { id: string }; list_reply?: { id: string } };
	button?: { payload: string };
}

function inboundOf(request: CapturedRequest): { phoneNumberId: string; message: InboundWebhook } | null {
	const body = JSON.parse(request.body) as {
		entry: [{ changes: [{ value: { metadata?: { phone_number_id: string }; messages?: InboundWebhook[] } }] }];
	};
	const { value } = body.entry[0].changes[0];
	const message = value.messages?.[0];

	return message === undefined || value.metadata === undefined
		? null
		: { phoneNumberId: value.metadata.phone_number_id, message };
}

/** What the echo app sends back for one inbound message. */
function replyTo(message: InboundWebhook): Record<string, unknown> | null {
	if (message.type === "text" && message.text?.body === "menu") {
		return {
			type: "interactive",
			interactive: {
				type: "button",
				body: { text: "Pick one" },
				action: {
					buttons: [
						{ type: "reply", reply: { id: "opt-yes", title: "Yes" } },
						{ type: "reply", reply: { id: "opt-no", title: "No" } },
					],
				},
			},
		};
	}

	if (message.type === "text" && message.text?.body === "template please") {
		return {
			type: "template",
			template: {
				name: "confirm_visit",
				language: { code: "en" },
				components: [
					{
						type: "button",
						sub_type: "quick_reply",
						index: "0",
						parameters: [{ type: "payload", payload: "CONFIRM-42" }],
					},
				],
			},
		};
	}

	if (message.type === "text") {
		return { type: "text", text: { body: `echo: ${message.text!.body}` } };
	}

	if (message.type === "interactive") {
		const id = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;

		return { type: "text", text: { body: `you chose ${id ?? "?"}` } };
	}

	if (message.type === "button") {
		return { type: "text", text: { body: `button ${message.button!.payload}` } };
	}

	return null;
}

const WORLD = {
	clock: { start: START },
	wabas: [
		{
			id: "100000000000001",
			name: "Clinic",
			phoneNumbers: [
				{ id: "200000000000001", displayPhoneNumber: "+60 3-1234 5678", verifiedName: "Clinic Front Desk" },
			],
			templates: [
				{
					name: "confirm_visit",
					components: [
						{ type: "BODY", text: "Please confirm your visit." },
						{ type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] },
					],
				},
			],
		},
	],
	identities: [
		{ waId: ALICE, name: "Alice", role: "CUSTOMER" },
		{ waId: BOB, name: "Bob", role: "TECHNICIAN" },
	],
} satisfies Partial<ScenarioInput>;

describe("scenarios", () => {
	let fixture: TestApp;
	let capture: CaptureServer;
	/** Graph calls the echo app made, so a test can wait for them like it waits for any request. */
	const replies: Promise<unknown>[] = [];

	beforeEach(async () => {
		capture = await startCaptureServer(request => {
			const inbound = inboundOf(request);
			const reply = inbound === null ? null : replyTo(inbound.message);

			if (inbound !== null && reply !== null) {
				// Answered after the webhook returns, like an app that queues its work.
				replies.push(
					(async () => {
						await new Promise(resolve => {
							setTimeout(resolve, 5);
						});

						return fixture.app.request(`/v25.0/${inbound.phoneNumberId}/messages`, {
							method: "POST",
							headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
							body: JSON.stringify({ messaging_product: "whatsapp", to: inbound.message.from, ...reply }),
						});
					})(),
				);
			}

			return { status: 200, body: "ok" };
		});
		fixture = await createTestApp({
			WASANDBOX_CLOCK: "virtual",
			WASANDBOX_WEBHOOK_URL: capture.url,
			WASANDBOX_APP_SECRET: SECRET,
			WASANDBOX_STATUS_DELAYS: "sent:0,delivered:1000",
		});
	});

	afterEach(async () => {
		await Promise.allSettled(replies.splice(0));
		await fixture.close();
		await capture.close();
	});

	async function run(scenario: ScenarioInput, query = "") {
		return fixture.app.request(`/api/scenarios/run${query}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(scenario),
		});
	}

	async function result(scenario: ScenarioInput): Promise<ScenarioResult> {
		const response = await run(scenario);

		expect(response.status).toBe(200);

		return ((await response.json()) as { data: ScenarioResult }).data;
	}

	const conversation: ScenarioInput = {
		name: "menu and echo",
		...WORLD,
		steps: [
			{ send: { as: "Alice", text: "hi" } },
			{ expect: { message: { to: "Alice", text: "echo: hi" } } },
			{ send: { as: ALICE, text: "menu" } },
			{ expect: { message: { to: "Alice", type: "interactive", text: "Pick one" } } },
			{ tap: { as: "Alice", option: "Yes" } },
			{ expect: { message: { to: "Alice", text: "you chose opt-yes" } } },
			{ advance: "1s" },
			{ expect: { webhook: { kind: "status", status: "delivered", about: "Alice", count: 3 }, within: 0 } },
			{ expect: { webhook: { field: "messages", kind: "message", about: "Alice", count: 3 } } },
			{ expect: { window: { as: "Alice", open: true } } },
			{ advance: { by: "24h" } },
			{ expect: { window: { as: "Alice", open: false } } },
			{ expect: { clock: { now: "2026-04-02T08:00:01Z", pending: 0 } } },
		],
	};

	it("runs a conversation with an app: sends, taps, waits and advances", async () => {
		const outcome = await result(conversation);

		expect(outcome.failure).toBeNull();
		expect(outcome.passed).toBe(true);
		expect(outcome.steps.map(step => [step.index, step.status])).toEqual(
			conversation.steps.map((_, index) => [index + 1, "passed"]),
		);
		expect(outcome.steps[0]).toMatchObject({ name: 'Alice sends "hi"', action: "send", at: START });
		expect(outcome.steps[4]?.detail).toMatchObject({ option: { kind: "button_reply", id: "opt-yes", title: "Yes" } });
		expect(outcome.steps[6]?.detail).toMatchObject({ from: START, to: "2026-04-01T08:00:01.000Z" });
		expect(outcome.world.identities).toEqual([
			{ waId: ALICE, name: "Alice", role: "CUSTOMER" },
			{ waId: BOB, name: "Bob", role: "TECHNICIAN" },
		]);
	});

	it("AC-11: two runs from the same state give the same results, IDs, bytes and signatures", async () => {
		async function once() {
			await Promise.allSettled(replies.splice(0));
			capture.requests.length = 0;

			const outcome = await result(conversation);

			await Promise.allSettled(replies.splice(0));

			return {
				outcome,
				webhooks: capture.requests.map(request => {
					return {
						body: request.body,
						signature: request.headers["x-hub-signature-256"],
					};
				}),
			};
		}

		const first = await once();
		const second = await once();

		expect(first.outcome.passed).toBe(true);
		expect(first.webhooks.length).toBeGreaterThan(5);
		expect(second).toEqual(first);
	});

	it("taps a template's quick reply with the payload the send gave it", async () => {
		const outcome = await result({
			name: "template quick reply",
			...WORLD,
			steps: [
				{ send: { as: "Bob", text: "template please" } },
				{ expect: { message: { to: "Bob", template: "confirm_visit" } } },
				{ tap: { as: "Bob", option: "Confirm" } },
				{ expect: { message: { to: "Bob", text: "button CONFIRM-42" } } },
			],
		});

		expect(outcome.failure).toBeNull();
		expect(outcome.steps[2]?.detail).toMatchObject({
			option: { kind: "quick_reply", text: "Confirm", payload: "CONFIRM-42" },
		});
	});

	it("AC-12: an unmet expectation fails its step with expected and observed, and skips the rest", async () => {
		const response = await run({
			name: "wrong reply",
			...WORLD,
			steps: [
				{ send: { as: "Alice", text: "hi" } },
				{ name: "the reply is polite", expect: { message: { to: "Alice", text: "Hello, Alice!" }, within: "300ms" } },
				{ send: { as: "Alice", text: "never sent" } },
			],
		});
		const outcome = ((await response.json()) as { data: ScenarioResult }).data;

		expect(response.status).toBe(200);
		expect(outcome.passed).toBe(false);
		expect(outcome.failure).toMatchObject({
			step: 2,
			name: "the reply is polite",
			action: "expect",
			expected: { to: "Alice", text: "Hello, Alice!" },
			observed: [{ type: "text", text: "echo: hi" }],
		});
		expect(outcome.failure?.message).toMatch(/none of the 1 message\(s\) sent to Alice matches \(waited 300ms\)/);
		expect(outcome.steps.map(step => step.status)).toEqual(["passed", "failed", "skipped"]);
	});

	it("reports the same failure as JUnit XML", async () => {
		const response = await run(
			{
				name: "wrong reply",
				...WORLD,
				steps: [
					{ send: { as: "Alice", text: "hi" } },
					{ expect: { message: { to: "Alice", text: "<nope & never>" }, within: "100ms" } },
					{ advance: "1m" },
				],
			},
			"?format=junit",
		);
		const xml = await response.text();

		expect(response.headers.get("content-type")).toMatch(/^application\/xml/);
		expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites /);
		expect(xml).toContain('<testsuite name="wrong reply" tests="3" failures="1" errors="0" skipped="1"');
		expect(xml).toContain(
			'<failure message="none of the 1 message(s) sent to Alice matches (waited 100ms)" type="expect">',
		);
		expect(xml).toContain("&quot;text&quot;: &quot;&lt;nope &amp; never&gt;&quot;");
		expect(xml).toContain('<skipped message="an earlier step failed"/>');
	});

	it("arms failure rules and routes webhooks to the scenario's apps", async () => {
		const other = await startCaptureServer();

		try {
			const outcome = await result({
				name: "routing and failures",
				...WORLD,
				apps: [
					{
						name: "Support bot",
						appSecret: "support-secret",
						callbackUrl: capture.url,
						wabas: ["Clinic"],
						phoneOverrides: [{ number: "+60 3-1234 5678", callbackUrl: `${other.url}/clinic` }],
					},
				],
				failureRules: [
					{
						target: "messages.status",
						trigger: { kind: "next", count: 1 },
						preset: "failed_status",
						errorCode: 131_026,
					},
				],
				steps: [
					{ send: { as: "Alice", text: "hi" } },
					{ expect: { webhook: { app: "Support bot", kind: "message", outcome: "delivered", count: 1 } } },
					{ expect: { webhook: { app: "default", count: 0 }, within: 0 } },
				],
			});

			expect(outcome.failure).toBeNull();
			// The number-level override won: the copy went there, not to the app's own URL.
			expect(other.requests.map(request => request.path)).toEqual(["/meta-webhooks/clinic"]);
			expect(capture.requests).toEqual([]);
		} finally {
			await other.close();
		}
	});

	it("fails a send the injected failure rule turns into a failed status", async () => {
		const outcome = await result({
			name: "failed status",
			...WORLD,
			failureRules: [
				{ target: "messages.status", trigger: { kind: "next", count: 1 }, preset: "failed_status", errorCode: 131_026 },
			],
			steps: [
				{ send: { as: "Alice", text: "hi" } },
				{ expect: { message: { to: "Alice", text: "echo: hi", status: "failed", errorCode: 131_026 } } },
			],
		});

		expect(outcome.failure).toBeNull();
	});

	it("refuses an invalid scenario with every problem and its location, before touching state", async () => {
		const before = await fixture.services.repositories.contacts.list();
		const schema = await run({
			name: "bad",
			steps: [{ send: { as: "Alice" } }, { expect: {} }, { wait: "5s" }],
		} as never);

		expect(schema.status).toBe(400);

		const schemaError = ((await schema.json()) as { error: { message: string; code: string } }).error;

		expect(schemaError.code).toBe("invalid_scenario");
		expect(schemaError.message).toContain("steps[0].send.text: give either text or message");
		expect(schemaError.message).toContain(
			"steps[1].expect: an expect names exactly one of message, webhook, window, clock",
		);
		expect(schemaError.message).toMatch(/steps\[2\]: Unrecognized key: "wait"/);

		const references = await run({
			name: "unknown people",
			...WORLD,
			steps: [
				{ send: { as: "Carol", text: "hi" } },
				{ tap: { as: "Alice", to: "+1 555", option: "Yes" } },
				{ send: { as: "Alice", message: { type: "text" } } },
			],
		});
		const referenceError = ((await references.json()) as { error: { message: string } }).error;

		expect(references.status).toBe(400);
		expect(referenceError.message).toContain('steps[0].send.as: no identity "Carol"');
		expect(referenceError.message).toContain('steps[1].tap.to: no business number "+1 555"');
		expect(referenceError.message).toContain("steps[2].send.message: text:");
		expect(await fixture.services.repositories.contacts.list()).toEqual(before);
	});

	it("validates without running", async () => {
		const response = await fixture.app.request("/api/scenarios/validate", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(conversation),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: { valid: true, name: "menu and echo", steps: 13 } });
		expect(capture.requests).toEqual([]);
	});
});

describe("scenarios on the real clock", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	it("refuses a scenario that moves the clock", async () => {
		const response = await fixture.app.request("/api/scenarios/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "needs time", steps: [{ advance: "1m" }] }),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ error: { code: "clock_not_virtual" } });
	});

	it("runs one that does not, with no virtual times in its results", async () => {
		const response = await fixture.app.request("/api/scenarios/run", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "real time",
				steps: [
					{ send: { as: "Ana Souza", text: "hello" } },
					{ expect: { window: { as: "5571990000001", open: true } } },
				],
			}),
		});
		const outcome = ((await response.json()) as { data: ScenarioResult }).data;

		expect(outcome).toMatchObject({ passed: true, clock: { mode: "real", start: null, end: null } });
		expect(outcome.steps.map(step => step.at)).toEqual([null, null]);
	});
});
