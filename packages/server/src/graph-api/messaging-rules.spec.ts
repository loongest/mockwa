import { injectionRuleResponseSchema, messagingRulesResponseSchema, serviceWindowResponseSchema } from "@mockwa/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { MessageRecord } from "../db/index.ts";
import { createRecordingScheduler, type RecordingScheduler } from "../testing/domain-harness.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The messaging rules, end to end through the Graph surface (SPEC §4, "Messaging rules"): the
 * customer service window, throughput, the pair rate limit, the messaging limit and the
 * `messages.status` injection rules. Time is the recording scheduler's, moved by hand, so every
 * boundary is hit exactly rather than waited for.
 */

/** Seeded contacts (`DEFAULT_SEED`). */
const ANA = "5571990000001";
const BRUNO = "5571990000002";
const START = new Date("2026-06-12T12:00:00.000Z");
const DAY_MS = 86_400_000;

describe("messaging rules (SPEC §4)", () => {
	let fixture: TestApp;
	let scheduler: RecordingScheduler;

	afterEach(async () => {
		await fixture.close();
	});

	async function boot(env: Record<string, string> = {}): Promise<void> {
		scheduler = createRecordingScheduler(START);
		fixture = await createTestApp({ MOCKWA_SERVICE_WINDOW: "24h", ...env }, { scheduler });
	}

	function at(offsetMs: number): void {
		scheduler.setNow(new Date(START.getTime() + offsetMs));
	}

	function send(body: Record<string, unknown>): Promise<Response> {
		return Promise.resolve(
			fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
				body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
			}),
		);
	}

	function sendText(to: string, text = "hello"): Promise<Response> {
		return send({ to, type: "text", text: { body: text } });
	}

	function sendTemplate(to: string): Promise<Response> {
		return send({ to, type: "template", template: { name: "hello_whaloc", language: { code: "en" } } });
	}

	async function receive(from: string, timestamp?: string): Promise<void> {
		const response = await fixture.app.request("/api/inbound", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				phoneNumberId: fixture.phoneNumberId,
				from,
				type: "text",
				text: { body: "hi" },
				...(timestamp !== undefined && { timestamp }),
			}),
		});

		expect(response.status).toBe(201);
	}

	/**
	 * The stored message once the ladder's first rung (or the failure in its place) has run. The
	 * recording scheduler runs every timer on the next tick, so a send that is not failed has
	 * usually climbed to `delivered` by then: the specs ask "failed or not".
	 */
	async function settled(response: Response): Promise<MessageRecord> {
		expect(response.status).toBe(200);

		const body = (await jsonOf(response)) as { messages: [{ id: string }] };
		const id = body.messages[0].id;

		await expect
			.poll(async () => {
				const stored = await fixture.services.repositories.messages.findById(id);

				return stored?.status;
			})
			.not.toBe("accepted");
		await fixture.services.domain.tasks.whenIdle();

		const message = await fixture.services.repositories.messages.findById(id);

		expect(message).not.toBeNull();

		return message!;
	}

	async function httpStatus(response: Promise<Response> | Response): Promise<number> {
		const resolved = await response;

		return resolved.status;
	}

	async function jsonOf(response: Promise<Response> | Response): Promise<unknown> {
		const resolved = await response;

		return resolved.json();
	}

	async function statusAfter(response: Promise<Response>): Promise<string> {
		const message = await settled(await response);

		return message.status;
	}

	async function errorAfter(response: Promise<Response>): Promise<unknown> {
		const message = await settled(await response);

		return message.error;
	}

	async function isBusinessInitiatedAfter(response: Promise<Response>): Promise<boolean> {
		const message = await settled(await response);

		return message.isBusinessInitiated;
	}

	async function serviceWindow(waId: string) {
		const response = await fixture.app.request(
			`/api/service-window?phoneNumberId=${fixture.phoneNumberId}&waId=${waId}`,
		);

		expect(response.status).toBe(200);

		const { data } = serviceWindowResponseSchema.parse(await jsonOf(response));

		return data;
	}

	describe("the customer service window", () => {
		it("fails a free-form message to someone who never wrote with 131047, after accepting it", async () => {
			await boot();

			const message = await settled(await sendText(ANA));

			expect(message.status).toBe("failed");
			expect(message.error).toMatchObject({
				code: 131_047,
				title: "Re-engagement message",
				error_data: {
					details: "More than 24 hours have passed since the recipient last replied to the sender number.",
				},
			});
		});

		it("lets a free-form message through one millisecond before the 24 hours run out", async () => {
			await boot();
			await receive(ANA);
			at(DAY_MS - 1);

			expect(await statusAfter(sendText(ANA))).not.toBe("failed");
		});

		it("closes the window at exactly 24 hours after the contact's last message", async () => {
			await boot();
			await receive(ANA);
			at(DAY_MS);

			const message = await settled(await sendText(ANA));

			expect(message.status).toBe("failed");
			expect(message.error).toMatchObject({ code: 131_047 });
		});

		it("restarts the 24 hours on every message from the contact", async () => {
			await boot();
			await receive(ANA);
			at(20 * 3_600_000);
			await receive(ANA);
			at(30 * 3_600_000);

			expect(await statusAfter(sendText(ANA))).not.toBe("failed");
		});

		it("is kept per contact: one contact writing opens nothing for another", async () => {
			await boot();
			await receive(ANA);

			expect(await statusAfter(sendText(BRUNO))).toBe("failed");
		});

		it("counts a caller-supplied inbound timestamp, written with or without milliseconds", async () => {
			await boot();
			await receive(ANA, "2026-06-11T12:00:01Z");
			await receive(ANA, "2026-06-11T12:00:00.500Z");

			expect(await serviceWindow(ANA)).toMatchObject({
				isOpen: true,
				lastInboundAt: "2026-06-11T12:00:01.000Z",
				expiresAt: "2026-06-12T12:00:01.000Z",
			});
		});

		it("lets an approved template through outside the window, as a business-initiated send", async () => {
			await boot();

			const message = await settled(await sendTemplate(ANA));

			expect(message.status).not.toBe("failed");
			expect(message.isBusinessInitiated).toBe(true);
		});

		it("does not count a template inside the window as business-initiated", async () => {
			await boot();
			await receive(ANA);

			expect(await isBusinessInitiatedAfter(sendTemplate(ANA))).toBe(false);
		});

		it("reports the window through the control plane", async () => {
			await boot();

			expect(await serviceWindow(ANA)).toEqual({
				phoneNumberId: fixture.phoneNumberId,
				waId: ANA,
				isEnforced: true,
				isOpen: false,
				lastInboundAt: null,
				expiresAt: null,
				windowMs: DAY_MS,
			});

			await receive(ANA);

			expect(await serviceWindow(ANA)).toMatchObject({
				isOpen: true,
				lastInboundAt: START.toISOString(),
				expiresAt: "2026-06-13T12:00:00.000Z",
			});
		});

		it("follows a shorter configured window", async () => {
			await boot({ MOCKWA_SERVICE_WINDOW: "30s" });
			await receive(ANA);
			at(29_999);

			expect(await statusAfter(sendText(ANA))).not.toBe("failed");

			at(30_000);

			expect(await statusAfter(sendText(ANA))).toBe("failed");
		});

		it("enforces nothing with MOCKWA_SERVICE_WINDOW=off, but still reports the window", async () => {
			await boot({ MOCKWA_SERVICE_WINDOW: "off" });

			expect(await statusAfter(sendText(ANA))).not.toBe("failed");
			expect(await serviceWindow(ANA)).toMatchObject({ isEnforced: false, isOpen: false, windowMs: DAY_MS });
		});
	});

	describe("throughput (130429)", () => {
		it("refuses the send past the configured rate in one second, and admits it in the next", async () => {
			await boot({ MOCKWA_THROUGHPUT: "2", MOCKWA_SERVICE_WINDOW: "off" });

			expect(await httpStatus(sendText(ANA))).toBe(200);
			expect(await httpStatus(sendText(BRUNO))).toBe(200);

			const refused = await sendText(ANA);

			expect(refused.status).toBe(429);
			expect(refused.headers.get("retry-after")).toBe("1");
			expect(await refused.json()).toMatchObject({
				error: { code: 130_429, message: "(#130429) Rate limit hit", type: "OAuthException" },
			});

			at(999);

			expect(await httpStatus(sendText(ANA))).toBe(429);

			at(1000);

			expect(await httpStatus(sendText(ANA))).toBe(200);
		});

		it("uses Meta's 80 per second for a STANDARD number with MOCKWA_THROUGHPUT=meta", async () => {
			await boot({ MOCKWA_THROUGHPUT: "meta", MOCKWA_SERVICE_WINDOW: "off" });

			const statuses: number[] = [];

			for (let index = 0; index < 81; index += 1) {
				statuses.push(await httpStatus(sendText(index % 2 === 0 ? ANA : BRUNO)));
			}

			expect(statuses.filter(status => status === 200)).toHaveLength(80);
			expect(statuses.at(-1)).toBe(429);
		});

		it("leaves a refused send off the record: no message, no contact", async () => {
			await boot({ MOCKWA_THROUGHPUT: "1", MOCKWA_SERVICE_WINDOW: "off" });
			await sendText(ANA);

			expect(await httpStatus(sendText("5511900000099"))).toBe(429);
			expect(await fixture.services.repositories.contacts.findByWaId("5511900000099")).toBeNull();
		});
	});

	describe("the pair rate limit (131056)", () => {
		it("allows a burst, refuses the next send to that contact, and recovers one interval later", async () => {
			await boot({ MOCKWA_PAIR_RATE_LIMIT: "2s/3", MOCKWA_SERVICE_WINDOW: "off" });

			for (let index = 0; index < 3; index += 1) {
				expect(await httpStatus(sendText(ANA))).toBe(200);
			}

			const refused = await sendText(ANA);

			expect(refused.status).toBe(400);
			expect(refused.headers.get("retry-after")).toBeNull();
			expect(await refused.json()).toMatchObject({
				error: { code: 131_056, message: "(#131056) (Business Account, Consumer account) pair rate limit hit" },
			});

			// Another contact is a different pair.
			expect(await httpStatus(sendText(BRUNO))).toBe(200);

			at(1999);

			expect(await httpStatus(sendText(ANA))).toBe(400);

			at(2000);

			expect(await httpStatus(sendText(ANA))).toBe(200);
		});

		it("does not spend a throughput slot on a send it refuses", async () => {
			await boot({ MOCKWA_PAIR_RATE_LIMIT: "6s/1", MOCKWA_THROUGHPUT: "2", MOCKWA_SERVICE_WINDOW: "off" });

			expect(await httpStatus(sendText(ANA))).toBe(200);
			expect(await httpStatus(sendText(ANA))).toBe(400);
			expect(await httpStatus(sendText(BRUNO))).toBe(200);
		});
	});

	describe("the messaging limit (simulated 990001)", () => {
		it("counts unique contacts reached by business-initiated sends over a moving 24 hours", async () => {
			await boot({ MOCKWA_MESSAGING_LIMIT: "1" });

			expect(await statusAfter(sendTemplate(ANA))).not.toBe("failed");
			// The same contact again is not a new user.
			expect(await statusAfter(sendTemplate(ANA))).not.toBe("failed");

			const over = await settled(await sendTemplate(BRUNO));

			expect(over.status).toBe("failed");
			// Meta documents no code for this, so mockwa's own says it is mockwa's (SPEC §4).
			expect(over.error).toEqual({
				code: 990_001,
				title: "[mockwa] Messaging limit reached (simulated)",
				message: "[mockwa] Messaging limit reached (simulated)",
				error_data: { details: expect.stringContaining("Simulated by mockwa") as unknown },
				href: "/documentation/business-messaging/whatsapp/messaging-limits",
			});
			expect(over.isBusinessInitiated).toBe(false);

			at(DAY_MS);

			expect(await statusAfter(sendTemplate(BRUNO))).not.toBe("failed");
		});

		it("does not count a template sent inside the window", async () => {
			await boot({ MOCKWA_MESSAGING_LIMIT: "1" });
			await receive(BRUNO);

			expect(await statusAfter(sendTemplate(ANA))).not.toBe("failed");
			expect(await statusAfter(sendTemplate(BRUNO))).not.toBe("failed");
		});

		it("reports the configuration and each WABA's count", async () => {
			await boot({ MOCKWA_MESSAGING_LIMIT: "250", MOCKWA_THROUGHPUT: "meta", MOCKWA_PAIR_RATE_LIMIT: "meta" });
			await settled(await sendTemplate(ANA));

			const response = await fixture.app.request("/api/messaging-rules");
			const { data } = messagingRulesResponseSchema.parse(await response.json());

			expect(data).toEqual({
				serviceWindowMs: DAY_MS,
				throughput: "meta",
				pairRateLimit: { intervalMs: 6000, burst: 45 },
				messagingLimit: 250,
				usage: [{ wabaId: fixture.wabaId, limit: 250, used: 1 }],
			});
		});
	});

	describe("messages.status injection rules", () => {
		async function armStatusRule(body: Record<string, unknown>): Promise<Response> {
			return fixture.app.request("/api/injection-rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ target: "messages.status", preset: "failed_status", ...body }),
			});
		}

		it("accepts the send and fails its status webhook with the rule's code, as many times as armed", async () => {
			await boot({ MOCKWA_SERVICE_WINDOW: "off" });

			expect(await httpStatus(armStatusRule({ trigger: { kind: "next", count: 1 }, errorCode: 131_026 }))).toBe(201);

			const failed = await settled(await sendText(ANA));

			expect(failed.status).toBe("failed");
			expect(failed.error).toMatchObject({ code: 131_026, title: "Message undeliverable" });
			expect(await statusAfter(sendText(ANA))).not.toBe("failed");
		});

		it("fires on every Nth accepted send only", async () => {
			await boot({ MOCKWA_SERVICE_WINDOW: "off" });
			await armStatusRule({ trigger: { kind: "every", nth: 2 }, errorCode: 131_049 });

			const failed: boolean[] = [];

			for (let index = 0; index < 4; index += 1) {
				const status = await statusAfter(sendText(ANA));

				failed.push(status === "failed");
			}

			expect(failed).toEqual([false, true, false, true]);
		});

		it("leaves its countdown alone for a send the window already failed", async () => {
			await boot();

			const { data: created } = injectionRuleResponseSchema.parse(
				await jsonOf(armStatusRule({ trigger: { kind: "next", count: 1 }, errorCode: 131_026 })),
			);

			expect(await errorAfter(sendText(ANA))).toMatchObject({ code: 131_047 });
			expect(await fixture.services.repositories.injectionRules.findById(created.id)).toMatchObject({
				seen: 0,
				remaining: 1,
			});
		});

		it("never touches a Graph request, not even through graph.all", async () => {
			await boot({ MOCKWA_SERVICE_WINDOW: "off" });
			await armStatusRule({ trigger: { kind: "always" }, errorCode: 131_026 });

			expect(await httpStatus(sendText(ANA))).toBe(200);
			expect(
				await httpStatus(fixture.app.request(`/v25.0/${fixture.phoneNumberId}`, { headers: TEST_AUTH_HEADERS })),
			).toBe(200);
		});

		it("refuses a messages.status rule without failed_status, and failed_status anywhere else", async () => {
			await boot();

			expect(await httpStatus(armStatusRule({ preset: "rate_limit_429", trigger: { kind: "always" } }))).toBe(400);
			expect(await httpStatus(armStatusRule({ trigger: { kind: "always" } }))).toBe(400);

			const elsewhere = await fixture.app.request("/api/injection-rules", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					target: "messages.send",
					preset: "failed_status",
					errorCode: 131_026,
					trigger: { kind: "always" },
				}),
			});

			expect(elsewhere.status).toBe(400);
		});
	});

	it("starts the throughput and pair-rate counts afresh on POST /api/reset", async () => {
		await boot({ MOCKWA_PAIR_RATE_LIMIT: "1m/1", MOCKWA_SERVICE_WINDOW: "off" });

		expect(await httpStatus(sendText(ANA))).toBe(200);
		expect(await httpStatus(sendText(ANA))).toBe(400);
		expect(await httpStatus(fixture.app.request("/api/reset", { method: "POST" }))).toBe(200);
		expect(await httpStatus(sendText(ANA))).toBe(200);
	});
});
