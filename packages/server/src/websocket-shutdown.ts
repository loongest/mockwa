import type { WebSocketServer } from "ws";

/** RFC 6455 "going away": the server is shutting down, which is what a client should hear. */
export const GOING_AWAY = 1001;

/** How long a client gets to answer the close frame before its socket is cut. */
const DEFAULT_GRACE_MS = 2000;

/**
 * Says goodbye to every connected WebSocket client and resolves once they are all gone.
 *
 * An upgraded socket still counts as one of the HTTP server's connections, so a single open
 * console tab or virtual phone would keep `server.close()` waiting until the shutdown deadline
 * killed the process. Each client is sent a proper close frame — it sees `1001`, not an
 * abnormal `1006` — and one that does not answer within `graceMs` is terminated.
 */
export async function closeWebSocketClients(
	server: WebSocketServer,
	options: { graceMs?: number } = {},
): Promise<void> {
	const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
	const closing = [...server.clients].map(client => {
		return new Promise<void>(resolve => {
			const cut = setTimeout(() => {
				client.terminate();
			}, graceMs);

			client.once("close", () => {
				clearTimeout(cut);
				resolve();
			});
			client.close(GOING_AWAY, "server shutting down");
		});
	});

	await Promise.all(closing);
}
