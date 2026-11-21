import { serve, type ServerType } from "@hono/node-server";
import {
	conversationMessagesResponseSchema,
	inboundResponseSchema,
	phoneChatListResponseSchema,
	phoneIdentityListResponseSchema,
	phoneReadResponseSchema,
	wsEventSchema,
	type WsEvent,
} from "@wasandbox/shared";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { readJson, statusOf } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The virtual phone's API (SPEC §5): conversations seen from one seeded contact's side. The
 * default seed has two contacts, Ana and Bruno, which is all "two phones" needs.
 */
const ANA = "5571990000001";
const BRUNO = "5571990000002";
/** The ladder still sends `sent`, but a business message reaches the phone only when a test says so. */
const MANUAL_DELIVERY = { WASANDBOX_STATUS_DELAYS: "sent:0,delivered:3600000" };

describe("/api/phone", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp(MANUAL_DELIVERY);
	});

	afterEach(async () => {
		await fixture.close();
	});

	function chatPath(waId: string, phoneNumberId = fixture.phoneNumberId): string {
		return `/api/phone/identities/${waId}/chats/${phoneNumberId}`;
	}

	async function sendFromPhone(waId: string, body: unknown): Promise<Response> {
		return fixture.app.request(`${chatPath(waId)}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function sendFromBusiness(to: string, text: string): Promise<string> {
		const response = await fixture.app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
		});
		const sent = await readJson<{ messages: [{ id: string }] }>(response);

		return sent.messages[0].id;
	}

	async function markDelivered(messageId: string): Promise<void> {
		const response = await fixture.app.request(`/api/messages/${messageId}/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ status: "delivered" }),
		});

		expect(response.status).toBe(200);
	}

	async function history(waId: string): Promise<{ id: string; direction: string; status: string }[]> {
		const response = await fixture.app.request(`${chatPath(waId)}/messages`);

		return conversationMessagesResponseSchema.parse(await response.json()).data;
	}

	it("lists every contact as an identity, with its role and display number", async () => {
		await fixture.app.request(`/api/contacts/${ANA}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ role: "CUSTOMER", displayNumber: "+55 71 99000-0001" }),
		});

		const response = await fixture.app.request("/api/phone/identities");
		const body = phoneIdentityListResponseSchema.parse(await response.json());

		expect(body.data.map(contact => contact.waId)).toEqual([ANA, BRUNO]);
		expect(body.data[0]).toMatchObject({ role: "CUSTOMER", displayNumber: "+55 71 99000-0001" });
		expect(body.data[1]).toMatchObject({ role: null, displayNumber: null });
	});

	it("lists a chat per business number, even before any message", async () => {
		const response = await fixture.app.request(`/api/phone/identities/${ANA}/chats`);
		const body = phoneChatListResponseSchema.parse(await response.json());

		expect(body.data).toEqual([
			{
				id: `${fixture.phoneNumberId}:${ANA}`,
				phoneNumberId: fixture.phoneNumberId,
				businessName: expect.any(String) as string,
				displayPhoneNumber: expect.any(String) as string,
				lastMessage: null,
				unreadCount: 0,
			},
		]);
	});

	it("sends as the identity in the path, whatever the body says", async () => {
		const response = await sendFromPhone(ANA, {
			type: "text",
			text: { body: "Is my order ready?" },
			from: BRUNO,
			phoneNumberId: "999",
		});

		expect(response.status).toBe(201);

		const { data: message } = inboundResponseSchema.parse(await response.json());

		expect(message).toMatchObject({
			direction: "inbound",
			contactWaId: ANA,
			phoneNumberId: fixture.phoneNumberId,
			payload: { text: { body: "Is my order ready?" } },
		});
		expect(message.id).toMatch(/^wamid\./);
		expect(await history(ANA)).toHaveLength(1);
		expect(await history(BRUNO)).toHaveLength(0);
	});

	// WaSandbox never answers for the app: with no WASANDBOX_WEBHOOK_URL (this fixture's setting) the
	// message is stored and shown, the delivery is only logged, and nothing replies.
	it("stores a phone's message without a webhook receiver, and nothing replies to it", async () => {
		expect(fixture.config.webhookUrl).toBeUndefined();

		const response = await sendFromPhone(ANA, { type: "text", text: { body: "anyone there?" } });

		expect(response.status).toBe(201);
		await fixture.services.domain.tasks.whenIdle();

		const messages = await history(ANA);

		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ direction: "inbound" });

		const deliveries = await fixture.app.request("/api/webhook-deliveries");
		const logged = await readJson<{ data: { skipped: boolean; url: string }[] }>(deliveries);

		expect(logged.data).toHaveLength(1);
		expect(logged.data[0]).toMatchObject({ skipped: true, url: "" });
	});

	it("refuses an invalid message, an unknown identity and an unknown business number", async () => {
		expect(await statusOf(sendFromPhone(ANA, { type: "text", text: {} }))).toBe(400);
		expect(await statusOf(sendFromPhone(ANA, ["not", "an", "object"]))).toBe(400);
		expect(await statusOf(sendFromPhone("15550000000", { type: "text", text: { body: "hi" } }))).toBe(404);
		expect(await statusOf(fixture.app.request("/api/phone/identities/15550000000/chats"))).toBe(404);
		const unknownBusiness = `${chatPath(ANA, "999")}/messages`;

		expect(await statusOf(fixture.app.request(unknownBusiness))).toBe(404);
	});

	it("keeps each identity's history to its own conversation", async () => {
		await sendFromBusiness(ANA, "Hello Ana");
		await sendFromBusiness(BRUNO, "Hello Bruno");

		const ana = await history(ANA);
		const bruno = await history(BRUNO);

		expect(ana).toHaveLength(1);
		expect(bruno).toHaveLength(1);
		expect(ana[0]!.id).not.toBe(bruno[0]!.id);
	});

	it("counts delivered business messages as unread, and reading the chat moves them to read", async () => {
		const first = await sendFromBusiness(ANA, "one");
		const second = await sendFromBusiness(ANA, "two");

		await markDelivered(first);
		await markDelivered(second);

		const listed = await fixture.app.request(`/api/phone/identities/${ANA}/chats`);
		const chats = phoneChatListResponseSchema.parse(await listed.json());

		expect(chats.data[0]).toMatchObject({ unreadCount: 2, lastMessage: { id: second } });

		const response = await fixture.app.request(`${chatPath(ANA)}/read`, { method: "POST" });

		expect(phoneReadResponseSchema.parse(await response.json())).toEqual({ data: { read: 2 } });
		const afterReading = await history(ANA);

		expect(afterReading.map(message => message.status)).toEqual(["read", "read"]);

		const again = await fixture.app.request(`${chatPath(ANA)}/read`, { method: "POST" });

		expect(phoneReadResponseSchema.parse(await again.json())).toEqual({ data: { read: 0 } });
	});

	it("does not read a business message that has not reached the phone", async () => {
		await sendFromBusiness(ANA, "still travelling");

		const response = await fixture.app.request(`${chatPath(ANA)}/read`, { method: "POST" });

		expect(phoneReadResponseSchema.parse(await response.json())).toEqual({ data: { read: 0 } });

		const [message] = await history(ANA);

		expect(message!.status).not.toBe("read");
	});
});

describe("GET /api/phone/identities/:waId/ws", () => {
	let fixture: TestApp;
	let server: ServerType;
	let webSocketServer: WebSocketServer;
	let baseUrl: string;
	const clients: WebSocket[] = [];

	beforeEach(async () => {
		fixture = await createTestApp();
		webSocketServer = new WebSocketServer({ noServer: true });
		server = await new Promise<ServerType>(resolve => {
			const created = serve(
				{ fetch: fixture.consoleApp.fetch, hostname: "127.0.0.1", port: 0, websocket: { server: webSocketServer } },
				() => {
					resolve(created);
				},
			);
		});
		baseUrl = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.close();
		}

		webSocketServer.close();
		await new Promise<void>(resolve => {
			server.close(() => {
				resolve();
			});
		});
		await fixture.close();
	});

	async function connect(waId: string): Promise<WsEvent[]> {
		const received: WsEvent[] = [];
		const client = new WebSocket(`ws://${baseUrl}/api/phone/identities/${waId}/ws`);

		clients.push(client);
		client.addEventListener("message", event => {
			const frame: unknown = JSON.parse(String(event.data));

			received.push(wsEventSchema.parse(frame));
		});

		await new Promise<void>((resolve, reject) => {
			client.addEventListener("open", () => {
				resolve();
			});
			client.addEventListener("error", () => {
				reject(new Error("the websocket connection failed"));
			});
		});

		return received;
	}

	async function sendFromPhone(waId: string, text: string): Promise<void> {
		const response = await fixture.app.request(
			`/api/phone/identities/${waId}/chats/${fixture.phoneNumberId}/messages`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "text", text: { body: text } }),
			},
		);

		expect(response.status).toBe(201);
	}

	it("pushes only the identity's own conversation, never the developer streams", async () => {
		const ana = await connect(ANA);
		const bruno = await connect(BRUNO);

		await sendFromPhone(ANA, "from Ana");
		await sendFromPhone(BRUNO, "from Bruno");

		await expect.poll(() => ana.some(event => event.type === "message.created"), { timeout: 2000 }).toBe(true);
		await expect.poll(() => bruno.some(event => event.type === "message.created"), { timeout: 2000 }).toBe(true);

		const contactsOf = (events: WsEvent[]): string[] => {
			const messages = events.filter(
				event => event.type === "message.created" || event.type === "message.status_changed",
			);

			return messages.map(event => event.payload.message.contactWaId);
		};

		expect(new Set(contactsOf(ana))).toEqual(new Set([ANA]));
		expect(new Set(contactsOf(bruno))).toEqual(new Set([BRUNO]));
		expect([...ana, ...bruno].some(event => event.type === "webhook.delivery")).toBe(false);
	});

	it("refuses an unknown identity before upgrading", async () => {
		const response = await fixture.consoleApp.request("/api/phone/identities/15550000000/ws");

		expect(response.status).toBe(404);
	});
});
