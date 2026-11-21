import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, type TestApp } from "../testing/test-app.ts";
import {
	ADMIN_HEADERS,
	createMovableScheduler,
	fromAddress,
	PUBLIC_ENV,
	TEST_ADMIN_TOKEN,
	TEST_GRAPH_TOKEN,
	TEST_ORIGIN,
	TestVisitor,
	type MovableScheduler,
} from "../testing/visitor-client.ts";
import { ADMIN_FAILURES_PER_WINDOW, ADMIN_FAILURE_WINDOW_MS, ADMIN_SESSION_TTL_MS } from "./access.ts";

/**
 * M7 hardening of public demo mode (SPEC §5, §7; architecture AC-19): the findings of the access
 * review, each pinned here — headers on every answer, limits that hold under concurrent requests,
 * bounded bodies, the admin lockout, and the copies of a visitor's conversation that leave with it.
 */

interface ErrorBody {
	error: { code: string };
}

interface StatsBody {
	data: {
		sessions: number;
		identities: number;
		webhookDeliveries: number;
		pendingRetries: number;
		graphRequests: number;
		sessionLocks: number;
		rateLimitKeys: number;
		sockets: number;
		socketsOpening: number;
		admin: { sessions: number; failureAddresses: number };
	};
}

/**
 * A webhook receiver that can hold chosen requests open: the visitor leaves while the delivery
 * is in flight, and the response arrives afterwards.
 */
interface HeldReceiver {
	url: string;
	/** Every body that arrived, held or not. */
	received: string[];
	/** Requests whose body matches are held until {@link HeldReceiver.release}. */
	hold: (isMatch: (body: string) => boolean) => void;
	/** The status every request that is not held gets. */
	answer: (status: number) => void;
	/** Resolves once `count` requests are being held. */
	held: (count: number) => Promise<void>;
	/** Answers every held request with `status`. */
	release: (status: number) => void;
	close: () => Promise<void>;
}

async function startHeldReceiver(): Promise<HeldReceiver> {
	const received: string[] = [];
	const waiting: ((status: number) => void)[] = [];
	let isHeld: (body: string) => boolean = () => false;
	let status = 200;

	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];

		request.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const reply = (code: number): void => {
				response.writeHead(code).end("ok");
			};

			received.push(body);

			if (isHeld(body)) {
				waiting.push(reply);
			} else {
				reply(status);
			}
		});
	});

	await new Promise<void>(resolve => {
		server.listen(0, "127.0.0.1", resolve);
	});

	const { port } = server.address() as AddressInfo;

	return {
		url: `http://127.0.0.1:${String(port)}/webhook`,
		received,
		hold: isMatch => {
			isHeld = isMatch;
		},
		answer: code => {
			status = code;
		},
		held: async count => {
			const deadline = Date.now() + 5000;

			while (waiting.length < count) {
				if (Date.now() > deadline) {
					throw new Error(`only ${String(waiting.length)} of ${String(count)} requests arrived`);
				}

				await new Promise(resolve => setTimeout(resolve, 5));
			}
		},
		release: code => {
			isHeld = () => false;

			for (const reply of waiting.splice(0)) {
				reply(code);
			}
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>(resolve => {
				server.close(() => {
					resolve();
				});
			});
		},
	};
}

describe("public mode hardening", () => {
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

	async function businessSends(to: string, text: string): Promise<Response> {
		return fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
		});
	}

	async function stats(): Promise<StatsBody["data"]> {
		const response = await fixture.consoleApp.request("/api/public/stats", { headers: ADMIN_HEADERS });

		expect(response.status).toBe(200);

		const body = await readJson<StatsBody>(response);

		return body.data;
	}

	describe("response headers (AC-19)", () => {
		it("marks every console-listener answer nosniff and same-origin, the API no-store", async () => {
			await boot();

			const ana = visitor();

			await ana.start();

			const answers = [
				await ana.request("/api/public/session"),
				await fixture.consoleApp.request("/api/state"),
				await fixture.consoleApp.request("/settings"),
				await fixture.consoleApp.request("/api/phone/config"),
			];

			for (const response of answers) {
				expect(response.headers.get("x-content-type-options")).toBe("nosniff");
				expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
			}

			// The session answer carries the CSRF token: never cached anywhere.
			expect(answers[0]?.headers.get("cache-control")).toBe("no-store");
			expect(answers[1]?.headers.get("cache-control")).toBe("no-store");
		});

		it("keeps the sign-in page under its own policy and unframeable", async () => {
			await boot();

			const page = await fixture.consoleApp.request("/admin");

			expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
			expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
			expect(page.headers.get("x-frame-options")).toBe("DENY");
			expect(page.headers.get("cache-control")).toBe("no-store");
		});
	});

	describe("concurrent requests", () => {
		it("holds an address to its share of sessions when the requests race", async () => {
			await boot({ WASANDBOX_PUBLIC_SESSIONS_PER_IP: "3" });

			const results = await Promise.all(
				Array.from({ length: 12 }, async () =>
					statusOf(visitor("203.0.113.30").request("/api/public/session", { method: "POST" })),
				),
			);

			expect(results.filter(status => status === 201)).toHaveLength(3);
			expect(results.filter(status => status === 429)).toHaveLength(9);
			const after = await stats();

			expect(after.sessions).toBe(3);
		});

		it("holds the per-address creation rate when the requests race", async () => {
			await boot({ WASANDBOX_PUBLIC_SESSION_CREATES_PER_MINUTE: "4", WASANDBOX_PUBLIC_SESSIONS_PER_IP: "50" });

			const results = await Promise.all(
				Array.from({ length: 10 }, async () =>
					statusOf(visitor("203.0.113.31").request("/api/public/session", { method: "POST" })),
				),
			);

			expect(results.filter(status => status === 201)).toHaveLength(4);
		});

		it("holds the instance-wide cap when visitors from many addresses race", async () => {
			await boot({ WASANDBOX_PUBLIC_MAX_SESSIONS: "5" });

			const results = await Promise.all(
				Array.from({ length: 15 }, async (_, index) =>
					statusOf(visitor(`198.51.100.${String(index + 1)}`).request("/api/public/session", { method: "POST" })),
				),
			);

			expect(results.filter(status => status === 201)).toHaveLength(5);
		});

		it("counts a message flood from one session exactly against its limit", async () => {
			await boot({ WASANDBOX_PUBLIC_MESSAGES_PER_MINUTE: "5" });

			const ana = visitor();

			await ana.start();

			const results = await Promise.all(
				Array.from({ length: 20 }, async (_, index) =>
					statusOf(ana.sendText(fixture.phoneNumberId, `flood ${String(index)}`)),
				),
			);

			expect(results.filter(status => status === 201)).toHaveLength(5);
			expect(results.filter(status => status === 429)).toHaveLength(15);
		});

		it("counts uploads racing each other exactly against the session's media quota", async () => {
			await boot({ WASANDBOX_PUBLIC_MEDIA_PER_SESSION: "2" });

			const ana = visitor();

			await ana.start();

			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
			const results = await Promise.all(
				Array.from({ length: 6 }, async () => {
					const form = new FormData();

					form.set("file", new Blob([png], { type: "image/png" }), "a.png");

					return statusOf(ana.request(`${ana.chatPath(fixture.phoneNumberId)}/media`, { form }));
				}),
			);

			expect(results.filter(status => status === 201)).toHaveLength(2);
			expect(results.filter(status => status === 429)).toHaveLength(4);
		});
	});

	describe("bounded input", () => {
		it("refuses an oversized JSON body with 413 before parsing it", async () => {
			await boot();

			const ana = visitor();

			await ana.start();

			const response = await ana.request(`${ana.chatPath(fixture.phoneNumberId)}/messages`, {
				body: { type: "text", text: { body: "x".repeat(4000) }, padding: "y".repeat(64 * 1024) },
			});

			expect(response.status).toBe(413);
			const body = await readJson<ErrorBody>(response);

			expect(body.error.code).toBe("request_too_large");
		});

		it.each([
			["not JSON", "{", "invalid_json"],
			["an array", "[]", "invalid_request"],
			["a string", '"hello"', "invalid_request"],
			["an unknown type", '{"type":"payment"}', "invalid_request"],
			["a text without a body", '{"type":"text","text":{}}', "invalid_request"],
		])("answers %s with a 400 and leaves nothing behind", async (_label, raw, code) => {
			await boot();

			const ana = visitor();

			await ana.start();

			const response = await fixture.consoleApp.request(
				`${ana.chatPath(fixture.phoneNumberId)}/messages`,
				{
					method: "POST",
					headers: {
						cookie: `wasandbox_visitor=${ana.cookie ?? ""}`,
						origin: TEST_ORIGIN,
						"x-csrf-token": ana.session?.csrfToken ?? "",
						"content-type": "application/json",
					},
					body: raw,
				},
				fromAddress("198.51.100.10"),
			);

			expect(response.status).toBe(400);
			const body = await readJson<ErrorBody>(response);

			expect(body.error.code).toBe(code);
			// The session still works: a refusal is not a half-done write.
			expect(await statusOf(ana.sendText(fixture.phoneNumberId, "still fine"))).toBe(201);
		});

		it("refuses an oversized sign-in body", async () => {
			await boot();

			const response = await fixture.consoleApp.request("/api/admin/login", {
				method: "POST",
				headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
				body: JSON.stringify({ token: "x".repeat(10_000) }),
			});

			expect(response.status).toBe(413);
		});
	});

	describe("admin authentication failures", () => {
		async function signIn(token: string, address = "203.0.113.40"): Promise<Response> {
			return fixture.consoleApp.request(
				"/api/admin/login",
				{
					method: "POST",
					headers: { origin: TEST_ORIGIN, "content-type": "application/json" },
					body: JSON.stringify({ token }),
				},
				fromAddress(address),
			);
		}

		it("locks an address out after repeated wrong tokens, even for the right one, then lets it back", async () => {
			await boot();

			for (let attempt = 0; attempt < ADMIN_FAILURES_PER_WINDOW; attempt += 1) {
				const wrong = await signIn(`wrong-${String(attempt)}`);

				expect(wrong.status).toBe(401);
			}

			const locked = await signIn(TEST_ADMIN_TOKEN);

			expect(locked.status).toBe(429);
			expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
			// Another address is not affected.
			expect(await statusOf(signIn(TEST_ADMIN_TOKEN, "203.0.113.41"))).toBe(204);

			scheduler.advance(ADMIN_FAILURE_WINDOW_MS);
			expect(await statusOf(signIn(TEST_ADMIN_TOKEN))).toBe(204);
		});

		it("counts wrong bearer tokens on the API the same way", async () => {
			await boot();

			const call = async (token: string): Promise<number> => {
				return statusOf(
					fixture.consoleApp.request(
						"/api/state",
						{ headers: { authorization: `Bearer ${token}` } },
						fromAddress("203.0.113.42"),
					),
				);
			};

			for (let attempt = 0; attempt < ADMIN_FAILURES_PER_WINDOW; attempt += 1) {
				expect(await call("wrong-token-0123456789")).toBe(401);
			}

			expect(await call(TEST_ADMIN_TOKEN)).toBe(429);
		});

		it("reclaims the failures of many addresses after their window with no successful sign-in, and keeps working", async () => {
			await boot();

			for (let index = 1; index <= 25; index += 1) {
				const address = `203.0.113.${String(100 + index)}`;

				expect(await statusOf(signIn("wrong-token", address))).toBe(401);
			}

			const during = await stats();

			expect(during.admin).toEqual({ sessions: 0, failureAddresses: 25 });

			// Nobody signs in and none of those addresses comes back: the visitor's ordinary
			// request is the first thing the console sees after the window.
			scheduler.advance(ADMIN_FAILURE_WINDOW_MS + 60_000);

			const passerby = visitor("198.51.100.30");

			await passerby.start();

			const after = await stats();

			expect(after.admin).toEqual({ sessions: 0, failureAddresses: 0 });

			// The lockout still works afterwards, for an address that earns it.
			for (let attempt = 0; attempt < ADMIN_FAILURES_PER_WINDOW; attempt += 1) {
				expect(await statusOf(signIn("wrong-token", "203.0.113.200"))).toBe(401);
			}

			expect(await statusOf(signIn(TEST_ADMIN_TOKEN, "203.0.113.200"))).toBe(429);
			expect(await statusOf(signIn(TEST_ADMIN_TOKEN, "203.0.113.201"))).toBe(204);
		});

		it("reclaims expired admin sign-ins without anyone signing in again", async () => {
			await boot();

			for (let index = 0; index < 3; index += 1) {
				const address = `203.0.113.${String(210 + index)}`;

				expect(await statusOf(signIn(TEST_ADMIN_TOKEN, address))).toBe(204);
			}

			const during = await stats();

			expect(during.admin.sessions).toBe(3);

			scheduler.advance(ADMIN_SESSION_TTL_MS + 60_000);

			const after = await stats();

			expect(after.admin.sessions).toBe(0);
		});

		it("shows a plain message for a sign-in error it does not know", async () => {
			await boot();

			const response = await fixture.consoleApp.request("/admin?error=constructor");
			const page = await response.text();

			expect(page).toContain("Sign-in refused.");
			expect(page).not.toContain("function");
		});
	});

	describe("what a visitor leaves behind", () => {
		it("takes the webhook deliveries and Graph requests naming its numbers with it, and nobody else's", async () => {
			await boot({
				WASANDBOX_PUBLIC_SESSION_TTL: "10m",
				WASANDBOX_STATUS_DELAYS: "sent:0,delivered:0",
				WASANDBOX_WEBHOOK_URL: "http://127.0.0.1:9/unreachable",
			});

			const leaving = visitor("198.51.100.1");
			const staying = visitor("198.51.100.2");

			await leaving.start();
			await staying.start();

			expect(await statusOf(leaving.sendText(fixture.phoneNumberId, "leaving soon"))).toBe(201);
			expect(await statusOf(businessSends(leaving.waId, "bye"))).toBe(200);
			expect(await statusOf(staying.sendText(fixture.phoneNumberId, "staying"))).toBe(201);
			expect(await statusOf(businessSends(staying.waId, "hi"))).toBe(200);

			const before = await stats();

			expect(before.graphRequests).toBeGreaterThanOrEqual(2);

			expect(await statusOf(leaving.request("/api/public/session", { method: "DELETE" }))).toBe(204);

			const deliveries = await readJson<{ data: { requestBody: string }[] }>(
				await fixture.consoleApp.request("/api/webhook-deliveries?limit=200", { headers: ADMIN_HEADERS }),
			);
			const requests = await readJson<{ data: { requestBody: unknown }[] }>(
				await fixture.consoleApp.request("/api/graph-requests?limit=200", { headers: ADMIN_HEADERS }),
			);
			const everything = JSON.stringify([deliveries, requests]);

			expect(everything).not.toContain(leaving.waId);
			expect(everything).toContain(staying.waId);
		});

		it("does not log a late Graph request or its webhooks for a visitor who already left", async () => {
			await boot({
				WASANDBOX_PUBLIC_SESSION_TTL: "10m",
				WASANDBOX_STATUS_DELAYS: "sent:0,delivered:0",
				WASANDBOX_WEBHOOK_URL: "http://127.0.0.1:9/unreachable",
			});

			const leaving = visitor("198.51.100.3");
			const staying = visitor("198.51.100.4");

			await leaving.start();
			await staying.start();
			expect(await statusOf(leaving.request("/api/public/session", { method: "DELETE" }))).toBe(204);

			// The app under test answers late; it is still answered as Meta would.
			expect(await statusOf(businessSends(leaving.waId, "too late"))).toBe(200);
			expect(await statusOf(businessSends(staying.waId, "on time"))).toBe(200);
			await fixture.services.domain.tasks.whenIdle();

			const deliveries = await readJson<unknown>(
				await fixture.consoleApp.request("/api/webhook-deliveries?limit=200", { headers: ADMIN_HEADERS }),
			);
			const requests = await readJson<{ data: { id: number }[] }>(
				await fixture.consoleApp.request("/api/graph-requests?limit=200", { headers: ADMIN_HEADERS }),
			);
			const details = await Promise.all(
				requests.data.map(async request => {
					const response = await fixture.consoleApp.request(`/api/graph-requests/${String(request.id)}`, {
						headers: ADMIN_HEADERS,
					});

					return readJson<unknown>(response);
				}),
			);
			const everything = JSON.stringify([deliveries, details]);

			expect(requests.data).toHaveLength(1);
			expect(everything).not.toContain(leaving.waId);
			expect(everything).not.toContain("too late");
			expect(everything).toContain(staying.waId);
		});

		it("lets the in-memory maps shrink back once the visitors are gone", async () => {
			await boot({ WASANDBOX_PUBLIC_SESSION_TTL: "1m" });

			const visitors = Array.from({ length: 5 }, (_, index) => visitor(`198.51.100.${String(index + 1)}`));

			for (const each of visitors) {
				await each.start();
				expect(await statusOf(each.sendText(fixture.phoneNumberId, "hello"))).toBe(201);
			}

			const during = await stats();

			expect(during.rateLimitKeys).toBeGreaterThan(0);

			scheduler.advance(2 * 60_000);
			await fixture.services.domain.visitors.sweep();

			const after = await stats();

			expect(after.sessions).toBe(0);
			expect(after.identities).toBe(0);
			expect(after.rateLimitKeys).toBe(0);
			expect(after.sessionLocks).toBe(0);
		});
	});

	describe("a webhook in flight while its visitor leaves", () => {
		let receiver: HeldReceiver;

		afterEach(async () => {
			await receiver.close();
		});

		async function bootWith(): Promise<void> {
			receiver = await startHeldReceiver();
			await boot({
				WASANDBOX_PUBLIC_SESSION_TTL: "10m",
				WASANDBOX_WEBHOOK_URL: receiver.url,
				WASANDBOX_WEBHOOK_RETRY_SCHEDULE: "10s",
				WASANDBOX_STATUS_DELAYS: "sent:0,delivered:600000",
			});
		}

		async function settle(): Promise<void> {
			await fixture.services.domain.tasks.whenIdle();
			await fixture.services.domain.webhooks.whenIdle();
		}

		async function deliveryBodies(): Promise<string> {
			const response = await fixture.consoleApp.request("/api/webhook-deliveries?limit=200", {
				headers: ADMIN_HEADERS,
			});

			return JSON.stringify(await readJson<unknown>(response));
		}

		/** The leaving visitor's text is held at the receiver; the staying one's is answered `status`. */
		async function leaveWhileHeld(status: number): Promise<{ leaving: TestVisitor; staying: TestVisitor }> {
			const leaving = visitor("198.51.100.11");
			const staying = visitor("198.51.100.12");

			await leaving.start();
			await staying.start();
			receiver.hold(body => body.includes(leaving.waId));
			receiver.answer(status);

			expect(await statusOf(staying.sendText(fixture.phoneNumberId, "staying"))).toBe(201);
			expect(await statusOf(leaving.sendText(fixture.phoneNumberId, "leaving secret"))).toBe(201);
			await receiver.held(1);
			expect(await statusOf(leaving.request("/api/public/session", { method: "DELETE" }))).toBe(204);

			return { leaving, staying };
		}

		it.each([200, 500])(
			"writes nothing back and queues no retry when the receiver answers %i after the visitor left",
			async status => {
				await bootWith();

				const { leaving, staying } = await leaveWhileHeld(status);

				receiver.release(status);
				await settle();
				await fixture.services.domain.visitors.sweep();

				const bodies = await deliveryBodies();
				const after = await stats();

				expect(bodies).not.toContain(leaving.waId);
				expect(bodies).not.toContain("leaving secret");
				expect(bodies).toContain(staying.waId);
				// The staying visitor's failed delivery keeps its retry; the departed one has none.
				expect(after.pendingRetries).toBe(status === 500 ? 1 : 0);

				scheduler.advance(60_000);
				await fixture.services.domain.webhooks.runDueRetries();
				await settle();

				const retried = receiver.received.filter(body => body.includes(leaving.waId));

				expect(retried).toHaveLength(1);
				expect(await deliveryBodies()).not.toContain(leaving.waId);
				expect(receiver.received.filter(body => body.includes(staying.waId)).length).toBe(status === 500 ? 2 : 1);
			},
		);

		it.each([200, 500])(
			"drops a retry already in flight when the visitor leaves and the receiver then answers %i",
			async status => {
				await bootWith();

				const leaving = visitor("198.51.100.13");

				await leaving.start();
				receiver.answer(500);
				expect(await statusOf(leaving.sendText(fixture.phoneNumberId, "retry me"))).toBe(201);
				await settle();

				const before = await stats();

				expect(before.pendingRetries).toBe(1);

				receiver.hold(body => body.includes(leaving.waId));
				scheduler.advance(60_000);

				const pass = fixture.services.domain.webhooks.runDueRetries();

				await receiver.held(1);
				expect(await statusOf(leaving.request("/api/public/session", { method: "DELETE" }))).toBe(204);
				receiver.release(status);
				await pass;
				await settle();
				await fixture.services.domain.visitors.sweep();

				const after = await stats();

				expect(await deliveryBodies()).not.toContain(leaving.waId);
				expect(after.webhookDeliveries).toBe(0);
				expect(after.pendingRetries).toBe(0);
			},
		);
	});

	describe("diagnostics", () => {
		it("serves the stats to the admin only", async () => {
			await boot();

			const ana = visitor();

			await ana.start();

			expect(await statusOf(ana.request("/api/public/stats"))).toBe(401);
			expect(await statusOf(fixture.consoleApp.request("/api/public/stats"))).toBe(401);
			const current = await stats();

			expect(current.sessions).toBe(1);
		});
	});

	describe("media the app under test sent", () => {
		it("serves an HTML upload as a sandboxed download on the console origin, to the admin and the visitor alike", async () => {
			await boot();

			const ana = visitor();

			await ana.start();

			const form = new FormData();

			form.set("messaging_product", "whatsapp");
			form.set("file", new Blob(["<script>alert(document.cookie)</script>"], { type: "text/html" }), "x.html");
			form.set("type", "text/html");

			const uploaded = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/media`, {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}` },
				body: form,
			});
			const { id } = await readJson<{ id: string }>(uploaded);

			const send = JSON.stringify({ messaging_product: "whatsapp", to: ana.waId, type: "document", document: { id } });
			const sent = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
				method: "POST",
				headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
				body: send,
			});

			expect(sent.status).toBe(200);

			const descriptor = await readJson<{ data: { url: string } }>(
				await ana.request(`/api/phone/identities/${ana.waId}/media/${id}`),
			);

			for (const response of [
				await ana.request(descriptor.data.url),
				await fixture.consoleApp.request(descriptor.data.url, { headers: ADMIN_HEADERS }),
			]) {
				expect(response.status).toBe(200);
				expect(response.headers.get("content-disposition")).toBe("attachment");
				expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
				expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			}
		});
	});

	describe("forwarded headers", () => {
		async function startVia(peer: string, headers: Record<string, string>): Promise<Response> {
			return fixture.consoleApp.request(
				"/api/public/session",
				{ method: "POST", headers: { origin: TEST_ORIGIN, ...headers } },
				fromAddress(peer),
			);
		}

		it("takes the address the trusted proxy appended, not one the client put in front of it", async () => {
			await boot({ WASANDBOX_PUBLIC_SESSIONS_PER_IP: "1", WASANDBOX_TRUSTED_PROXIES: "10.0.0.2" });

			// The client claims to be 192.0.2.1; the proxy appends what it saw, 198.51.100.7.
			const first = await startVia("10.0.0.2", { "x-forwarded-for": "192.0.2.1, 198.51.100.7" });

			expect(first.status).toBe(201);
			// A different spoofed prefix is still the same client.
			const second = await startVia("10.0.0.2", { "x-forwarded-for": "192.0.2.99, 198.51.100.7" });

			expect(second.status).toBe(429);
		});

		it("ignores a forwarded origin from an untrusted peer", async () => {
			await boot({ WASANDBOX_TRUSTED_PROXIES: "10.0.0.2" });

			// A page on evil.example claims, through headers it cannot set via a proxy, to be this site.
			const spoofed = await startVia("192.0.2.50", {
				origin: "https://evil.example",
				"x-forwarded-host": "evil.example",
				"x-forwarded-proto": "https",
			});

			expect(spoofed.status).toBe(403);
		});

		it("accepts the origin a trusted proxy reports", async () => {
			await boot({ WASANDBOX_TRUSTED_PROXIES: "10.0.0.2" });

			const proxied = await startVia("10.0.0.2", {
				origin: "https://demo.example",
				"x-forwarded-host": "demo.example",
				"x-forwarded-proto": "https",
				"x-forwarded-for": "198.51.100.8",
			});

			expect(proxied.status).toBe(201);
			// Behind HTTPS the cookie is Secure under the default `auto`.
			expect(proxied.headers.getSetCookie().join(";")).toContain("Secure");
		});
	});

	describe("the request ID", () => {
		it("echoes a well-formed caller ID and replaces anything else", async () => {
			await boot();

			const kept = await fixture.consoleApp.request("/health", { headers: { "x-request-id": "abc-123.def" } });
			const replaced = await fixture.consoleApp.request("/health", {
				headers: { "x-request-id": `bad id ${"z".repeat(300)}` },
			});

			expect(kept.headers.get("x-request-id")).toBe("abc-123.def");
			expect(replaced.headers.get("x-request-id")).toMatch(/^[\da-f-]{36}$/);
		});
	});
});
