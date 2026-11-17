import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WsEvent } from "@mockwa/shared";
import { startCaptureServer, type CaptureServer } from "../testing/capture-server.ts";
import { createDomainHarness, createRecordingScheduler, type DomainHarness } from "../testing/domain-harness.ts";
import type { EventPublisher } from "./event-bus.ts";
import { isValidMetaSignature, SIGNATURE_HEADER } from "./meta-json.ts";
import { AppService } from "./app-service.ts";
import { SKIPPED_DELIVERY_ERROR, WebhookEmitter } from "./webhook-emitter.ts";
import { webhookEnvelope, WEBHOOK_FIELDS } from "./webhook-payloads.ts";

/**
 * The webhook engine against a real HTTP server (SPEC §3).
 *
 * Nothing is stubbed but the clock: the emitter's own `fetch` reaches a throwaway server that
 * keeps the raw bytes it received, which is what makes the signature assertions meaningful —
 * they compare the HMAC against the body that actually arrived.
 */
const APP_SECRET = "dev-meta-app-secret";
const VERIFY_TOKEN = "dev-verify-token";
/** Short and distinct, so each test can tell which step a due time came from. */
const RETRY_SCHEDULE_MS = [10_000, 30_000] as const;

describe("WebhookEmitter", () => {
	let harness: DomainHarness;
	let capture: CaptureServer;

	beforeEach(async () => {
		harness = await createDomainHarness();
		capture = await startCaptureServer();
	});

	afterEach(async () => {
		await capture.close();
		await harness.close();
	});

	function createEmitter(
		overrides: {
			url?: string | undefined;
			appSecret?: string | undefined;
			verifyToken?: string | undefined;
			events?: EventPublisher;
			retryScheduleMs?: readonly number[];
			retryMaxAgeMs?: number;
			scheduler?: ReturnType<typeof createRecordingScheduler>;
		} = {},
	) {
		const scheduler = overrides.scheduler ?? createRecordingScheduler();
		const emitter = new WebhookEmitter({
			repositories: harness.repositories,
			logger: harness.logger,
			target: {
				url: "url" in overrides ? overrides.url : capture.url,
				appSecret: "appSecret" in overrides ? overrides.appSecret : APP_SECRET,
				verifyToken: "verifyToken" in overrides ? overrides.verifyToken : VERIFY_TOKEN,
			},
			scheduler,
			retryScheduleMs: overrides.retryScheduleMs ?? RETRY_SCHEDULE_MS,
			...(overrides.retryMaxAgeMs !== undefined && { retryMaxAgeMs: overrides.retryMaxAgeMs }),
			...(overrides.events !== undefined && { events: overrides.events }),
		});

		return { emitter, scheduler };
	}

	function envelopeWith(value: Record<string, unknown>) {
		return webhookEnvelope({ wabaId: harness.wabaId, field: WEBHOOK_FIELDS.messages, value });
	}

	describe("delivery", () => {
		it("POSTs the payload with Meta's headers", async () => {
			const { emitter } = createEmitter();

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			const request = capture.requests[0]!;

			expect(request.method).toBe("POST");
			expect(request.headers["content-type"]).toBe("application/json");
			expect(request.headers["user-agent"]).toBe("facebookexternalua");
			expect(JSON.parse(request.body)).toMatchObject({ object: "whatsapp_business_account" });
		});

		it("signs exactly the bytes it sends, multibyte payloads included", async () => {
			const { emitter } = createEmitter();

			await emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messages: [{ text: { body: "Olá! 🍕 日本語 — ñ ü" } }] }),
			);

			const request = capture.requests[0]!;
			const signature = request.headers[SIGNATURE_HEADER]!;

			// The body that arrived is pure ASCII (everything above U+007F was escaped), so its
			// byte count and its character count agree — and the HMAC is over those same bytes.
			expect(request.rawBody.byteLength).toBe(request.body.length);
			// The emoji went out as its two escaped surrogate halves, never as raw UTF-8.
			expect(request.body).toMatch(/\\u[\da-f]{4}/);
			expect(request.body).not.toContain("🍕");
			expect(signature).toMatch(/^sha256=[\da-f]{64}$/);
			expect(isValidMetaSignature(signature, APP_SECRET, request.body)).toBe(true);
			expect(isValidMetaSignature(signature, APP_SECRET, request.rawBody.toString("utf8"))).toBe(true);
		});

		it("leaves the signature off when no app secret is configured", async () => {
			const { emitter } = createEmitter({ appSecret: undefined });

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(capture.requests[0]!.headers[SIGNATURE_HEADER]).toBeUndefined();
		});

		it("persists an attempt row with the request and the response", async () => {
			capture.respondWith(() => ({ status: 202, body: "EVENT_RECEIVED" }));

			const { emitter } = createEmitter();
			const [record] = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(record).toMatchObject({
				eventType: WEBHOOK_FIELDS.messages,
				url: capture.url,
				responseStatus: 202,
				responseBody: "EVENT_RECEIVED",
				error: null,
				attempt: 1,
			});
			expect(record!.requestBody).toBe(capture.requests[0]!.body);
			expect(record!.requestHeaders[SIGNATURE_HEADER]).toBe(capture.requests[0]!.headers[SIGNATURE_HEADER]);
			expect(record!.durationMs).toBeGreaterThanOrEqual(0);
			expect(await harness.repositories.webhookDeliveries.list()).toHaveLength(1);
		});

		it("announces every attempt on the event bus", async () => {
			const events: WsEvent[] = [];
			const { emitter } = createEmitter({
				events: {
					publish: event => {
						events.push(event);
					},
				},
			});

			await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(events).toHaveLength(1);
			expect(events[0]!.type).toBe("webhook.delivery");
		});
	});

	describe("retries (SPEC §3)", () => {
		/** Moves the clock and sends whatever became due, the way the timer would. */
		async function advance(
			setup: { emitter: WebhookEmitter; scheduler: ReturnType<typeof createRecordingScheduler> },
			ms: number,
		) {
			setup.scheduler.setNow(new Date(setup.scheduler.now().getTime() + ms));
			await setup.emitter.runDueRetries();
		}

		async function chain() {
			// The log is newest first; every test here starts exactly one chain.
			const rows = await harness.repositories.webhookDeliveries.list({ limit: 100 });

			return harness.repositories.webhookDeliveries.listChain(rows.at(-1)!.chainId);
		}

		it("retries anything but a 200 on the schedule, and stops once it gets one", async () => {
			capture.respondWith((_request, attempt) => {
				if (attempt === 1) {
					return { status: 500, body: "boom" };
				}

				// A 2xx that is not 200 is not Meta's success either.
				return attempt === 2 ? { status: 204, body: "" } : { status: 200, body: "ok" };
			});

			const setup = createEmitter();
			const startedAt = setup.scheduler.now().getTime();
			const [first] = await setup.emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messaging_product: "whatsapp" }),
			);

			expect(first).toMatchObject({ attempt: 1, responseStatus: 500 });
			const firstRetryAt = new Date(startedAt + 10_000);

			expect(first!.nextAttemptAt).toBe(firstRetryAt.toISOString());

			await advance(setup, 9999);
			expect(capture.requests).toHaveLength(1);

			await advance(setup, 1);
			await advance(setup, 30_000);

			const attempts = await chain();

			expect(attempts.map(row => [row.attempt, row.responseStatus])).toEqual([
				[1, 500],
				[2, 204],
				[3, 200],
			]);
			expect(attempts.map(row => row.chainId)).toEqual([first!.id, first!.id, first!.id]);
			expect(attempts.at(-1)!.nextAttemptAt).toBeNull();
			// A retry is the same request: same bytes, same signature.
			const bodies = new Set(capture.requests.map(request => request.body));
			const signatures = new Set(capture.requests.map(request => request.headers[SIGNATURE_HEADER]));

			expect(bodies.size).toBe(1);
			expect(signatures.size).toBe(1);
		});

		it("retries a 4xx as well: Meta only stops on a 200", async () => {
			capture.respondWith((_request, attempt) =>
				attempt === 1 ? { status: 403, body: "no" } : { status: 200, body: "ok" },
			);

			const setup = createEmitter();
			const [first] = await setup.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: 1 }));

			expect(first!.nextAttemptAt).not.toBeNull();

			await advance(setup, 10_000);

			expect(capture.requests).toHaveLength(2);
		});

		it("repeats the last step, then gives up once the chain would outlive its maximum age", async () => {
			capture.respondWith(() => ({ status: 503, body: "unavailable" }));

			const setup = createEmitter({ retryMaxAgeMs: 100_000 });

			await setup.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: 1 }));
			// 0 s, then +10 s, +30 s, +30 s (the last step repeats): 70 s. The next would be 100 s
			// after the first attempt plus 30 s, past the 100 s limit.
			for (let step = 0; step < 6; step += 1) {
				await advance(setup, 30_000);
			}

			const attempts = await chain();

			expect(attempts).toHaveLength(4);
			expect(attempts.at(-1)!.nextAttemptAt).toBeNull();
			expect(capture.requests).toHaveLength(4);
		});

		it("retries a network error and logs it on the row", async () => {
			await capture.close();

			const setup = createEmitter();
			const [first] = await setup.emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messaging_product: "whatsapp" }),
			);

			expect(first).toMatchObject({ responseStatus: null });
			expect(first!.error).toEqual(expect.any(String));
			expect(first!.nextAttemptAt).not.toBeNull();

			capture = await startCaptureServer();
		});

		it("makes a failure final when retries are off", async () => {
			capture.respondWith(() => ({ status: 500, body: "boom" }));

			const { emitter } = createEmitter({ retryScheduleMs: [] });
			const [first] = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: 1 }));

			expect(first!.nextAttemptAt).toBeNull();
		});

		it("picks the queue up again after a restart", async () => {
			capture.respondWith((_request, attempt) =>
				attempt === 1 ? { status: 500, body: "boom" } : { status: 200, body: "ok" },
			);

			const before = createEmitter();

			await before.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: 1 }));
			before.emitter.stop();

			// A new emitter over the same database is what a reboot with a file database is.
			const after = createEmitter({ scheduler: before.scheduler });

			before.scheduler.setNow(new Date(before.scheduler.now().getTime() + 60_000));
			await after.emitter.resumeRetries();
			await after.emitter.runDueRetries();

			expect(capture.requests).toHaveLength(2);
			const attempts = await chain();

			expect(attempts.at(-1)).toMatchObject({ attempt: 2, responseStatus: 200, nextAttemptAt: null });
		});

		it("cancels a chain's pending retry", async () => {
			capture.respondWith(() => ({ status: 500, body: "boom" }));

			const setup = createEmitter();
			const [first] = await setup.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: 1 }));
			const cancelled = await setup.emitter.cancelRetry(first!.id);

			await advance(setup, 60_000);

			expect(cancelled?.nextAttemptAt).toBeNull();
			expect(capture.requests).toHaveLength(1);
			expect(await setup.emitter.cancelRetry("nope")).toBeNull();
		});
	});

	describe("routing to apps (SPEC §3)", () => {
		let second: CaptureServer;

		beforeEach(async () => {
			second = await startCaptureServer();
		});

		afterEach(async () => {
			await second.close();
		});

		function routedEmitter() {
			const scheduler = createRecordingScheduler();
			const apps = new AppService({
				repositories: harness.repositories,
				defaultApp: { callbackUrl: capture.url, appSecret: APP_SECRET, verifyToken: VERIFY_TOKEN },
				scheduler,
			});
			const emitter = new WebhookEmitter({
				repositories: harness.repositories,
				logger: harness.logger,
				apps,
				scheduler,
				retryScheduleMs: [],
			});

			return { apps, emitter };
		}

		function statusEnvelope() {
			return webhookEnvelope({
				wabaId: harness.wabaId,
				field: WEBHOOK_FIELDS.messages,
				value: { messaging_product: "whatsapp", metadata: { phone_number_id: harness.phoneNumberId } },
			});
		}

		it("sends each subscribed app its own copy, signed with its own secret", async () => {
			const { apps, emitter } = routedEmitter();
			const other = await apps.create({ name: "Billing", callbackUrl: second.url, appSecret: "billing-secret" });

			await apps.subscribe(apps.defaultApp, harness.wabaId, null);
			await apps.subscribe(other, harness.wabaId, null);

			const records = await emitter.emit(WEBHOOK_FIELDS.messages, statusEnvelope());

			expect(records.map(record => record.appKey)).toEqual(["default", other.id]);
			expect(capture.requests).toHaveLength(1);
			expect(second.requests).toHaveLength(1);
			expect(second.requests[0]!.body).toBe(capture.requests[0]!.body);
			expect(
				isValidMetaSignature(capture.requests[0]!.headers[SIGNATURE_HEADER]!, APP_SECRET, capture.requests[0]!.body),
			).toBe(true);
			expect(
				isValidMetaSignature(
					second.requests[0]!.headers[SIGNATURE_HEADER]!,
					"billing-secret",
					second.requests[0]!.body,
				),
			).toBe(true);
		});

		it("leaves the unsubscribed default app out once a registered app subscribes", async () => {
			const { apps, emitter } = routedEmitter();
			const other = await apps.create({ name: "Billing", callbackUrl: second.url });

			await apps.subscribe(other, harness.wabaId, null);
			await emitter.emit(WEBHOOK_FIELDS.messages, statusEnvelope());

			expect(capture.requests).toHaveLength(0);
			expect(second.requests).toHaveLength(1);
		});

		it("follows Meta's order: the number's override, then the WABA's, then the app's URL", async () => {
			const { apps, emitter } = routedEmitter();
			const app = apps.defaultApp;

			await apps.subscribe(app, harness.wabaId, { callbackUri: `${second.url}/waba`, verifyToken: "w" });
			await emitter.emit(WEBHOOK_FIELDS.messages, statusEnvelope());
			await apps.setPhoneOverride(app, harness.phoneNumberId, { callbackUri: `${second.url}/phone`, verifyToken: "p" });
			await emitter.emit(WEBHOOK_FIELDS.messages, statusEnvelope());

			expect(second.requests.map(request => request.path.split("/").at(-1))).toEqual(["waba", "phone"]);
			expect(capture.requests).toHaveLength(0);
		});

		it("never overrides a template webhook: it goes to the app's own URL", async () => {
			const { apps, emitter } = routedEmitter();

			await apps.subscribe(apps.defaultApp, harness.wabaId, { callbackUri: second.url, verifyToken: "w" });
			await emitter.emit(
				WEBHOOK_FIELDS.templateStatus,
				webhookEnvelope({ wabaId: harness.wabaId, field: WEBHOOK_FIELDS.templateStatus, value: { event: "APPROVED" } }),
			);

			expect(capture.requests).toHaveLength(1);
			expect(second.requests).toHaveLength(0);
		});

		it("logs a skipped copy for a registered app without a callback URL", async () => {
			const { apps, emitter } = routedEmitter();
			const silent = await apps.create({ name: "Silent" });

			await apps.subscribe(silent, harness.wabaId, null);

			const [record] = await emitter.emit(WEBHOOK_FIELDS.messages, statusEnvelope());

			expect(record).toMatchObject({ url: "", appKey: silent.id });
			expect(record!.error).toContain("Silent");
		});
	});

	describe("without a webhook URL", () => {
		it("skips the delivery but still logs what it would have sent", async () => {
			const { emitter } = createEmitter({ url: undefined });
			const [record] = await emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ messaging_product: "whatsapp" }));

			expect(emitter.isConfigured).toBe(false);
			expect(record).toMatchObject({ url: "", responseStatus: null, error: SKIPPED_DELIVERY_ERROR, attempt: 1 });
			// The payload is the real one — and it is signed, so the UI can show what a
			// receiver would have had to verify.
			expect(JSON.parse(record!.requestBody)).toMatchObject({ object: "whatsapp_business_account" });
			expect(record!.requestHeaders[SIGNATURE_HEADER]).toMatch(/^sha256=/);
			expect(capture.requests).toHaveLength(0);
		});
	});

	describe("redeliver", () => {
		it("replays the stored body as a new chain", async () => {
			const { emitter } = createEmitter();
			const [original] = await emitter.emit(
				WEBHOOK_FIELDS.messages,
				envelopeWith({ messages: [{ text: { body: "olá" } }] }),
			);

			const replayed = await emitter.redeliver(original!.id);

			expect(replayed).toHaveLength(1);
			expect(replayed![0]!.id).not.toBe(original!.id);
			expect(replayed![0]!.requestBody).toBe(original!.requestBody);
			expect(capture.requests).toHaveLength(2);
			expect(capture.requests[1]!.body).toBe(capture.requests[0]!.body);
		});

		it("signs the replay again, so a body captured while unsigned goes out signed", async () => {
			const unsigned = createEmitter({ appSecret: undefined });
			const [original] = await unsigned.emitter.emit(WEBHOOK_FIELDS.messages, envelopeWith({ a: "b" }));
			const signed = createEmitter();

			await signed.emitter.redeliver(original!.id);

			const replay = capture.requests.at(-1)!;

			expect(isValidMetaSignature(replay.headers[SIGNATURE_HEADER]!, APP_SECRET, replay.body)).toBe(true);
		});

		it("reports an unknown delivery id", async () => {
			const { emitter } = createEmitter();

			expect(await emitter.redeliver("nope")).toBeNull();
		});
	});

	describe("handshake", () => {
		it("echoes the challenge back", async () => {
			capture.respondWith(request => ({ status: 200, body: request.query.get("hub.challenge") ?? "" }));

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result.ok).toBe(true);
			expect(result.status).toBe(200);
			expect(result.echo).toBe(result.challenge);
			expect(emitter.lastHandshake).toEqual(result);

			const request = capture.requests[0]!;

			expect(request.method).toBe("GET");
			expect(request.query.get("hub.mode")).toBe("subscribe");
			expect(request.query.get("hub.verify_token")).toBe(VERIFY_TOKEN);
			expect(request.query.get("hub.challenge")).toBe(result.challenge);
		});

		it("fails when the receiver echoes something else", async () => {
			capture.respondWith(() => ({ status: 200, body: "not-the-challenge" }));

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result).toMatchObject({ ok: false, status: 200, echo: "not-the-challenge" });
			expect(result.error).toBe("the receiver did not echo the challenge");
		});

		it("fails on a 403, the way a wrong verify token answers", async () => {
			capture.respondWith(() => ({ status: 403, body: "" }));

			const { emitter } = createEmitter();

			expect(await emitter.handshake()).toMatchObject({ ok: false, status: 403 });
		});

		it("fails without ever leaving the process when nothing is configured", async () => {
			const { emitter } = createEmitter({ url: undefined });

			expect(await emitter.handshake()).toMatchObject({ ok: false, error: "MOCKWA_WEBHOOK_URL is not set" });

			const { emitter: tokenless } = createEmitter({ verifyToken: undefined });

			expect(await tokenless.handshake()).toMatchObject({
				ok: false,
				error: "MOCKWA_WEBHOOK_VERIFY_TOKEN is not set",
			});
			expect(capture.requests).toHaveLength(0);
		});

		it("reports a receiver that is not up", async () => {
			await capture.close();

			const { emitter } = createEmitter();
			const result = await emitter.handshake();

			expect(result.ok).toBe(false);
			expect(result.status).toBeNull();
			expect(result.error).toEqual(expect.any(String));

			capture = await startCaptureServer();
		});
	});

	describe("emit", () => {
		it("never rejects, whatever the receiver does", async () => {
			const { emitter } = createEmitter();
			const failing = vi.fn().mockRejectedValue(new Error("boom"));
			const broken = new WebhookEmitter({
				repositories: harness.repositories,
				logger: harness.logger,
				target: { url: capture.url },
				scheduler: createRecordingScheduler(),
				fetch: failing,
				retryScheduleMs: [],
			});

			await expect(broken.emit("raw", { a: 1 })).resolves.toHaveLength(1);
			await expect(emitter.emitRaw({ a: 1 })).resolves.toHaveLength(1);
			expect(capture.requests.at(-1)!.body).toBe('{"a":1}');
		});

		it("lists deliveries newest first", async () => {
			const { emitter } = createEmitter();

			await emitter.emitRaw({ first: true });
			await emitter.emitRaw({ second: true });

			const deliveries = await emitter.listDeliveries({ limit: 10 });

			expect(deliveries).toHaveLength(2);
			expect(JSON.parse(deliveries[0]!.requestBody)).toEqual({ second: true });
		});
	});
});
