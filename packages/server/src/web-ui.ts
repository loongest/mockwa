import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type MiddlewareHandler } from "hono";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppEnv } from "./app-env.ts";
import { CONSOLE_CONTENT_SECURITY_POLICY } from "./security-headers.ts";

export interface WebUiRoutesOptions {
	/** Absolute path to the built Vite bundle (`packages/web/dist`). */
	webDir: string;
	/**
	 * Public demo mode (SPEC §7): the phone page carries a strict Content-Security-Policy, and
	 * the bundle's build metadata is not served. Which files a visitor may load is the access
	 * gate's call (`control-api/access.ts`), made with {@link phoneAssetsOf}.
	 */
	isPublic?: boolean;
}

/**
 * The phone page's policy in public mode: everything from this origin only, no inline script,
 * no plugins, no framing. Inline styles stay allowed because React sets `style` attributes.
 * `connect-src 'self'` covers the page's own WebSocket in current browsers.
 */
export const PHONE_CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"connect-src 'self'",
	"font-src 'self'",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
].join("; ");

/** Vite's build manifest (`build.manifest`): each chunk, the chunks it imports, its CSS and assets. */
interface ManifestChunk {
	file: string;
	imports?: string[];
	css?: string[];
	assets?: string[];
}

/**
 * The files the phone page loads (SPEC §7, "Access modes"): its entry chunk and, transitively,
 * every chunk it imports with their CSS and assets — read from Vite's manifest, so a visitor in
 * public mode can load the phone and nothing of the console's bundle. The top-level files of
 * `public/` (the favicon) are shared and allowed too. An empty set when there is no manifest:
 * then no static file is a visitor's, which fails closed.
 */
export function phoneAssetsOf(webDir: string): ReadonlySet<string> {
	const allowed = new Set<string>();
	let manifest: Record<string, ManifestChunk>;

	try {
		manifest = JSON.parse(readFileSync(path.join(webDir, ".vite", "manifest.json"), "utf8")) as Record<
			string,
			ManifestChunk
		>;
	} catch {
		return allowed;
	}

	const visit = (key: string): void => {
		const chunk = manifest[key];

		if (chunk === undefined || allowed.has(`/${chunk.file}`)) {
			return;
		}

		allowed.add(`/${chunk.file}`);

		const files = [chunk.css, chunk.assets].flat().filter(file => file !== undefined);

		for (const file of files) {
			allowed.add(`/${file}`);
		}

		if (chunk.imports != null) {
			for (const imported of chunk.imports) {
				visit(imported);
			}
		}
	};

	visit("phone.html");

	const entries = readdirSync(webDir, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.isFile() && !entry.name.endsWith(".html")) {
			allowed.add(`/${entry.name}`);
		}
	}

	return allowed;
}

/**
 * The paths the single whaloc port already owns (SPEC §8). The SPA fallback must never
 * shadow them: a typo in an API path has to come back as whaloc's 404, not as the UI's
 * `index.html` with a 200 — the failure mode that makes a fetch client report "unexpected
 * token <" instead of the mistake.
 */
const RESERVED_PATHS = [/^\/api(?:\/|$)/, /^\/v\d+\.\d+(?:\/|$)/, /^\/whaloc-media(?:\/|$)/, /^\/health$/];

export function isReservedPath(pathname: string): boolean {
	return RESERVED_PATHS.some(pattern => pattern.test(pathname));
}

/** Vite fingerprints everything under `assets/`; the entry document must never be cached. */
const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const REVALIDATE_CACHE_CONTROL = "no-cache";

export function cacheControlFor(pathname: string): string {
	return pathname.startsWith(IMMUTABLE_PREFIX) ? IMMUTABLE_CACHE_CONTROL : REVALIDATE_CACHE_CONTROL;
}

/**
 * `serveStatic` builds its response before it calls `onFound`, so a header set from there
 * never lands; this wraps the handler and stamps the response it actually returns.
 */
function cached(
	handler: MiddlewareHandler<AppEnv>,
	cacheControl: (pathname: string) => string,
): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const response = await handler(c, next);

		if (response instanceof Response) {
			response.headers.set("Cache-Control", cacheControl(c.req.path));
		}

		return response;
	};
}

/**
 * Serves the built web UI at `/` (SPEC §5, §8), and the virtual phone at `/phone`.
 *
 * Two handlers: the first answers with the file when one exists, the second answers every
 * other in-app route (`/w/:wabaId/p/:phoneNumberId/chats`, `/settings`, …) with `index.html` so a deep link and a
 * reload work — react-router does the rest in the browser. Mounted last in `createApp`,
 * after the surfaces whose paths are reserved above.
 *
 * In development the UI is served by Vite instead, which proxies those same paths here; a
 * missing `dist` is therefore not an error, it just leaves `/` unrouted.
 */
export function createWebUiRoutes(options: WebUiRoutesOptions): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();
	const file = cached(serveStatic<AppEnv>({ root: options.webDir }), cacheControlFor);
	const consoleFile = cached(
		serveStatic<AppEnv>({ root: options.webDir, path: "index.html" }),
		() => REVALIDATE_CACHE_CONTROL,
	);
	// Public mode: only a signed-in admin ever gets here (the access gate), under its own policy.
	const index: MiddlewareHandler<AppEnv> =
		options.isPublic === true
			? async (c, next) => {
					const response = await consoleFile(c, next);

					if (response instanceof Response) {
						response.headers.set("Content-Security-Policy", CONSOLE_CONTENT_SECURITY_POLICY);
					}

					return response;
				}
			: consoleFile;
	const phoneFile = cached(
		serveStatic<AppEnv>({ root: options.webDir, path: "phone.html" }),
		() => REVALIDATE_CACHE_CONTROL,
	);
	const phone: MiddlewareHandler<AppEnv> =
		options.isPublic === true
			? async (c, next) => {
					const response = await phoneFile(c, next);

					if (response instanceof Response) {
						response.headers.set("Content-Security-Policy", PHONE_CONTENT_SECURITY_POLICY);
						response.headers.set("X-Content-Type-Options", "nosniff");
						response.headers.set("Referrer-Policy", "no-referrer");
					}

					return response;
				}
			: phoneFile;

	const spaFallback: MiddlewareHandler<AppEnv> = async (c, next) =>
		isReservedPath(c.req.path) ? next() : index(c, next);

	if (options.isPublic === true) {
		// Build metadata names every file of both bundles; nobody's browser needs it.
		routes.get("/.vite/*", c => c.text("Not Found", 404));
	}

	// `/` itself is answered here, as the directory's index.html: the console page all the same.
	const staticFile: MiddlewareHandler<AppEnv> =
		options.isPublic === true
			? async (c, next) => {
					const response = await file(c, next);

					if (response instanceof Response && response.headers.get("content-type")?.startsWith("text/html") === true) {
						response.headers.set("Content-Security-Policy", CONSOLE_CONTENT_SECURITY_POLICY);
					}

					return response;
				}
			: file;

	routes.use("*", staticFile);
	// The virtual phone is a page of its own, not a route of the console's SPA (SPEC §5).
	routes.get("/phone", phone);
	routes.get("/phone/*", phone);
	routes.get("*", spaFallback);

	return routes;
}

/** Whether {@link createWebUiRoutes} has anything to serve: `npm run build --workspace @wasandbox/web` ran. */
export function hasWebUiBundle(webDir: string): boolean {
	return existsSync(path.join(webDir, "index.html"));
}
