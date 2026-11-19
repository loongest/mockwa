import { clockMoveResponseSchema, clockResponseSchema } from "@mockwa/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCaptureServer, type CaptureServer, type CapturedRequest } from "../testing/capture-server.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * `/api/clock` and the virtual clock end to end (SPEC §4, "Virtual clock"; §5): the composed
 * app on `MOCKWA_CLOCK=virtual`, webhooks captured as the bytes an app would receive.
 */

const START = "2026-03-01T09:00:00.000Z";
const START_SECONDS = Date.parse(START) / 1000;
const CONTACT = "5571990000001";
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The instant `offsetMs` after the clock's start. */
function at(offsetMs: number): string {
	const instant = new Date(Date.parse(START) + offsetMs);

	return instant.toISOString();
}

interface Status {
	id: string;
	status: string;
	timestamp: string;
	errors?: { code: number }[];
}

function statusesOf(request: CapturedRequest): Status[] {
	const body = JSON.parse(request.body) as { entry: [{ changes: [{ value: { statuses?: Status[] } }] }] };

	return body.entry[0].changes[0].value.statuses ?? [];
}

function allStatuses(capture: CaptureServer): Status[] {
	return capture.requests.flatMap(request => statusesOf(request));
}

async function post(fixture: TestApp, route: string, body?: unknown, headers: Record<string, string> = {}) {
	return fixture.app.request(route, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		...(body !== undefined && { body: JSON.stringify(body) }),
	});
}

async function advance(fixture: TestApp, by: string | number) {
	const response = await post(fixture, "/api/clock/advance", { by });

	expect(response.status).toBe(200);

	return clockMoveResponseSchema.parse(await response.json()).data;
}

async function clock(fixture: TestApp) {
	const response = await fixture.app.request("/api/clock");

	return clockResponseSchema.parse(await response.json()).data;
}

async function sendText(fixture: TestApp, body = "hello") {
	const response = await post(
		fixture,
		`/v25.0/${fixture.phoneNumberId}/messages`,
		{ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body } },
		TEST_AUTH_HEADERS,
	);
	const json = (await response.json()) as { messages?: [{ id: string }] };

	return { status: response.status, wamid: json.messages?.[0].id };
}

async function sendTemplate(fixture: TestApp) {
	const response = await post(
		fixture,
		`/v25.0/${fixture.phoneNumberId}/messages`,
		{
			messaging_product: "whatsapp",
			to: CONTACT,
			type: "template",
			template: { name: "hello_whaloc", language: { code: "en" } },
		},
		TEST_AUTH_HEADERS,
	);
	const json = (await response.json()) as { messages?: [{ id: string }] };

	return { status: response.status, wamid: json.messages?.[0].id };
}

async function inbound(fixture: TestApp, body = "hi") {
	const response = await post(fixture, "/api/inbound", {
		phoneNumberId: fixture.phoneNumberId,
		from: CONTACT,
		type: "text",
		text: { body },
	});

	expect(response.status).toBe(201);
}

describe("the real clock (the default)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	it("reports the wall clock and refuses to move", async () => {
		const before = Date.now();
		const state = await clock(fixture);

		expect(state).toMatchObject({ mode: "real", start: null, pending: null, deterministicIds: false });
		expect(Date.parse(state.now)).toBeGreaterThanOrEqual(before - 1000);

		for (const [route, body] of [
			["/api/clock/advance", { by: "5m" }],
			["/api/clock/set", { to: START }],
			["/api/clock/run-next", undefined],
		] as const) {
			const response = await post(fixture, route, body);

			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({ error: { code: "clock_not_virtual" } });
		}
	});
});

describe("the virtual clock", () => {
	let fixture: TestApp;
	let capture: CaptureServer;

	beforeEach(async () => {
		capture = await startCaptureServer();
		fixture = await createTestApp({
			MOCKWA_CLOCK: "virtual",
			MOCKWA_CLOCK_START: START,
			MOCKWA_WEBHOOK_URL: capture.url,
			MOCKWA_APP_SECRET: "clock-secret",
			// Timers on minute boundaries, so an advance can stop between them.
			MOCKWA_STATUS_DELAYS: "sent:0,delivered:60000,read:420000",
			MOCKWA_TEMPLATE_AUTO_APPROVE: "off",
		});
	});

	afterEach(async () => {
		await fixture.close();
		await capture.close();
	});

	it("starts at MOCKWA_CLOCK_START and stamps rows with virtual time", async () => {
		expect(await clock(fixture)).toMatchObject({ mode: "virtual", now: START, start: START, deterministicIds: true });

		await inbound(fixture);

		const [message] = await fixture.services.repositories.messages.listConversation({
			phoneNumberId: fixture.phoneNumberId,
			contactWaId: CONTACT,
			limit: 10,
		});

		expect(message?.createdAt).toBe(START);
	});

	it("AC-10: advancing five minutes fires exactly the events due, in order, with virtual timestamps", async () => {
		const first = await sendText(fixture, "first");

		await advance(fixture, "30s");

		const second = await sendText(fixture, "second");

		// The `sent` rungs ran on their own (a zero delay needs no advance) at the send instants.
		await advance(fixture, 0);
		expect(allStatuses(capture).map(status => [status.id, status.status, status.timestamp])).toEqual([
			[first.wamid, "sent", String(START_SECONDS)],
			[second.wamid, "sent", String(START_SECONDS + 30)],
		]);

		const move = await advance(fixture, "5m");

		// Due within (start+30s, start+5m30s]: both `delivered` rungs. The `read` rungs (7m after
		// each send) are not.
		expect(move.fired.map(event => [event.label, event.dueAt])).toEqual([
			[`status delivered ${first.wamid!}`, "2026-03-01T09:01:00.000Z"],
			[`status delivered ${second.wamid!}`, "2026-03-01T09:01:30.000Z"],
		]);
		expect(move.to).toBe("2026-03-01T09:05:30.000Z");
		expect(
			allStatuses(capture)
				.slice(2)
				.map(status => [status.id, status.status, status.timestamp]),
		).toEqual([
			[first.wamid, "delivered", String(START_SECONDS + 60)],
			[second.wamid, "delivered", String(START_SECONDS + 90)],
		]);
		expect(move.clock.pending?.map(event => [event.label, event.dueAt])).toEqual([
			[`status read ${first.wamid!}`, "2026-03-01T09:08:00.000Z"],
			[`status read ${second.wamid!}`, "2026-03-01T09:08:30.000Z"],
		]);
	});

	it("runs to the next event and stops there", async () => {
		const { wamid } = await sendText(fixture);

		await advance(fixture, 0);

		const response = await post(fixture, "/api/clock/run-next");
		const move = clockMoveResponseSchema.parse(await response.json()).data;

		expect(move.fired.map(event => event.label)).toEqual([`status delivered ${wamid!}`]);
		expect(move.to).toBe("2026-03-01T09:01:00.000Z");
	});

	it("sets the time forward like an advance, and refuses to go back", async () => {
		await sendText(fixture);

		const forward = await post(fixture, "/api/clock/set", { to: "2026-03-01T10:00:00+01:00" });

		expect(forward.status).toBe(200);
		expect(clockMoveResponseSchema.parse(await forward.json()).data.to).toBe(START);

		const later = await post(fixture, "/api/clock/set", { to: "2026-03-01T09:30:00Z" });

		expect(clockMoveResponseSchema.parse(await later.json()).data.fired).toHaveLength(2);

		const back = await post(fixture, "/api/clock/set", { to: START });

		expect(back.status).toBe(400);
		expect(await back.json()).toMatchObject({ error: { code: "clock_backwards" } });
	});

	it("validates its requests", async () => {
		for (const body of [{ by: "5 minutes" }, { by: -1 }, {}]) {
			const response = await post(fixture, "/api/clock/advance", body);

			expect(response.status).toBe(400);
		}

		const loose = await post(fixture, "/api/clock/set", { to: "2026-03-01 10:00" });

		expect(loose.status).toBe(400);
	});

	it("puts the clock back at its start and drops pending events on a reset", async () => {
		await sendText(fixture);
		await advance(fixture, "30s");
		const beforeReset = await clock(fixture);

		expect(beforeReset.pending).toHaveLength(1);

		const response = await post(fixture, "/api/reset");

		expect(response.status).toBe(200);
		expect(await clock(fixture)).toMatchObject({ now: START, pending: [] });

		// Nothing left over fires later.
		const before = capture.requests.length;

		await advance(fixture, "1h");
		expect(capture.requests).toHaveLength(before);
	});

	it("gives the same IDs, bytes and signatures after a reset, step for step", async () => {
		async function run() {
			await post(fixture, "/api/reset");
			capture.requests.length = 0;
			await inbound(fixture, "hi");

			const reply = await sendText(fixture, "hello back");

			await advance(fixture, "10m");

			const deliveries = await fixture.services.domain.webhooks.listDeliveries({ limit: 50 });

			return {
				wamid: reply.wamid,
				deliveries: capture.requests.map(request => {
					return {
						body: request.body,
						signature: request.headers["x-hub-signature-256"],
					};
				}),
				deliveryIds: deliveries.map(row => row.id),
			};
		}

		const first = await run();
		const second = await run();

		expect(first.deliveries.length).toBeGreaterThanOrEqual(4);
		expect(second).toEqual(first);
	});

	describe("the customer service window, over virtual time", () => {
		let windowed: TestApp;

		beforeEach(async () => {
			windowed = await createTestApp({
				MOCKWA_CLOCK: "virtual",
				MOCKWA_CLOCK_START: START,
				MOCKWA_SERVICE_WINDOW: "24h",
				MOCKWA_TEMPLATE_AUTO_APPROVE: "off",
			});
		});

		afterEach(async () => {
			await windowed.close();
		});

		async function outcome(
			sending: Promise<{ wamid: string | undefined }>,
		): Promise<{ status: string; code?: number }> {
			const { wamid } = await sending;

			await advance(windowed, 0);

			const message = await windowed.services.repositories.messages.findById(wamid!);

			const code = message?.error?.["code"];

			return { status: message!.status, ...(typeof code === "number" && { code }) };
		}

		it("is open before, closed at and after 24 hours; templates go regardless; an inbound reopens it", async () => {
			await inbound(windowed);

			await advance(windowed, DAY - 1);
			expect(await outcome(sendText(windowed, "one millisecond to go"))).toEqual({ status: "sent" });

			await advance(windowed, 1);
			expect(await outcome(sendText(windowed, "at the boundary"))).toEqual({
				status: "failed",
				code: 131_047,
			});

			await advance(windowed, HOUR);
			expect(await outcome(sendText(windowed, "an hour late"))).toEqual({
				status: "failed",
				code: 131_047,
			});
			expect(await outcome(sendTemplate(windowed))).toEqual({ status: "sent" });

			await inbound(windowed, "I'm back");
			expect(await outcome(sendText(windowed, "welcome back"))).toEqual({ status: "sent" });

			const response = await windowed.app.request(
				`/api/service-window?phoneNumberId=${windowed.phoneNumberId}&waId=${CONTACT}`,
			);
			const window = (await response.json()) as { data: { isOpen: boolean; expiresAt: string } };

			expect(window.data).toMatchObject({
				isOpen: true,
				expiresAt: at(2 * DAY + HOUR),
			});
		});
	});
});

describe("webhook retries on the virtual clock", () => {
	let capture: CaptureServer;
	let dir: string;
	let opened: TestApp[];

	beforeEach(async () => {
		capture = await startCaptureServer(() => ({ status: 500, body: "down" }));
		dir = await mkdtemp(path.join(tmpdir(), "mockwa-clock-"));
		opened = [];
	});

	afterEach(async () => {
		for (const fixture of opened) {
			await fixture.close();
		}

		await capture.close();
		await rm(dir, { recursive: true, force: true });
	});

	async function open(dbPath?: string): Promise<TestApp> {
		const fixture = await createTestApp(environment(dbPath));

		opened.push(fixture);

		return fixture;
	}

	function environment(dbPath = ":memory:"): Record<string, string> {
		return {
			MOCKWA_CLOCK: "virtual",
			MOCKWA_CLOCK_START: START,
			MOCKWA_DB_PATH: dbPath,
			MOCKWA_WEBHOOK_URL: capture.url,
			MOCKWA_APP_SECRET: "retry-secret",
		};
	}

	it("retries on the default schedule and gives up once the chain is seven days old", async () => {
		const fixture = await open();

		await inbound(fixture);

		const move = await advance(fixture, "8d");
		const attempts = capture.requests.map(request => request.body);
		const times = move.fired.filter(event => event.label === "webhook retry").map(event => event.dueAt);
		const offsets = times.map(time => Date.parse(time) - Date.parse(START));

		// 10s, 30s, 1m, 5m, 15m, 1h, 3h, 6h, 12h, 24h, then 24h until the chain is 7 days old.
		const steps = [10 * SECOND, 30 * SECOND, MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR];
		const expected: number[] = [];
		let offset = 0;

		for (const step of steps) {
			offset += step;
			expected.push(offset);
		}

		for (offset += DAY; offset <= 7 * DAY; offset += DAY) {
			expected.push(offset);
		}

		expect(offsets).toEqual(expected);
		// Every attempt resends the very same bytes and signature.
		const signatures = capture.requests.map(request => request.headers["x-hub-signature-256"]);

		expect(attempts.every(attempt => attempt === attempts[0])).toBe(true);
		expect(signatures.every(signature => signature === signatures[0])).toBe(true);
		expect(capture.requests).toHaveLength(expected.length + 1);

		const deliveries = await fixture.services.domain.webhooks.listDeliveries({ limit: 100 });

		expect(deliveries.every(delivery => delivery.nextAttemptAt === null)).toBe(true);
		expect(deliveries[0]?.createdAt).toBe(at(expected.at(-1)!));
		expect(move.clock.pending).toEqual([]);
	});

	it("keeps a pending retry and the clock's position across a restart", async () => {
		const dbPath = path.join(dir, "mockwa.db");
		const first = await open(dbPath);

		await inbound(first);
		await advance(first, "5s");
		const stopped = await clock(first);

		expect(stopped.pending?.map(event => [event.label, event.dueAt])).toEqual([
			["webhook retry", "2026-03-01T09:00:10.000Z"],
		]);
		await first.close();
		opened = opened.filter(fixture => fixture !== first);

		capture.respondWith(() => ({ status: 200, body: "ok" }));

		const second = await open(dbPath);

		// Resumed where it stood, not back at the start, and the retry still due at +10s.
		expect(await clock(second)).toMatchObject({
			now: "2026-03-01T09:00:05.000Z",
			pending: [{ label: "webhook retry", dueAt: "2026-03-01T09:00:10.000Z" }],
		});

		const move = await advance(second, "5s");

		expect(move.fired.map(event => event.label)).toEqual(["webhook retry"]);
		expect(capture.requests).toHaveLength(2);
		expect(capture.requests[1]?.rawBody.equals(capture.requests[0]!.rawBody)).toBe(true);

		const [latest] = await second.services.domain.webhooks.listDeliveries({ limit: 1 });

		expect(latest).toMatchObject({ attempt: 2, responseStatus: 200, createdAt: "2026-03-01T09:00:10.000Z" });

		// IDs minted after the restart do not repeat the ones before it.
		const before = await second.services.repositories.messages.listConversation({
			phoneNumberId: second.phoneNumberId,
			contactWaId: CONTACT,
			limit: 10,
		});

		await inbound(second, "again");

		const after = await second.services.repositories.messages.listConversation({
			phoneNumberId: second.phoneNumberId,
			contactWaId: CONTACT,
			limit: 10,
		});

		const distinct = new Set(after.map(message => message.id));

		expect(distinct.size).toBe(before.length + 1);
	});
});
