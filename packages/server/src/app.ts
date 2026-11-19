import { Hono } from "hono";
import type { AppEnv } from "./app-env.ts";
import type { DomainServices } from "./composition.ts";
import type { AppConfig } from "./config/index.ts";
import { createControlRoutes, createHealthRoutes } from "./control-api/index.ts";
import { AdminSessions, createAccessGate } from "./control-api/access.ts";
import { createAdminRoutes } from "./control-api/admin-routes.ts";
import { createVisitorMediaGuard } from "./control-api/visitor-routes.ts";
import { MEDIA_DOWNLOAD_PATH } from "./domain/index.ts";
import {
	createGraphRequestLogger,
	createGraphRoutes,
	createMediaDownloadRoutes,
	GRAPH_VERSION_PATH,
} from "./graph-api/index.ts";
import { createRequestLogger, type Logger } from "./logging/index.ts";
import { createWebUiRoutes, hasWebUiBundle, phoneAssetsOf } from "./web-ui.ts";

export interface CreateAppOptions {
	logger: Logger;
	config: AppConfig;
	services: DomainServices;
}

/** The two listeners mockwa runs (SPEC §8), both over the same engine. */
export interface MockwaApps {
	/** `MOCKWA_GRAPH_PORT` (8888): the Meta-shaped surface the app under test calls. */
	graph: Hono<AppEnv>;
	/** `MOCKWA_CONSOLE_PORT` (8025): the control plane, its WebSocket and the web UI. */
	console: Hono<AppEnv>;
}

/** The pieces both listeners share: request logging, `/health` and the last-resort error handler. */
function createListenerApp(logger: Logger): Hono<AppEnv> {
	const app = new Hono<AppEnv>();

	app.use(createRequestLogger(logger));
	// The Docker HEALTHCHECK probes each port's root alias.
	app.route("/", createHealthRoutes());

	app.onError((error, c) => {
		c.var.logger.error({ err: error }, "unhandled error while serving request");

		// Both surfaces register their own error handler; this one only sees what escaped
		// them, which is a bug in mockwa.
		return c.json({ error: { message: "Internal Server Error" } }, 500);
	});

	return app;
}

/**
 * The media byte endpoint, mounted on both listeners. The Graph listener is where the URLs in
 * media descriptors point (`MOCKWA_PUBLIC_URL`); the console serves the same bytes because the
 * UI loads previews from its own origin (SPEC §8). The URLs carry an unguessable token and no
 * bearer token, so the second mount exposes nothing the first does not.
 */
function mountMediaDownloads(app: Hono<AppEnv>, services: DomainServices): void {
	app.route(
		"/",
		createMediaDownloadRoutes({ media: services.media, uploads: services.uploads, injection: services.injection }),
	);
}

/** Port 8888: Graph API routes and media bytes, nothing a browser console uses. */
export function createGraphApp(options: CreateAppOptions): Hono<AppEnv> {
	const app = createListenerApp(options.logger);

	// Before every route, so rejected requests are logged with their error envelope too.
	app.use(createGraphRequestLogger(options.services.graphRequests));

	// The same router answers every `/v<major>.<minor>` prefix (SPEC §1.1); the media byte
	// endpoint sits outside it because the URLs it serves are opaque to the consumer.
	app.route(
		GRAPH_VERSION_PATH,
		createGraphRoutes({
			objects: options.services.objects,
			messages: options.services.messages,
			readReceipts: options.services.readReceipts,
			media: options.services.media,
			uploads: options.services.uploads,
			templates: options.services.templates,
			phoneNumbers: options.services.phoneNumbers,
			businessProfiles: options.services.businessProfiles,
			subscribedApps: options.services.subscribedApps,
			tokens: options.services.tokens,
			injection: options.services.injection,
			publicUrl: options.config.publicUrl,
		}),
	);
	mountMediaDownloads(app, options.services);

	return app;
}

/**
 * Port 8025: the control plane (REST + WebSocket), media previews and the static web UI.
 *
 * In public mode, or in dev mode with `MOCKWA_ADMIN_TOKEN` set, an access gate stands in front
 * of everything (SPEC §7, "Access modes"; the route inventory is docs/access.md): visitors reach
 * the phone and its API, the admin reaches the rest. With neither, nothing is mounted in front
 * and the console is as open as it always was.
 */
export function createConsoleApp(options: CreateAppOptions): Hono<AppEnv> {
	const app = createListenerApp(options.logger);
	const { access } = options.config;
	const isPublic = access.mode === "public";

	if (isPublic || access.adminToken !== undefined) {
		const admins = new AdminSessions({ token: access.adminToken, now: () => new Date() });
		const phoneAssets = isPublic ? phoneAssetsOf(options.config.webDir) : new Set<string>();

		app.use(createAccessGate({ access, admins, isPhoneAsset: assetPath => phoneAssets.has(assetPath) }));
		app.route("/", createAdminRoutes({ access, admins }));
	}

	if (isPublic) {
		app.use(
			`${MEDIA_DOWNLOAD_PATH}/*`,
			createVisitorMediaGuard({ sessions: options.services.visitors, media: options.services.media }),
		);
	}

	app.route("/api", createControlRoutes({ services: options.services, logger: options.logger, access }));
	mountMediaDownloads(app, options.services);

	// Last, so every surface above keeps its paths: the UI's SPA fallback only answers what
	// nothing else claimed (SPEC §8). Without a built bundle — `npm run dev`, where Vite serves
	// the UI and proxies back here — `/` simply stays unrouted.
	if (hasWebUiBundle(options.config.webDir)) {
		app.route("/", createWebUiRoutes({ webDir: options.config.webDir, isPublic }));
	} else {
		options.logger.warn(
			{ webDir: options.config.webDir },
			"no web UI bundle found: run `npm run build --workspace @mockwa/web`, or use the Vite dev server",
		);
	}

	return app;
}

/** Composes both listeners over one set of domain services. */
export function createApps(options: CreateAppOptions): MockwaApps {
	return { graph: createGraphApp(options), console: createConsoleApp(options) };
}
