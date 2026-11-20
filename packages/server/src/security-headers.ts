import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./app-env.ts";

/**
 * Browser hardening for the console listener in public mode (SPEC §7, "Browser hardening";
 * architecture AC-19). Pages set their own Content-Security-Policy — the phone, the admin
 * sign-in and the console each have one — and this fills in what every response should carry
 * when its route did not say otherwise.
 */

/**
 * The admin console's policy: the same shape as the phone's, plus images and media over HTTPS,
 * because a message the app under test sent `by link` renders straight from its URL. Nothing
 * runs that this origin did not serve; nothing frames it.
 */
export const CONSOLE_CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: https:",
	"media-src 'self' blob: https:",
	"connect-src 'self'",
	"font-src 'self' data:",
	"object-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
].join("; ");

function setDefault(headers: Headers, name: string, value: string): void {
	if (!headers.has(name)) {
		headers.set(name, value);
	}
}

/**
 * - `nosniff` everywhere, so no response is ever read as a type it was not served as;
 * - `Cross-Origin-Resource-Policy: same-origin`, so another site cannot embed what this one serves;
 * - `no-store` on the API, whose answers carry a visitor's CSRF token and messages;
 * - on HTML, no framing and a browsing context of its own (`Cross-Origin-Opener-Policy`).
 */
export function createSecurityHeaders(): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		await next();

		// A WebSocket upgrade's 101 has no body for any of this to protect.
		if (c.res.status === 101) {
			return;
		}

		const { headers } = c.res;

		setDefault(headers, "X-Content-Type-Options", "nosniff");
		setDefault(headers, "Cross-Origin-Resource-Policy", "same-origin");

		if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
			setDefault(headers, "Cache-Control", "no-store");
		}

		if (headers.get("content-type")?.startsWith("text/html") === true) {
			setDefault(headers, "X-Frame-Options", "DENY");
			setDefault(headers, "Cross-Origin-Opener-Policy", "same-origin");
			setDefault(headers, "Referrer-Policy", "same-origin");
		}
	};
}
