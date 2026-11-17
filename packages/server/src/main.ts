import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { createApps } from "./app.ts";
import { createServices } from "./composition.ts";
import { collectConfigWarnings, describeConfig, parseConfig } from "./config/index.ts";
import { registerShutdownHandlers } from "./graceful-shutdown.ts";
import { createLogger } from "./logging/index.ts";
import { closeWebSocketClients } from "./websocket-shutdown.ts";

const configResult = parseConfig(process.env, filePath => readFileSync(filePath, "utf8"));

if (!configResult.success) {
	const details = configResult.errors.map(error => `  - ${error}`).join("\n");

	process.stderr.write(`mockwa cannot start, the environment is invalid:\n${details}\n`);
	process.exit(1);
}

const { config } = configResult;
const logger = createLogger(config);

for (const warning of collectConfigWarnings(config, process.env)) {
	logger.warn(warning);
}

logger.info(describeConfig(config), "configuration loaded");

// config → logger → database (migrate + seed) → app → listen.
let services;

try {
	services = await createServices({ config, logger });
} catch (error) {
	logger.fatal({ err: error }, "mockwa cannot start, the database is unusable");
	process.exit(1);
}

const apps = createApps({ logger, config, services: services.domain });
// `@hono/node-server` handles the WebSocket upgrade itself when it is given a `noServer`
// server; `control-api/ws-routes.ts` answers `GET /api/ws` through it (SPEC §5). Only the
// console listener gets one: the Graph port has no WebSocket surface.
const webSocketServer = new WebSocketServer({ noServer: true });

function logListening(name: string): (address: AddressInfo) => void {
	return address => {
		logger.info(`mockwa ${name} listening on http://${address.address}:${String(address.port)}`);
	};
}

// Two listeners, one engine (SPEC §8): the app under test only ever needs the Graph port.
const servers = [
	serve({ fetch: apps.graph.fetch, hostname: config.host, port: config.graphPort }, logListening("Graph API")),
	serve(
		{
			fetch: apps.console.fetch,
			hostname: config.host,
			port: config.consolePort,
			websocket: { server: webSocketServer },
		},
		logListening("console"),
	),
];

// The handshake is a startup nicety, never a startup requirement: mockwa is useful even when
// the app under test is not up yet (SPEC §1.13).
if (config.verifyOnStart) {
	services.domain.tasks.run(() => services.domain.webhooks.handshake());
}

function closeServer(server: (typeof servers)[number]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.close(error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

registerShutdownHandlers({
	logger,
	close: async () => {
		webSocketServer.close();

		// The listeners stop accepting first; the open WebSockets are then closed properly, which
		// is what lets the listeners finish closing at all.
		await Promise.all([...servers.map(server => closeServer(server)), closeWebSocketClients(webSocketServer)]);

		await services.close();
	},
});
