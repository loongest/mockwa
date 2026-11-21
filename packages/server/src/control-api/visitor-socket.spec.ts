import { serve, type ServerType } from "@hono/node-server";
import { wsEventSchema, type WsEvent } from "@wasandbox/shared";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import { createTestApp, type TestApp } from "../testing/test-app.ts";
import { ADMIN_HEADERS, PUBLIC_ENV, TEST_GRAPH_TOKEN } from "../testing/visitor-client.ts";

/**
 * A visitor's live stream (SPEC §5, "Public demo mode"; AC-15): over a real listener, because
 * the upgrade, the origin check and the close on session end only exist on a socket.
 */
describe("visitor sockets", () => {
	let fixture: TestApp;
	let server: ServerType;
	let webSocketServer: WebSocketServer;
	let host: string;
	const clients: NodeWebSocket[] = [];

	beforeEach(async () => {
		fixture = await createTestApp({ ...PUBLIC_ENV, WASANDBOX_STATUS_DELAYS: "sent:0,delivered:0" });
		webSocketServer = new WebSocketServer({ noServer: true });
		server = await new Promise<ServerType>(resolve => {
			const created = serve(
				{ fetch: fixture.consoleApp.fetch, hostname: "127.0.0.1", port: 0, websocket: { server: webSocketServer } },
				() => {
					resolve(created);
				},
			);
		});
		host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
	});

	afterEach(async () => {
		for (const client of clients.splice(0)) {
			client.terminate();
		}

		webSocketServer.close();
		await new Promise<void>(resolve => {
			server.close(() => {
				resolve();
			});
		});
		await fixture.close();
	});

	/** A visitor whose session is created over the real listener, so its cookie is the listener's. */
	async function startVisitor(): Promise<{ cookie: string; waId: string; csrfToken: string }> {
		const response = await fetch(`http://${host}/api/public/session`, {
			method: "POST",
			headers: { origin: `http://${host}` },
		});
		const cookie = response.headers
			.getSetCookie()
			.find(header => header.startsWith("wasandbox_visitor="))!
			.split(";", 1)[0]!;
		const body = (await response.json()) as { data: { identities: { waId: string }[]; csrfToken: string } };

		return { cookie, waId: body.data.identities[0]!.waId, csrfToken: body.data.csrfToken };
	}

	interface Opened {
		events: WsEvent[];
		closed: Promise<number>;
	}

	async function open(path: string, headers: Record<string, string>): Promise<Opened | number> {
		const client = new NodeWebSocket(`ws://${host}${path}`, { headers });
		const events: WsEvent[] = [];

		clients.push(client);
		// A refused upgrade also emits `error`; the status it carried is what the specs assert.
		client.on("error", () => {});
		client.on("message", (data: Buffer) => {
			const frame: unknown = JSON.parse(data.toString("utf8"));

			events.push(wsEventSchema.parse(frame));
		});

		const closed = new Promise<number>(resolve => {
			client.on("close", code => {
				resolve(code);
			});
		});

		return new Promise<Opened | number>(resolve => {
			client.on("open", () => {
				resolve({ events, closed });
			});
			client.on("unexpected-response", (_request, response) => {
				resolve(response.statusCode ?? 0);
			});
		});
	}

	async function send(visitor: { cookie: string; waId: string; csrfToken: string }, text: string): Promise<void> {
		const response = await fetch(
			`http://${host}/api/phone/identities/${visitor.waId}/chats/${fixture.phoneNumberId}/messages`,
			{
				method: "POST",
				headers: {
					cookie: visitor.cookie,
					origin: `http://${host}`,
					"x-csrf-token": visitor.csrfToken,
					"content-type": "application/json",
				},
				body: JSON.stringify({ type: "text", text: { body: text } }),
			},
		);

		expect(response.status).toBe(201);
	}

	it("streams only the visitor's own conversation, and nothing world-wide", async () => {
		const ana = await startVisitor();
		const bruno = await startVisitor();
		const anaSocket = await open(`/api/phone/identities/${ana.waId}/ws`, {
			cookie: ana.cookie,
			origin: `http://${host}`,
		});
		const brunoSocket = await open(`/api/phone/identities/${bruno.waId}/ws`, {
			cookie: bruno.cookie,
			origin: `http://${host}`,
		});

		if (typeof anaSocket === "number" || typeof brunoSocket === "number") {
			throw new TypeError("the sockets should have opened");
		}

		await send(ana, "from ana");
		await send(bruno, "from bruno");
		await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { authorization: `Bearer ${TEST_GRAPH_TOKEN}`, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", to: bruno.waId, type: "text", text: { body: "hi bruno" } }),
		});
		// A world-wide change a developer phone would hear.
		await fixture.consoleApp.request(`/api/phone-numbers/${fixture.phoneNumberId}`, {
			method: "PATCH",
			headers: { ...ADMIN_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ verifiedName: "Renamed" }),
		});

		await expect.poll(() => brunoSocket.events.filter(event => event.type === "message.created").length).toBe(2);
		await expect.poll(() => anaSocket.events.some(event => event.type === "message.created")).toBe(true);

		const contactsOf = (events: WsEvent[]): Set<string> => {
			return new Set(
				events.flatMap(event => {
					return event.type === "message.created" || event.type === "message.status_changed"
						? [event.payload.message.contactWaId]
						: [];
				}),
			);
		};

		expect(contactsOf(anaSocket.events)).toEqual(new Set([ana.waId]));
		expect(contactsOf(brunoSocket.events)).toEqual(new Set([bruno.waId]));

		const types = new Set([...anaSocket.events, ...brunoSocket.events].map(event => event.type));

		expect(types.has("phone_number.changed")).toBe(false);
		expect(types.has("webhook.delivery")).toBe(false);
	});

	it("refuses a socket for another visitor's identity, without a session, or from another origin", async () => {
		const ana = await startVisitor();
		const bruno = await startVisitor();

		expect(await open(`/api/phone/identities/${bruno.waId}/ws`, { cookie: ana.cookie, origin: `http://${host}` })).toBe(
			404,
		);
		expect(await open(`/api/phone/identities/${ana.waId}/ws`, { origin: `http://${host}` })).toBe(401);
		expect(
			await open(`/api/phone/identities/${ana.waId}/ws`, { cookie: ana.cookie, origin: "https://evil.example" }),
		).toBe(403);
		expect(await open(`/api/phone/identities/${ana.waId}/ws`, { cookie: ana.cookie })).toBe(403);
	});

	it("refuses the unrestricted console stream without the admin token", async () => {
		const ana = await startVisitor();

		expect(await open("/api/ws", { cookie: ana.cookie, origin: `http://${host}` })).toBe(401);

		const admin = await open("/api/ws", { authorization: ADMIN_HEADERS.authorization });

		expect(typeof admin).toBe("object");
	});

	it("closes the visitor's sockets with 4401 when its session ends", async () => {
		const ana = await startVisitor();
		const socket = await open(`/api/phone/identities/${ana.waId}/ws`, { cookie: ana.cookie, origin: `http://${host}` });

		if (typeof socket === "number") {
			throw new TypeError("the socket should have opened");
		}

		const left = await fetch(`http://${host}/api/public/session`, {
			method: "DELETE",
			headers: { cookie: ana.cookie, origin: `http://${host}`, "x-csrf-token": ana.csrfToken },
		});

		expect(left.status).toBe(204);
		expect(await socket.closed).toBe(4401);
	});

	it("holds a session to its socket quota when the upgrades race, and frees the slots on close", async () => {
		const ana = await startVisitor();
		const path = `/api/phone/identities/${ana.waId}/ws`;
		const headers = { cookie: ana.cookie, origin: `http://${host}` };
		const results = await Promise.all(Array.from({ length: 20 }, async () => open(path, headers)));
		const opened = results.filter((result): result is Opened => typeof result !== "number");

		expect(opened).toHaveLength(8);
		expect(results.filter(result => result === 429)).toHaveLength(12);

		const stats = async (): Promise<{ sockets: number; socketsOpening: number; eventListeners: number }> => {
			const response = await fetch(`http://${host}/api/public/stats`, { headers: ADMIN_HEADERS });
			const body = (await response.json()) as {
				data: { sockets: number; socketsOpening: number; eventListeners: number };
			};

			return body.data;
		};

		const socketCount = async (): Promise<number> => {
			const current = await stats();

			return current.sockets;
		};

		await expect.poll(socketCount).toBe(8);

		const settled = await stats();

		expect(settled.socketsOpening).toBe(0);

		for (const client of clients.splice(0)) {
			client.close();
		}

		await expect.poll(socketCount).toBe(0);

		// Every slot is back: a new socket opens again.
		expect(typeof (await open(path, headers))).not.toBe("number");
	});
});
