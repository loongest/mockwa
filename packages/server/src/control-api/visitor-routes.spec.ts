import {
	conversationMessagesResponseSchema,
	inboundMediaResponseSchema,
	inboundResponseSchema,
	mediaResponseSchema,
	phoneChatListResponseSchema,
	phoneIdentityListResponseSchema,
} from "@mockwa/shared";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jsonOf, readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, type TestApp } from "../testing/test-app.ts";
import {
	ADMIN_HEADERS,
	createMovableScheduler,
	fromAddress,
	PUBLIC_ENV,
	TEST_GRAPH_TOKEN,
	TestVisitor,
	type MovableScheduler,
} from "../testing/visitor-client.ts";

/**
 * Public demo mode on the console listener (SPEC §5 "Public demo mode", §7 "Access modes"):
 * visitor sessions, the isolation between them (AC-15), the admin surface (AC-16) and the
 * limits and cleanup (AC-17), driven through `app.request()` like a browser would.
 */

/** A PNG's signature followed by filler: enough for the type check, which reads the first bytes. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

function pngForm(bytes: Uint8Array = PNG_BYTES, type = "image/png"): FormData {
	const form = new FormData();

	form.set("file", new Blob([bytes], { type }), "photo.png");

	return form;
}

describe("public mode", () => {
	let fixture: TestApp;
	let scheduler: MovableScheduler;

	async function boot(env: Record<string, string> = {}): Promise<void> {
		scheduler = createMovableScheduler();
		fixture = await createTestApp({ ...PUBLIC_ENV, ...env }, { scheduler });
	}

	afterEach(async () => {
		await fixture.close();
	});

	function visitor(address?: string): TestVisitor {
		return new TestVisitor(fixture.consoleApp, address);
	}

	/** What the app under test does: a Graph send from the business, with its registered token. */
	async function businessSends(to: string, text: string): Promise<Response> {
		return fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
		});
	}

	async function uploadPng(who: TestVisitor, waId = who.waId): Promise<string> {
		const response = await who.request(`${who.chatPath(fixture.phoneNumberId, waId)}/media`, { form: pngForm() });

		expect(response.status).toBe(201);

		return inboundMediaResponseSchema.parse(await response.json()).data.id;
	}

	describe("sessions", () => {
		beforeEach(async () => {
			await boot();
		});

		it("gives a new visitor fresh identities from the template, in an HttpOnly SameSite cookie", async () => {
			const ana = visitor();
			const response = await ana.request("/api/public/session", { method: "POST" });

			expect(response.status).toBe(201);

			const cookie = response.headers.getSetCookie().find(header => header.startsWith("mockwa_visitor="));

			expect(cookie).toMatch(/HttpOnly/);
			expect(cookie).toMatch(/SameSite=Strict/);
			expect(cookie).toMatch(/Path=\//);
			// Plain HTTP under MOCKWA_COOKIE_SECURE=auto: a Secure cookie would never come back.
			expect(cookie).not.toMatch(/Secure/);

			const { data: session } = await readJson<{ data: { identities: { waId: string; role: string }[] } }>(response);

			expect(session.identities.map(identity => identity.role)).toEqual(["CUSTOMER", "TECHNICIAN"]);

			for (const identity of session.identities) {
				expect(identity.waId).toMatch(/^999\d{12}$/);
			}
		});

		it("never hands two visitors the same number, and never a seeded one", async () => {
			const numbers = new Set<string>();

			for (let index = 0; index < 3; index += 1) {
				const session = await visitor(`198.51.100.${String(20 + index)}`).start();

				for (const identity of session.identities) {
					numbers.add(identity.waId);
				}
			}

			expect(numbers.size).toBe(6);
			expect(numbers.has("5571990000001")).toBe(false);
		});

		it("answers the same identities to a browser that already has a session", async () => {
			const ana = visitor();
			const first = await ana.start();
			const again = await ana.request("/api/public/session", { method: "POST" });

			expect(again.status).toBe(200);
			const againBody = await readJson<{ data: { identities: unknown } }>(again);

			expect(againBody.data.identities).toEqual(first.identities);

			const read = await ana.request("/api/public/session");

			expect(read.status).toBe(200);
		});

		it("says whether a session is missing or has ended", async () => {
			const nobody = visitor();
			const missing = await nobody.request("/api/public/session");

			expect(missing.status).toBe(401);
			const missingBody = await readJson<{ error: { code: string } }>(missing);

			expect(missingBody.error.code).toBe("session_required");

			nobody.cookie = "forged-or-expired";

			const ended = await nobody.request("/api/public/session");

			expect(ended.status).toBe(401);
			const endedBody = await readJson<{ error: { code: string } }>(ended);

			expect(endedBody.error.code).toBe("session_expired");
		});

		it("refuses to start a session from another origin", async () => {
			const response = await visitor().request("/api/public/session", {
				method: "POST",
				origin: "https://evil.example",
			});

			expect(response.status).toBe(403);
		});

		it("refuses a write without the session's CSRF token or from another origin", async () => {
			const ana = visitor();

			await ana.start();

			const withoutToken = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "text", text: { body: "hi" } },
				withoutCsrf: true,
			});
			const crossOrigin = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "text", text: { body: "hi" } },
				origin: "https://evil.example",
			});

			expect(withoutToken.status).toBe(403);
			expect(crossOrigin.status).toBe(403);
			const withoutTokenBody = await readJson<{ error: { code: string } }>(withoutToken);

			expect(withoutTokenBody.error.code).toBe("csrf_failed");
		});

		it("lets a visitor leave: the session and everything it owned are gone", async () => {
			const ana = visitor();

			await ana.start();
			expect(await statusOf(ana.sendText(fixture.phoneNumberId, "bye"))).toBe(201);

			const left = await ana.request("/api/public/session", { method: "DELETE" });

			expect(left.status).toBe(204);
			expect(ana.cookie).toBeUndefined();
			expect(await fixture.services.repositories.contacts.findByWaId(ana.waId)).toBeNull();
		});

		it("ends every session on a reset, and the admin's reset needs the admin token", async () => {
			const ana = visitor();

			await ana.start();
			expect(await statusOf(fixture.consoleApp.request("/api/reset", { method: "POST" }))).toBe(401);
			expect(await statusOf(fixture.consoleApp.request("/api/reset", { method: "POST", headers: ADMIN_HEADERS }))).toBe(
				200,
			);
			await expect.poll(async () => await statusOf(ana.request("/api/public/session"))).toBe(401);
		});
	});

	describe("the phone, as a visitor", () => {
		beforeEach(async () => {
			await boot({ MOCKWA_STATUS_DELAYS: "sent:0,delivered:0" });
		});

		it("lists only the session's identities, and chats with the business end to end", async () => {
			const ana = visitor();

			await ana.start();

			const identities = phoneIdentityListResponseSchema.parse(await jsonOf(ana.request("/api/phone/identities"))).data;

			expect(identities.map(identity => identity.waId)).toEqual(ana.identities.map(identity => identity.waId));

			const sent = await ana.sendText(fixture.phoneNumberId, "hello business");

			expect(sent.status).toBe(201);
			expect(await statusOf(businessSends(ana.waId, "hello visitor"))).toBe(200);

			const anaChat = ana.chatPath(fixture.phoneNumberId);

			const history = conversationMessagesResponseSchema.parse(await jsonOf(ana.request(`${anaChat}/messages`))).data;

			expect(history.map(message => message.direction)).toEqual(["inbound", "outbound"]);
			// The app's own bookkeeping never reaches a visitor's browser.
			expect(history.every(message => message.bizOpaqueCallbackData === undefined)).toBe(true);

			const chats = phoneChatListResponseSchema.parse(
				await jsonOf(ana.request(`/api/phone/identities/${ana.waId}/chats`)),
			).data;

			expect(chats[0]?.phoneNumberId).toBe(fixture.phoneNumberId);
		});

		it("ignores the developer-only fields a visitor sends, and refuses the message types it may not", async () => {
			const ana = visitor();

			await ana.start();

			const sent = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: {
					type: "text",
					text: { body: "backdated?" },
					timestamp: "2000-01-01T00:00:00.000Z",
					profileName: "Somebody else",
					from: "5571990000001",
					phoneNumberId: "1",
				},
			});

			expect(sent.status).toBe(201);

			const message = inboundResponseSchema.parse(await sent.json()).data;

			expect(message.contactWaId).toBe(ana.waId);
			expect(message.phoneNumberId).toBe(fixture.phoneNumberId);
			expect(message.timestamp.startsWith("2000")).toBe(false);
			const customer = await fixture.services.repositories.contacts.findByWaId(ana.waId);

			expect(customer?.profileName).toBe("Demo customer");

			const contacts = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "contacts", contacts: [{ name: { formatted_name: "X" } }] },
			});

			expect(contacts.status).toBe(400);
		});

		it("uploads an image, sends it, and reads it back through the console origin", async () => {
			const ana = visitor();

			await ana.start();

			const mediaId = await uploadPng(ana);
			const sent = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "image", media: { id: mediaId } },
			});

			expect(sent.status).toBe(201);

			const descriptor = mediaResponseSchema.parse(
				await jsonOf(ana.request(`/api/phone/identities/${ana.waId}/media/${mediaId}`)),
			).data;

			// A path on this origin, never the Graph host MOCKWA_PUBLIC_URL names.
			expect(descriptor.url).toMatch(/^\/whaloc-media\//);

			const bytes = await ana.request(descriptor.url);

			expect(bytes.status).toBe(200);
			expect(bytes.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
			expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG_BYTES);
		});

		it("refuses a file whose bytes are not the type it claims", async () => {
			const ana = visitor();

			await ana.start();

			const html = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/media`, {
				form: pngForm(Buffer.from("<script>alert(1)</script>"), "image/png"),
			});
			const svg = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/media`, {
				form: pngForm(Buffer.from("<svg/>"), "image/svg+xml"),
			});

			expect(html.status).toBe(415);
			expect(svg.status).toBe(415);
		});
	});

	describe("isolation between visitors (AC-15)", () => {
		let ana: TestVisitor;
		let bruno: TestVisitor;
		let brunoMessageId: string;
		let brunoMediaId: string;

		beforeEach(async () => {
			await boot({ MOCKWA_STATUS_DELAYS: "sent:0,delivered:0" });
			ana = visitor("198.51.100.1");
			bruno = visitor("198.51.100.2");
			await ana.start();
			await bruno.start();

			brunoMediaId = await uploadPng(bruno);

			const sent = await bruno.request(`${bruno.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "image", media: { id: brunoMediaId } },
			});

			brunoMessageId = inboundResponseSchema.parse(await sent.json()).data.id;
		});

		it("answers 404 on every phone route that names another visitor's identity", async () => {
			const theirs = bruno.waId;
			const chat = ana.chatPath(fixture.phoneNumberId, theirs);
			const attempts: [string, Parameters<TestVisitor["request"]>[1]][] = [
				[`/api/phone/identities/${theirs}/chats`, {}],
				[`${chat}/messages`, {}],
				[`${chat}/messages`, { body: { type: "text", text: { body: "impersonating" } } }],
				[`${chat}/read`, { method: "POST" }],
				[`${chat}/media`, { form: pngForm() }],
				[`/api/phone/identities/${theirs}/media/${brunoMediaId}`, {}],
				[`/api/phone/identities/${theirs}/ws`, {}],
			];

			for (const [path, init] of attempts) {
				const response = await ana.request(path, init);

				expect({ path, status: response.status }).toEqual({ path, status: 404 });
			}

			// A seeded developer contact is not a visitor's either.
			expect(await statusOf(ana.request("/api/phone/identities/5571990000001/chats"))).toBe(404);

			// Bruno's conversation is exactly what Bruno sent.
			const brunoChat = bruno.chatPath(fixture.phoneNumberId);

			const history = conversationMessagesResponseSchema.parse(
				await jsonOf(bruno.request(`${brunoChat}/messages`)),
			).data;

			expect(history.map(message => message.id)).toEqual([brunoMessageId]);
		});

		it("refuses a forged reference to another visitor's message or media from its own identity", async () => {
			const chat = ana.chatPath(fixture.phoneNumberId);
			const forged = [
				{ type: "text", text: { body: "quoting" }, replyTo: brunoMessageId },
				{ type: "reaction", reaction: { message_id: brunoMessageId, emoji: "👍" } },
				{ type: "image", media: { id: brunoMediaId } },
			];

			for (const body of forged) {
				const response = await ana.request(`${chat}/messages`, { body });

				expect({ type: body.type, status: response.status }).toEqual({ type: body.type, status: 404 });
			}

			expect(await statusOf(ana.request(`/api/phone/identities/${ana.waId}/media/${brunoMediaId}`))).toBe(404);
		});

		it("never serves another visitor's media bytes, nor any media without a session", async () => {
			const descriptor = mediaResponseSchema.parse(
				await jsonOf(bruno.request(`/api/phone/identities/${bruno.waId}/media/${brunoMediaId}`)),
			).data;

			expect(await statusOf(bruno.request(descriptor.url))).toBe(200);
			expect(await statusOf(ana.request(descriptor.url))).toBe(404);
			expect(await statusOf(fixture.consoleApp.request(descriptor.url))).toBe(404);
			// The admin sees every byte, as in dev mode.
			expect(await statusOf(fixture.consoleApp.request(descriptor.url, { headers: ADMIN_HEADERS }))).toBe(200);
		});

		it("lets each visitor see the media the business sent it, and only that", async () => {
			const form = new FormData();

			form.set("messaging_product", "whatsapp");
			form.set("type", "image/png");
			form.set("file", new Blob([PNG_BYTES], { type: "image/png" }), "brochure.png");

			const uploaded = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}` },
				body: form,
			});
			const { id: mediaId } = await readJson<{ id: string }>(uploaded);
			const sent = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
				body: JSON.stringify({ messaging_product: "whatsapp", to: ana.waId, type: "image", image: { id: mediaId } }),
			});

			expect(sent.status).toBe(200);
			expect(await statusOf(ana.request(`/api/phone/identities/${ana.waId}/media/${mediaId}`))).toBe(200);
			expect(await statusOf(bruno.request(`/api/phone/identities/${bruno.waId}/media/${mediaId}`))).toBe(404);
		});
	});

	describe("the admin surface (AC-16)", () => {
		beforeEach(async () => {
			await boot();
		});

		/** Every admin route family of the control plane, one representative request each. */
		const ADMIN_API: [string, string][] = [
			["GET", "/api/state"],
			["GET", "/api/export"],
			["POST", "/api/import"],
			["POST", "/api/reset"],
			["GET", "/api/contacts"],
			["GET", "/api/conversations"],
			["POST", "/api/inbound"],
			["POST", "/api/inbound-media"],
			["GET", "/api/media/1"],
			["GET", "/api/templates"],
			["GET", "/api/graph-requests"],
			["DELETE", "/api/graph-requests"],
			["GET", "/api/webhooks/deliveries"],
			["GET", "/api/apps"],
			["GET", "/api/tokens"],
			["GET", "/api/injection-rules"],
			["GET", "/api/messaging-rules"],
			["GET", "/api/clock"],
			["POST", "/api/clock/advance"],
			["POST", "/api/scenarios/run"],
			["GET", "/api/wabas"],
			["GET", "/api/phone-numbers"],
			["GET", "/api/ws"],
			["GET", "/api/does-not-exist"],
		];

		it("answers 401 to every admin API without the admin token, even for a visitor with a session", async () => {
			const ana = visitor();

			await ana.start();

			for (const [method, path] of ADMIN_API) {
				const anonymous = await fixture.consoleApp.request(path, { method });
				const asVisitor = await ana.request(path, { method });

				expect({ path, anonymous: anonymous.status, visitor: asVisitor.status }).toEqual({
					path,
					anonymous: 401,
					visitor: 401,
				});
			}
		});

		it("lets the admin token through, as a bearer header", async () => {
			for (const path of ["/api/state", "/api/clock", "/api/graph-requests", "/api/apps"]) {
				expect(await statusOf(fixture.consoleApp.request(path, { headers: ADMIN_HEADERS }))).toBe(200);
			}

			expect(
				await statusOf(
					fixture.consoleApp.request("/api/state", {
						headers: { authorization: "Bearer wrong-token-0123456789" },
					}),
				),
			).toBe(401);
		});

		it("signs a browser in through /admin, and refuses a wrong token or another origin", async () => {
			const page = await fixture.consoleApp.request("/admin");

			expect(page.status).toBe(200);
			expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
			// Under `no-referrer` a browser posts the form with `Origin: null`, which the check refuses.
			expect(page.headers.get("referrer-policy")).toBe("same-origin");

			const wrong = await fixture.consoleApp.request("/api/admin/login", {
				method: "POST",
				headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
				body: "token=nope",
			});

			expect(wrong.status).toBe(303);
			expect(wrong.headers.get("location")).toBe("/admin?error=invalid");

			const crossOrigin = await fixture.consoleApp.request("/api/admin/login", {
				method: "POST",
				headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
				body: `token=${encodeURIComponent(PUBLIC_ENV["MOCKWA_ADMIN_TOKEN"]!)}`,
			});

			expect(crossOrigin.headers.get("location")).toBe("/admin?error=origin");

			const signedIn = await fixture.consoleApp.request("/api/admin/login", {
				method: "POST",
				headers: { origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
				body: `token=${encodeURIComponent(PUBLIC_ENV["MOCKWA_ADMIN_TOKEN"]!)}`,
			});

			expect(signedIn.status).toBe(303);
			expect(signedIn.headers.get("location")).toBe("/");

			const cookie = signedIn.headers.getSetCookie().find(header => header.startsWith("mockwa_admin="));

			expect(cookie).toMatch(/HttpOnly/);

			const session = cookie!.split(";", 1)[0]!;

			expect(await statusOf(fixture.consoleApp.request("/api/state", { headers: { cookie: session } }))).toBe(200);
			// A signed-in browser writes only from this origin.
			expect(
				await statusOf(
					fixture.consoleApp.request("/api/reset", {
						method: "POST",
						headers: { cookie: session, origin: "https://evil.example" },
					}),
				),
			).toBe(403);
		});

		it("does not serve the Graph API on the console listener", async () => {
			const response = await fixture.consoleApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
				body: "{}",
			});

			expect(response.status).toBe(404);
		});

		it("keeps webhook destinations to the server's configuration, for the app and the admin alike", async () => {
			const graphPost = async (path: string, body: unknown): Promise<Response> => {
				return fixture.graphApp.request(`/v25.0/${path}`, {
					method: "POST",
					headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			};
			const override = { override_callback_uri: "https://elsewhere.example/hook", verify_token: "v" };

			for (const response of [
				await graphPost(`${fixture.wabaId}/subscribed_apps`, override),
				await graphPost(fixture.phoneNumberId, { webhook_configuration: override }),
			]) {
				expect(response.status).toBe(400);
				expect(JSON.stringify(await response.json())).toMatch(/webhook destinations come from its configuration/);
			}

			// Subscribing without an override is still the app's to do.
			expect(await statusOf(graphPost(`${fixture.wabaId}/subscribed_apps`, {}))).toBe(200);

			const adminWrite = async (method: string, path: string, body: unknown): Promise<number> => {
				return await statusOf(
					fixture.consoleApp.request(path, {
						method,
						headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
				);
			};

			expect(
				await adminWrite("POST", "/api/apps", { name: "Other", callbackUrl: "https://elsewhere.example/hook" }),
			).toBe(403);
			expect(await adminWrite("PATCH", "/api/apps/default", { callbackUrl: "https://elsewhere.example/hook" })).toBe(
				403,
			);
			expect(
				await adminWrite("PUT", `/api/apps/default/subscriptions/${fixture.wabaId}`, {
					overrideCallbackUri: "https://elsewhere.example/hook",
				}),
			).toBe(403);
			expect(
				await adminWrite("PUT", `/api/apps/default/phone-overrides/${fixture.phoneNumberId}`, {
					callbackUri: "https://elsewhere.example/hook",
				}),
			).toBe(403);
			expect(
				await adminWrite("POST", "/api/apps/default/handshake", { callbackUri: "https://elsewhere.example/hook" }),
			).toBe(403);
		});

		it("keeps the Graph listener to the registered token", async () => {
			const response = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}`, {
				headers: { authorization: "Bearer any-visitor-guess" },
			});

			expect(response.status).toBe(401);
		});
	});

	describe("limits (AC-17)", () => {
		it("answers 429 with Retry-After past the per-session message rate, and recovers after a minute", async () => {
			await boot({ MOCKWA_PUBLIC_MESSAGES_PER_MINUTE: "3" });

			const ana = visitor();

			await ana.start();

			const statuses: number[] = [];

			for (let index = 0; index < 4; index += 1) {
				const text = `m${String(index)}`;

				statuses.push(await statusOf(ana.sendText(fixture.phoneNumberId, text)));
			}

			expect(statuses).toEqual([201, 201, 201, 429]);

			const refused = await ana.sendText(fixture.phoneNumberId, "again");

			expect(refused.status).toBe(429);
			expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
			const refusedBody = await readJson<{ error: { code: string } }>(refused);

			expect(refusedBody.error.code).toBe("message_rate_limited");

			scheduler.advance(61_000);
			expect(await statusOf(ana.sendText(fixture.phoneNumberId, "later"))).toBe(201);
		});

		it("counts every session of one address against the per-address rate", async () => {
			await boot({ MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE: "2" });

			const first = visitor("203.0.113.9");
			const second = visitor("203.0.113.9");

			await first.start();
			await second.start();

			expect(await statusOf(first.sendText(fixture.phoneNumberId, "a"))).toBe(201);
			expect(await statusOf(second.sendText(fixture.phoneNumberId, "b"))).toBe(201);
			expect(await statusOf(first.sendText(fixture.phoneNumberId, "c"))).toBe(429);
		});

		it("refuses a file over the size limit with 413 and past the count with 429", async () => {
			await boot({ MOCKWA_PUBLIC_MEDIA_MAX_BYTES: "64", MOCKWA_PUBLIC_MEDIA_PER_SESSION: "2" });

			const ana = visitor();

			await ana.start();

			const big = new Uint8Array(65);

			big.set(PNG_BYTES);

			const tooBig = pngForm(big);

			const uploadPath = `${ana.chatPath(fixture.phoneNumberId)}/media`;

			expect(await statusOf(ana.request(uploadPath, { form: tooBig }))).toBe(413);

			await uploadPng(ana);
			await uploadPng(ana);

			const third = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/media`, { form: pngForm() });

			expect(third.status).toBe(429);
			const thirdBody = await readJson<{ error: { code: string } }>(third);

			expect(thirdBody.error.code).toBe("media_quota_exceeded");
		});

		it("holds an address to its share of live sessions", async () => {
			await boot({ MOCKWA_PUBLIC_SESSIONS_PER_IP: "2" });

			await visitor("203.0.113.20").start();
			await visitor("203.0.113.20").start();

			const third = await visitor("203.0.113.20").request("/api/public/session", { method: "POST" });

			expect(third.status).toBe(429);
			expect(await visitor("203.0.113.21").start()).toBeDefined();
		});

		it("believes X-Forwarded-For only from a trusted proxy", async () => {
			await boot({ MOCKWA_PUBLIC_SESSIONS_PER_IP: "1", MOCKWA_TRUSTED_PROXIES: "10.0.0.2" });

			const viaProxy = async (forwardedFor: string, peer = "10.0.0.2"): Promise<number> => {
				const response = await fixture.consoleApp.request(
					"/api/public/session",
					{ method: "POST", headers: { origin: "http://localhost", "x-forwarded-for": forwardedFor } },
					fromAddress(peer),
				);

				return response.status;
			};

			// Two clients behind the proxy are two addresses.
			expect(await viaProxy("198.51.100.1")).toBe(201);
			expect(await viaProxy("198.51.100.2")).toBe(201);
			expect(await viaProxy("198.51.100.1")).toBe(429);
			// A header from an untrusted peer is ignored: the peer is the client.
			expect(await viaProxy("198.51.100.3", "192.0.2.50")).toBe(201);
			expect(await viaProxy("198.51.100.4", "192.0.2.50")).toBe(429);
		});
	});

	describe("idle cleanup (AC-17)", () => {
		beforeEach(async () => {
			await boot({ MOCKWA_PUBLIC_SESSION_TTL: "10m", MOCKWA_STATUS_DELAYS: "sent:0,delivered:0" });
		});

		it("removes only the idle visitor's identities, messages and media, bytes included", async () => {
			const idle = visitor("198.51.100.1");
			const active = visitor("198.51.100.2");

			await idle.start();
			await active.start();

			const mediaId = await uploadPng(idle);

			expect(await statusOf(idle.sendText(fixture.phoneNumberId, "about to go"))).toBe(201);
			expect(await statusOf(businessSends(idle.waId, "reply"))).toBe(200);
			expect(await statusOf(active.sendText(fixture.phoneNumberId, "staying"))).toBe(201);

			const filesBefore = await readdir(fixture.mediaDir);

			scheduler.advance(6 * 60_000);
			// The active visitor keeps its session alive; the idle one does not.
			expect(await statusOf(active.request("/api/public/session"))).toBe(200);
			scheduler.advance(5 * 60_000);
			await fixture.services.domain.visitors.sweep();

			const { repositories } = fixture.services;

			for (const identity of idle.identities) {
				expect(await repositories.contacts.findByWaId(identity.waId)).toBeNull();
			}

			expect(await repositories.media.findById(mediaId)).toBeNull();
			const filesAfter = await readdir(fixture.mediaDir);

			expect(filesAfter).toHaveLength(filesBefore.length - 1);
			expect(
				await repositories.messages.listConversation({ phoneNumberId: fixture.phoneNumberId, contactWaId: idle.waId }),
			).toEqual([]);

			// The other visitor and the seeded developer contacts are untouched.
			expect(await repositories.contacts.findByWaId(active.waId)).not.toBeNull();
			expect(await repositories.contacts.findByWaId("5571990000001")).not.toBeNull();
			expect(
				await repositories.messages.listConversation({
					phoneNumberId: fixture.phoneNumberId,
					contactWaId: active.waId,
				}),
			).toHaveLength(1);

			const after = await idle.request("/api/public/session");

			expect(after.status).toBe(401);
			const afterBody = await readJson<{ error: { code: string } }>(after);

			expect(afterBody.error.code).toBe("session_expired");
		});

		it("ends an idle session on its next request, before the cleanup job runs", async () => {
			const ana = visitor();

			await ana.start();
			scheduler.advance(10 * 60_000 + 1);

			const response = await ana.sendText(fixture.phoneNumberId, "too late");

			expect(response.status).toBe(401);
			expect(await fixture.services.repositories.contacts.findByWaId(ana.waId)).toBeNull();
		});

		it("does not let a late reply from the app bring an expired visitor back, or reach anyone else", async () => {
			const ana = visitor();

			await ana.start();

			const { waId } = ana;

			scheduler.advance(11 * 60_000);
			await fixture.services.domain.visitors.sweep();

			// The app under test answers the visitor that left; Meta would accept the send.
			expect(await statusOf(businessSends(waId, "late reply"))).toBe(200);
			await fixture.services.domain.visitors.sweep();
			expect(await fixture.services.repositories.contacts.findByWaId(waId)).toBeNull();

			// A new visitor never gets that number, and its old cookie stays dead.
			const next = visitor("198.51.100.99");

			await next.start();
			expect(next.identities.map(identity => identity.waId)).not.toContain(waId);
			expect(await statusOf(ana.request(`/api/phone/identities/${waId}/chats`))).toBe(401);
		});
	});

	describe("concurrent operations", () => {
		beforeEach(async () => {
			await boot({ MOCKWA_PUBLIC_MESSAGES_PER_MINUTE: "100", MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE: "100" });
		});

		it("never leaves a message owned by nobody when the session ends during a burst of sends", async () => {
			const ana = visitor();

			await ana.start();

			const sends = Array.from({ length: 10 }, async (_, index) =>
				ana.sendText(fixture.phoneNumberId, `burst ${String(index)}`),
			);
			const ending = fixture.services.domain.visitors.end(sessionIdOf(ana), "test");
			const statuses = await Promise.all(sends.map(async send => await statusOf(send)));

			await ending;

			for (const status of statuses) {
				expect([201, 401]).toContain(status);
			}

			await fixture.services.domain.visitors.sweep();
			expect(await fixture.services.repositories.contacts.findByWaId(ana.waId)).toBeNull();
			expect(
				await fixture.services.repositories.messages.listConversation({
					phoneNumberId: fixture.phoneNumberId,
					contactWaId: ana.waId,
				}),
			).toEqual([]);
		});

		it("creates complete sessions under concurrent starts: every identity has exactly one owner", async () => {
			const visitors = Array.from({ length: 6 }, (_, index) => visitor(`198.51.100.${String(50 + index)}`));
			const sessions = await Promise.all(visitors.map(async each => each.start()));
			const numbers = sessions.flatMap(session => session.identities.map(identity => identity.waId));

			const distinct = new Set(numbers);

			expect(distinct.size).toBe(12);

			for (const waId of numbers) {
				expect(await fixture.services.repositories.publicSessions.ownerOf(waId)).not.toBeNull();
			}
		});
	});

	/** The hashed session ID, the way the server stores it. */
	function sessionIdOf(who: TestVisitor): string {
		return createHashHex(who.cookie ?? "");
	}
});

describe("dev mode", () => {
	let fixture: TestApp;

	afterEach(async () => {
		await fixture.close();
	});

	it("keeps the console open and the phone's unrestricted identity picker", async () => {
		fixture = await createTestApp();

		expect(await statusOf(fixture.consoleApp.request("/api/state"))).toBe(200);
		expect(await statusOf(fixture.consoleApp.request("/api/phone/config"))).toBe(200);
		expect(await statusOf(fixture.consoleApp.request("/api/public/session"))).toBe(404);

		const identities = phoneIdentityListResponseSchema.parse(
			await jsonOf(fixture.consoleApp.request("/api/phone/identities")),
		).data;

		expect(identities.map(identity => identity.waId)).toEqual(["5571990000001", "5571990000002"]);
	});

	it("puts the whole console, the phone included, behind MOCKWA_ADMIN_TOKEN when one is set", async () => {
		fixture = await createTestApp({ MOCKWA_ADMIN_TOKEN: PUBLIC_ENV["MOCKWA_ADMIN_TOKEN"]! });

		expect(await statusOf(fixture.consoleApp.request("/api/state"))).toBe(401);
		expect(await statusOf(fixture.consoleApp.request("/api/phone/identities"))).toBe(401);
		expect(await statusOf(fixture.consoleApp.request("/api/state", { headers: ADMIN_HEADERS }))).toBe(200);
		expect(await statusOf(fixture.consoleApp.request("/health"))).toBe(200);
		expect(await statusOf(fixture.consoleApp.request("/admin"))).toBe(200);
	});
});

function createHashHex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
