import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { GOING_AWAY } from "./websocket-shutdown.ts";

/**
 * The real process, end to end: `main.ts` started the way `npm run dev` starts it, two live
 * WebSockets open (a console and a virtual phone), then `SIGTERM` — what `docker stop` sends.
 * An open WebSocket used to hold the listeners open until the 10-second deadline killed the
 * process with exit code 1 and the clients saw an abnormal `1006`.
 */

const MAIN = fileURLToPath(new URL("main.ts", import.meta.url));
const SHUTDOWN_DEADLINE_MS = 10_000;
const DEFAULT_PHONE_WA_ID = "5571990000001";

/** Every process a test started, killed afterwards whatever happened. */
const started: ChildProcess[] = [];

afterEach(() => {
	for (const process of started.splice(0)) {
		process.kill("SIGKILL");
	}
});

async function freePort(): Promise<number> {
	const server = createServer();

	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

	const { port } = server.address() as AddressInfo;

	await new Promise(resolve => server.close(resolve));

	return port;
}

async function startMockwa(consolePort: number, graphPort: number): Promise<ChildProcess> {
	const mockwa = spawn(
		process.execPath,
		["--experimental-transform-types", "--disable-warning=ExperimentalWarning", "--conditions=development", MAIN],
		{
			env: {
				PATH: process.env["PATH"],
				MOCKWA_HOST: "127.0.0.1",
				MOCKWA_GRAPH_PORT: String(graphPort),
				MOCKWA_CONSOLE_PORT: String(consolePort),
				MOCKWA_DB_PATH: ":memory:",
				MOCKWA_LOG_LEVEL: "info",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	await new Promise<void>((resolve, reject) => {
		let output = "";

		mockwa.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");

			if (output.includes("console listening")) {
				resolve();
			}
		});
		mockwa.once("exit", code => {
			reject(new Error(`mockwa exited with ${String(code)} before listening:\n${output}`));
		});
	});

	started.push(mockwa);

	return mockwa;
}

/** Resolves once the socket is open, with a promise of the close code it will end with. */
async function openSocket(url: string): Promise<{ closed: Promise<number> }> {
	const socket = new WebSocket(url);
	const closed = new Promise<number>(resolve => {
		socket.once("close", code => {
			resolve(code);
		});
	});

	await new Promise((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});

	return { closed };
}

function exitOf(process: ChildProcess): Promise<number | null> {
	return new Promise(resolve => {
		process.once("exit", code => {
			resolve(code);
		});
	});
}

describe("shutting down with WebSockets open", () => {
	it("closes them cleanly and exits 0 well before the deadline", { timeout: 30_000 }, async () => {
		const consolePort = await freePort();
		const graphPort = await freePort();

		const child = await startMockwa(consolePort, graphPort);

		const base = `ws://127.0.0.1:${String(consolePort)}/api`;
		const { closed: consoleClosed } = await openSocket(`${base}/ws`);
		const { closed: phoneClosed } = await openSocket(`${base}/phone/identities/${DEFAULT_PHONE_WA_ID}/ws`);
		const exited = exitOf(child);
		const startedAt = performance.now();

		child.kill("SIGTERM");

		expect(await exited).toBe(0);
		expect(performance.now() - startedAt).toBeLessThan(SHUTDOWN_DEADLINE_MS / 2);
		expect(await consoleClosed).toBe(GOING_AWAY);
		expect(await phoneClosed).toBe(GOING_AWAY);
	});
});
