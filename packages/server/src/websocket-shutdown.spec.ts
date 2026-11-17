import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { closeWebSocketClients, GOING_AWAY } from "./websocket-shutdown.ts";

/** Every HTTP server a test started, closed afterwards. */
const servers: Server[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		await new Promise(resolve => {
			server.close(resolve);
		});
	}
});

async function listen(): Promise<{ wss: WebSocketServer; url: string; port: number }> {
	const wss = new WebSocketServer({ noServer: true });
	const server = createServer();

	server.on("upgrade", (request, socket, head) => {
		wss.handleUpgrade(request, socket, head, client => wss.emit("connection", client, request));
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);

	const { port } = server.address() as AddressInfo;

	return { wss, url: `ws://127.0.0.1:${String(port)}`, port };
}

async function openClient(url: string): Promise<{ client: WebSocket; closed: Promise<number> }> {
	const client = new WebSocket(url);
	const closed = new Promise<number>(resolve => {
		client.once("close", code => {
			resolve(code);
		});
	});

	await new Promise((resolve, reject) => {
		client.once("open", resolve);
		client.once("error", reject);
	});

	return { client, closed };
}

describe("closeWebSocketClients", () => {
	it("sends every client a going-away close frame and resolves when they are gone", async () => {
		const { wss, url } = await listen();
		const first = await openClient(url);
		const second = await openClient(url);

		await closeWebSocketClients(wss);

		expect(await first.closed).toBe(GOING_AWAY);
		expect(await second.closed).toBe(GOING_AWAY);
		expect(wss.clients.size).toBe(0);
	});

	it("resolves at once when nobody is connected", async () => {
		const { wss } = await listen();

		await expect(closeWebSocketClients(wss)).resolves.toBeUndefined();
	});

	it("cuts a client that never answers the close frame once the grace period is over", async () => {
		const { wss, port } = await listen();
		// A raw socket that completes the upgrade and then ignores everything, close frames included.
		const socket = connect(port, "127.0.0.1");
		const upgraded = new Promise<void>(resolve => {
			return socket.once("data", () => {
				resolve();
			});
		});

		socket.write(
			"GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
				"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
		);
		await upgraded;

		const startedAt = performance.now();

		await closeWebSocketClients(wss, { graceMs: 100 });

		expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
		expect(wss.clients.size).toBe(0);
		socket.destroy();
	});
});
