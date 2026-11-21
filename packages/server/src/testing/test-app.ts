import { Hono } from "hono";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pino } from "pino";
import type { AppEnv } from "../app-env.ts";
import { createApps } from "../app.ts";
import { createServices, type AppServices } from "../composition.ts";
import { canonicalEnvKey, parseConfig, type AppConfig } from "../config/index.ts";
import type { Scheduler } from "../domain/index.ts";

/**
 * The fixture the Graph API integration tests run against: the real composed app, on an
 * in-memory database and a throwaway media directory (SPEC §8).
 *
 * Nothing is stubbed. A test drives the app the way the consumer does — through
 * `app.request()` — so the assertions are about the bytes on the wire, envelopes included.
 */
export interface TestApp {
	/**
	 * Both listeners behind one `request()`: each request is handed, untouched, to the listener
	 * that owns its path in production — `/v<major>.<minor>/…` to the Graph app, everything
	 * else to the console app. Specs that test which port answers what use the two apps below.
	 */
	app: Hono<AppEnv>;
	/** The port-8888 app on its own (SPEC §8). */
	graphApp: Hono<AppEnv>;
	/** The port-8025 app on its own (SPEC §8). */
	consoleApp: Hono<AppEnv>;
	services: AppServices;
	config: AppConfig;
	/** Ids from the built-in seed, which is what the tests address. */
	wabaId: string;
	phoneNumberId: string;
	mediaDir: string;
	close: () => Promise<void>;
}

/** Any non-empty token is accepted (SPEC §1.9); tests use this one unless they test auth. */
export const TEST_AUTH_HEADERS = { authorization: "Bearer test-token" } as const;

/** The public base URL the fixture is configured with; media URLs and `paging.next` use it. */
export const TEST_PUBLIC_URL = "http://localhost:9999";

export interface CreateTestAppOptions {
	/**
	 * Drives every clock the services read — which is what makes the media TTL (SPEC §4)
	 * testable: rows are still stamped by the real clock, so a spec uploads, moves this one
	 * forward, and asserts on the boundary without waiting for it.
	 */
	scheduler?: Scheduler;
}

const GRAPH_PATH = /^\/v\d+\.\d+(?:\/|$)/;

function dispatchByPath(graph: Hono<AppEnv>, console: Hono<AppEnv>): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.all("*", c => (GRAPH_PATH.test(c.req.path) ? graph : console).fetch(c.req.raw, c.env));

	return app;
}

/**
 * The fixture's defaults are spelled `WASANDBOX_*`, and a `WASANDBOX_*` name beats its alias, so a
 * spec overriding one through its `WHALOC_*` spelling also gets the `WASANDBOX_*` copy that wins.
 */
function withCanonicalNames(env: Record<string, string>): Record<string, string> {
	const overrides: Record<string, string> = { ...env };

	for (const [key, value] of Object.entries(env)) {
		const canonical = canonicalEnvKey(key);

		if (canonical !== undefined && !Object.hasOwn(env, canonical)) {
			overrides[canonical] = value;
		}
	}

	return overrides;
}

export async function createTestApp(
	env: Record<string, string> = {},
	options: CreateTestAppOptions = {},
): Promise<TestApp> {
	const mediaDir = await mkdtemp(path.join(tmpdir(), "whaloc-test-media-"));
	// Through `parseConfig`, not the bare schema, so a spec may name a variable by either
	// prefix exactly as an operator would (SPEC §7).
	const parsed = parseConfig({
		WASANDBOX_DB_PATH: ":memory:",
		WASANDBOX_MEDIA_DIR: mediaDir,
		WASANDBOX_PUBLIC_URL: TEST_PUBLIC_URL,
		WASANDBOX_LOG_LEVEL: "silent",
		// A directory that does not exist: the API surfaces are tested without the static UI
		// in front of them, so an unrouted path is a 404 and not the SPA fallback. The web UI
		// spec points this at a fixture instead.
		WASANDBOX_WEB_DIR: path.join(mediaDir, "no-web-bundle"),
		// The specs written before M3 send to contacts that never wrote and assert on the ladder
		// that follows; the window's own specs pass `WASANDBOX_SERVICE_WINDOW` to switch it back on.
		// The shipped default (24h) is pinned by the configuration spec.
		WASANDBOX_SERVICE_WINDOW: "off",
		...withCanonicalNames(env),
	});

	if (!parsed.success) {
		throw new Error(`invalid test configuration:\n${parsed.errors.join("\n")}`);
	}

	const { config } = parsed;
	const logger = pino({ enabled: false });
	const services = await createServices({
		config,
		logger,
		...(options.scheduler !== undefined && { scheduler: options.scheduler }),
	});
	const waba = services.seed.wabas[0]!;

	const apps = createApps({ logger, config, services: services.domain });

	return {
		app: dispatchByPath(apps.graph, apps.console),
		graphApp: apps.graph,
		consoleApp: apps.console,
		services,
		config,
		wabaId: waba.id,
		phoneNumberId: waba.phoneNumbers[0]!.id,
		mediaDir,
		close: async () => {
			await services.close();
			await rm(mediaDir, { recursive: true, force: true });
		},
	};
}
