import { Hono, type Context } from "hono";
import type { AppEnv } from "../app-env.ts";
import type { AccessConfig } from "../config/index.ts";
import { bodyLimit } from "hono/body-limit";
import { clientIpOf, isAllowedOrigin, type AdminSessions } from "./access.ts";

export interface AdminRoutesOptions {
	access: AccessConfig;
	admins: AdminSessions;
}

/** What the page says for each `?error=` it redirects back with; anything else is generic. */
const SIGN_IN_ERRORS: Readonly<Record<string, string>> = {
	invalid: "Wrong admin token.",
	locked: "Too many wrong tokens. Wait a few minutes and try again.",
};

/**
 * The sign-in page is plain HTML with no script and no style beyond its own `<style>`: it must
 * work under the strictest CSP and must not ship any of the console's bundle to whoever opens
 * it. The form posts back to the listener, which sets the admin cookie and goes to `/`.
 */
function signInPage(error: string | null): string {
	const message =
		error === null
			? ""
			: `<p class="error" role="alert">${(Object.hasOwn(SIGN_IN_ERRORS, error) ? SIGN_IN_ERRORS[error] : undefined) ?? "Sign-in refused."}</p>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mockwa admin</title>
<style>
body{font-family:system-ui,sans-serif;background:#f4f5f7;color:#1c1e21;display:grid;place-items:center;min-height:100vh;margin:0}
form{background:#fff;padding:24px;border-radius:12px;box-shadow:0 1px 4px rgb(0 0 0/.15);display:grid;gap:12px;width:min(320px,90vw)}
input,button{font:inherit;padding:8px 10px;border-radius:8px;border:1px solid #ccd0d5}
button{background:#128c7e;color:#fff;border:0;cursor:pointer}
.error{color:#c0392b;margin:0}
@media (prefers-color-scheme:dark){body{background:#18191a;color:#e4e6eb}form{background:#242526}input{background:#3a3b3c;color:#e4e6eb;border-color:#3e4042}}
</style>
</head>
<body>
<form method="post" action="/api/admin/login">
<h1>mockwa admin</h1>
${message}
<label>Admin token <input type="password" name="token" autocomplete="current-password" required autofocus></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>`;
}

/** A token and a form field name; anything bigger is not a sign-in. */
const LOGIN_BODY_MAX_BYTES = 4096;

/** The headers every admin page carries: nothing loads from anywhere, nothing frames it. */
const SIGN_IN_HEADERS = {
	"Content-Security-Policy":
		"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	// Not `no-referrer`: under it a browser sends `Origin: null` with the form post, and the
	// sign-in's origin check could never pass.
	"Referrer-Policy": "same-origin",
} as const;

function tokenIn(value: unknown): string | null {
	if (value === null || typeof value !== "object") {
		return null;
	}

	const { token } = value as { token?: unknown };

	return typeof token === "string" ? token : null;
}

/** The submitted token, from a JSON body or the sign-in form; `null` for an unreadable body. */
async function readToken(c: Context<AppEnv>): Promise<string | null> {
	const isJson = (c.req.header("content-type") ?? "").includes("application/json");
	const read = isJson ? async () => c.req.json<unknown>() : async () => c.req.parseBody();
	let body: unknown;

	try {
		body = await read();
	} catch {
		return null;
	}

	return tokenIn(body);
}

/**
 * `GET /admin`, `POST /api/admin/login`, `POST /api/admin/logout` (SPEC §7, "Access modes").
 * Mounted only when an admin token is configured. A form post answers with a redirect (to `/`,
 * or back to the page with the error); a JSON post answers `204` or `401`, for scripts that
 * want a cookie rather than a header.
 */
export function createAdminRoutes(options: AdminRoutesOptions): Hono<AppEnv> {
	const routes = new Hono<AppEnv>();

	routes.get("/admin", c => {
		const error = c.req.query("error") ?? null;

		return c.html(signInPage(error), 200, SIGN_IN_HEADERS);
	});

	routes.post(
		"/api/admin/login",
		bodyLimit({
			maxSize: LOGIN_BODY_MAX_BYTES,
			onError: c => c.json({ error: { message: "the sign-in body is too large", code: "request_too_large" } }, 413),
		}),
		async c => {
			const isForm = !(c.req.header("content-type") ?? "").includes("application/json");

			// Signing a browser in is a write like any other: only from this listener's own page.
			if (!isAllowedOrigin(c, options.access)) {
				return isForm
					? c.redirect("/admin?error=origin", 303)
					: c.json({ error: { message: "cross-origin request refused", code: "origin_refused" } }, 403);
			}

			const clientIp = clientIpOf(c, options.access);
			const retryAfter = options.admins.lockedOutFor(clientIp);

			if (retryAfter > 0) {
				c.header("Retry-After", String(retryAfter));

				return isForm
					? c.redirect("/admin?error=locked", 303)
					: c.json(
							{
								error: { message: "too many wrong admin tokens; wait and try again", code: "admin_auth_rate_limited" },
							},
							429,
						);
			}

			const token = await readToken(c);
			const id = token === null ? null : options.admins.signIn(token);

			if (id === null) {
				options.admins.recordFailure(clientIp);

				return isForm
					? c.redirect("/admin?error=invalid", 303)
					: c.json({ error: { message: "wrong admin token", code: "admin_required" } }, 401);
			}

			options.admins.setCookie(c, options.access, id);

			return isForm ? c.redirect("/", 303) : c.body(null, 204);
		},
	);

	routes.post("/api/admin/logout", c => {
		if (!isAllowedOrigin(c, options.access)) {
			return c.json({ error: { message: "cross-origin request refused", code: "origin_refused" } }, 403);
		}

		options.admins.signOut(options.admins.cookieOf(c));
		options.admins.clearCookie(c, options.access);

		return c.body(null, 204);
	});

	return routes;
}
