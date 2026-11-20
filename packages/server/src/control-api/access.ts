import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv } from "../app-env.ts";
import type { AccessConfig } from "../config/index.ts";
import { RateLimiter } from "../domain/rate-limiter.ts";

/**
 * Who may use the console listener (SPEC §5, §7 "Access modes"), as HTTP: client addresses,
 * origins, cookies and the admin gate. Everything here is about requests; what a visitor owns
 * is the domain's (`domain/visitor-sessions.ts`).
 */

/** The visitor's session cookie: HttpOnly, SameSite=Strict, `Secure` per `MOCKWA_COOKIE_SECURE`. */
export const VISITOR_COOKIE = "mockwa_visitor";

/** The admin's cookie, set by `/admin`'s login form; holds a random session ID, never the token. */
export const ADMIN_COOKIE = "mockwa_admin";

/** Every cookie-authenticated write from a visitor carries the session's CSRF token here. */
export const CSRF_HEADER = "x-csrf-token";

/** How long the browser keeps the visitor cookie; the server's idle TTL ends the session first. */
const VISITOR_COOKIE_MAX_AGE_SECONDS = 24 * 3600;

/** How long an admin stays signed in through the login form. */
export const ADMIN_SESSION_TTL_MS = 12 * 3600 * 1000;

/** Wrong admin tokens one address may present per window before every attempt is refused. */
export const ADMIN_FAILURES_PER_WINDOW = 10;

/** The window {@link ADMIN_FAILURES_PER_WINDOW} counts over. */
export const ADMIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;

/**
 * How often expired admin state (cookie sessions, failure windows) is swept, at most. The sweep
 * rides on ordinary authentication checks, so it needs no timer, and it walks the maps at most
 * this often however busy the console is.
 */
export const ADMIN_PRUNE_INTERVAL_MS = 60 * 1000;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isUnsafeMethod(method: string): boolean {
	return UNSAFE_METHODS.has(method.toUpperCase());
}

/** The Node socket's peer address, when the request came over one (absent under `app.request()`). */
function socketAddress(c: Context<AppEnv>): string | undefined {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;

	return env?.incoming?.socket?.remoteAddress;
}

/** `::ffff:203.0.113.7` and `203.0.113.7` are the same client. */
function normalizeAddress(address: string): string {
	return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isTrusted(address: string | undefined, access: AccessConfig): boolean {
	return address !== undefined && access.trustedProxies.includes(normalizeAddress(address));
}

/**
 * The client's address (SPEC §7). The socket's peer, unless that peer is one of
 * `MOCKWA_TRUSTED_PROXIES`: then `X-Forwarded-For` is read from the right, skipping trusted
 * hops, and the first address no trusted proxy vouches for is the client. A header from anyone
 * else is ignored, so a visitor cannot pick its own address. `unknown` when there is no socket.
 */
export function clientIpOf(c: Context<AppEnv>, access: AccessConfig): string {
	const peer = socketAddress(c);

	if (peer === undefined) {
		return "unknown";
	}

	if (!isTrusted(peer, access)) {
		return normalizeAddress(peer);
	}

	const forwarded = (c.req.header("x-forwarded-for") ?? "")
		.split(",")
		.map(entry => entry.trim())
		.filter(entry => entry !== "");

	for (const hop of forwarded.toReversed()) {
		if (!isTrusted(hop, access)) {
			return normalizeAddress(hop);
		}
	}

	return normalizeAddress(peer);
}

/** The origin the browser reached this listener at: behind a trusted proxy, the proxy's view. */
export function ownOriginOf(c: Context<AppEnv>, access: AccessConfig): string {
	const url = new URL(c.req.url);
	const isViaProxy = isTrusted(socketAddress(c), access);
	const protocol = isViaProxy ? (c.req.header("x-forwarded-proto")?.split(",", 1)[0]?.trim() ?? null) : null;
	const host =
		(isViaProxy ? c.req.header("x-forwarded-host")?.split(",", 1)[0]?.trim() : undefined) ?? c.req.header("host");

	return `${protocol ?? url.protocol.replace(/:$/, "")}://${host ?? url.host}`;
}

/** Whether the request came over HTTPS, as far as this listener can tell. */
export function isHttps(c: Context<AppEnv>, access: AccessConfig): boolean {
	return ownOriginOf(c, access).startsWith("https://");
}

/**
 * The same-origin check on cookie-authenticated writes and on every socket upgrade (SPEC §5).
 * A browser always sends `Origin` on those, so a missing one is refused too; it must be this
 * listener's own origin or one of `MOCKWA_ALLOWED_ORIGINS`.
 */
export function isAllowedOrigin(c: Context<AppEnv>, access: AccessConfig): boolean {
	const origin = c.req.header("origin");

	if (origin === undefined || origin === "null") {
		return false;
	}

	return origin === ownOriginOf(c, access) || access.allowedOrigins.includes(origin);
}

function isSecureCookie(c: Context<AppEnv>, access: AccessConfig): boolean {
	switch (access.cookieSecure) {
		case "always": {
			return true;
		}

		case "never": {
			return false;
		}

		case "auto": {
			return isHttps(c, access);
		}
	}
}

export function setVisitorCookie(c: Context<AppEnv>, access: AccessConfig, token: string): void {
	setCookie(c, VISITOR_COOKIE, token, {
		httpOnly: true,
		sameSite: "Strict",
		secure: isSecureCookie(c, access),
		path: "/",
		maxAge: VISITOR_COOKIE_MAX_AGE_SECONDS,
	});
}

export function clearVisitorCookie(c: Context<AppEnv>, access: AccessConfig): void {
	deleteCookie(c, VISITOR_COOKIE, { path: "/", secure: isSecureCookie(c, access) });
}

export function visitorTokenOf(c: Context<AppEnv>): string | undefined {
	return getCookie(c, VISITOR_COOKIE);
}

/** Constant-time string comparison; different lengths are simply unequal. */
export function isSafeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);

	return left.length === right.length && timingSafeEqual(left, right);
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * The admin side of the console (SPEC §7): `Authorization: Bearer <MOCKWA_ADMIN_TOKEN>` for
 * scripts and the CLI, or the cookie `/admin`'s login form sets for a browser. The cookie holds a
 * random ID kept in memory (hashed), so a restart signs every browser out and the token itself
 * never sits in a cookie.
 */
/** What the admin side holds in memory: live cookie sessions, and addresses with recent failures. */
export interface AdminStateSize {
	sessions: number;
	failureAddresses: number;
}

export class AdminSessions {
	readonly #token: string | undefined;
	readonly #now: () => Date;
	readonly #sessions = new Map<string, number>();
	readonly #failures: RateLimiter;
	#prunedAt = -Infinity;

	constructor(options: { token: string | undefined; now: () => Date }) {
		this.#token = options.token;
		this.#now = options.now;
		this.#failures = new RateLimiter({
			limit: ADMIN_FAILURES_PER_WINDOW,
			windowMs: ADMIN_FAILURE_WINDOW_MS,
			now: options.now,
		});
	}

	/**
	 * Expired cookie sessions and failure windows are otherwise only dropped when their browser
	 * or address comes back, and most never do. Every authentication check calls this; the walk
	 * itself runs at most once per {@link ADMIN_PRUNE_INTERVAL_MS}.
	 */
	#prune(): void {
		const now = this.#now().getTime();

		if (now - this.#prunedAt < ADMIN_PRUNE_INTERVAL_MS) {
			return;
		}

		this.#prunedAt = now;

		for (const [key, expiresAt] of this.#sessions) {
			if (expiresAt <= now) {
				this.#sessions.delete(key);
			}
		}

		this.#failures.prune();
	}

	#isSession(id: string | undefined): boolean {
		if (id === undefined) {
			return false;
		}

		const key = sha256(id);
		const expiresAt = this.#sessions.get(key);

		if (expiresAt === undefined) {
			return false;
		}

		if (expiresAt <= this.#now().getTime()) {
			this.#sessions.delete(key);

			return false;
		}

		return true;
	}

	/** Whether an admin token is configured at all; without one the console is open (dev mode). */
	get isRequired(): boolean {
		return this.#token !== undefined;
	}

	checkToken(candidate: string): boolean {
		return this.#token !== undefined && isSafeEqual(candidate, this.#token);
	}

	/**
	 * Seconds until `clientIp` may try a token again, after too many wrong ones; `0` when it may
	 * now. While it is locked out even the right token is refused, or the answer would tell a
	 * guesser which of its guesses was the right one.
	 */
	lockedOutFor(clientIp: string): number {
		this.#prune();

		return this.#failures.check(clientIp).retryAfterSeconds;
	}

	recordFailure(clientIp: string): void {
		this.#prune();
		this.#failures.take(clientIp);
	}

	/** What is held in memory right now: live cookie sessions, and addresses with recent failures. */
	get stateSize(): AdminStateSize {
		return { sessions: this.#sessions.size, failureAddresses: this.#failures.size };
	}

	/** A new browser session for a correct token; `null` for a wrong one. */
	signIn(candidate: string): string | null {
		if (!this.checkToken(candidate)) {
			return null;
		}

		this.#prune();

		const id = randomBytes(32).toString("base64url");

		this.#sessions.set(sha256(id), this.#now().getTime() + ADMIN_SESSION_TTL_MS);

		return id;
	}

	signOut(id: string | undefined): void {
		if (id !== undefined) {
			this.#sessions.delete(sha256(id));
		}
	}

	/** `bearer` for a request that carried the token, `cookie` for a signed-in browser, else `null`. */
	authenticate(c: Context<AppEnv>): "bearer" | "cookie" | null {
		this.#prune();

		const header = c.req.header("authorization");
		const match = header === undefined ? null : /^Bearer\s+(.+)$/i.exec(header);

		if (match?.[1] !== undefined && this.checkToken(match[1].trim())) {
			return "bearer";
		}

		return this.#isSession(getCookie(c, ADMIN_COOKIE)) ? "cookie" : null;
	}

	setCookie(c: Context<AppEnv>, access: AccessConfig, id: string): void {
		setCookie(c, ADMIN_COOKIE, id, {
			httpOnly: true,
			sameSite: "Strict",
			secure: isSecureCookie(c, access),
			path: "/",
			maxAge: Math.floor(ADMIN_SESSION_TTL_MS / 1000),
		});
	}

	clearCookie(c: Context<AppEnv>, access: AccessConfig): void {
		deleteCookie(c, ADMIN_COOKIE, { path: "/", secure: isSecureCookie(c, access) });
	}

	cookieOf(c: Context<AppEnv>): string | undefined {
		return getCookie(c, ADMIN_COOKIE);
	}
}

/** Where a console-listener path sits in the access model (SPEC §7, docs/access.md). */
export type PathAudience = "open" | "visitor" | "admin";

/** Reachable by anyone, in every mode: health probes and the admin sign-in. */
const OPEN_PATHS = [
	/^\/health$/,
	/^\/api\/health$/,
	/^\/admin$/,
	/^\/api\/admin\/(?:login|logout)$/,
	/^\/api\/phone\/config$/,
];

/** A visitor's surface in public mode; each route checks the session itself. */
const VISITOR_PATHS = [
	/^\/phone(?:\/.*)?$/,
	/^\/api\/phone\/.+$/,
	/^\/api\/public\/session$/,
	/^\/whaloc-media\/[^/]+$/,
];

/**
 * Classifies a console-listener request. `isPhoneAsset` says whether a static file belongs to
 * the phone bundle: only those are a visitor's; the console's own bundle is the admin's.
 */
export function audienceOf(
	path: string,
	mode: AccessConfig["mode"],
	isPhoneAsset: (path: string) => boolean,
): PathAudience {
	if (OPEN_PATHS.some(pattern => pattern.test(path))) {
		return "open";
	}

	if (mode === "public" && (VISITOR_PATHS.some(pattern => pattern.test(path)) || isPhoneAsset(path))) {
		return "visitor";
	}

	return "admin";
}

export interface AccessGateOptions {
	access: AccessConfig;
	admins: AdminSessions;
	isPhoneAsset: (path: string) => boolean;
}

/**
 * The console listener's front door (SPEC §7). Mounted only when there is something to guard —
 * public mode, or dev mode with `MOCKWA_ADMIN_TOKEN` set — so the default dev experience is
 * byte-for-byte what it was.
 *
 * An admin path without admin authorization is a **401** under `/api` (with the control
 * plane's error shape, so a script sees why) and a plain **404** anywhere else, so the console's
 * pages and bundle are not even confirmed to exist. A browser signed in by cookie may only write
 * from this listener's own origin; a bearer-token request is a script and has no origin to check.
 */
export function createAccessGate(options: AccessGateOptions): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const audience = audienceOf(c.req.path, options.access.mode, options.isPhoneAsset);
		const isPresentingToken = c.req.header("authorization") !== undefined;
		const clientIp = clientIpOf(c, options.access);

		if (isPresentingToken) {
			const retryAfter = options.admins.lockedOutFor(clientIp);

			if (retryAfter > 0) {
				c.header("Retry-After", String(retryAfter));

				return c.json(
					{ error: { message: "too many wrong admin tokens; wait and try again", code: "admin_auth_rate_limited" } },
					429,
				);
			}
		}

		const admin = options.admins.authenticate(c);

		if (isPresentingToken && admin !== "bearer") {
			options.admins.recordFailure(clientIp);
		}

		c.set("adminAuth", admin);

		if (audience === "open" || audience === "visitor") {
			await next();

			return;
		}

		if (admin === null) {
			if (c.req.path === "/api" || c.req.path.startsWith("/api/")) {
				c.header("WWW-Authenticate", 'Bearer realm="mockwa admin"');

				return c.json({ error: { message: "admin authorization required", code: "admin_required" } }, 401);
			}

			return c.text("Not Found", 404);
		}

		const isUpgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";

		if (admin === "cookie" && (isUpgrade || isUnsafeMethod(c.req.method)) && !isAllowedOrigin(c, options.access)) {
			return c.json({ error: { message: "cross-origin request refused", code: "origin_refused" } }, 403);
		}

		await next();

		return;
	};
}
