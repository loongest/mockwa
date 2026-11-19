import { contactRoleSchema } from "@mockwa/shared";
import { isIP } from "node:net";
import { z } from "zod";
import { parseDuration } from "./webhook-config.ts";

/**
 * Who may use the console listener (SPEC §7, "Access modes"): `dev`, open like Mailpit, or
 * `public`, where anonymous visitors get their own phone and everything else needs the admin
 * token.
 */
export const ACCESS_MODES = ["dev", "public"] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];

/** Long enough that guessing it over HTTP is hopeless; short enough to type into a login form. */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

/** How a visitor's `Secure` cookie flag is decided (SPEC §7). */
export const COOKIE_SECURE_MODES = ["auto", "always", "never"] as const;

export type CookieSecureMode = (typeof COOKIE_SECURE_MODES)[number];

/**
 * One identity every visitor gets (SPEC §5, "Public demo mode"). The number is never the
 * template's to choose: it is drawn from the reserved range so no two visitors share one.
 */
export const visitorIdentityTemplateSchema = z.object({
	role: contactRoleSchema,
	name: z.string().trim().min(1).max(60),
});

export type VisitorIdentityTemplate = z.infer<typeof visitorIdentityTemplateSchema>;

/** A customer and a technician, the two sides the architecture's use cases need. */
export const DEFAULT_VISITOR_IDENTITIES: readonly VisitorIdentityTemplate[] = [
	{ role: "CUSTOMER", name: "Demo customer" },
	{ role: "TECHNICIAN", name: "Demo technician" },
];

/**
 * The conservative limits a public instance starts with (SPEC §7). Each one is an environment
 * variable; none of them applies in dev mode.
 */
export const DEFAULT_PUBLIC_LIMITS = {
	sessionTtlMs: 30 * 60_000,
	messagesPerMinutePerSession: 20,
	messagesPerMinutePerIp: 60,
	mediaMaxBytes: 1024 * 1024,
	mediaPerSession: 10,
	sessionsPerIp: 3,
	maxSessions: 500,
	sessionCreatesPerMinutePerIp: 10,
} as const;

/** `MOCKWA_PUBLIC_WA_ID_PREFIX`: the reserved range's leading digits. */
export const DEFAULT_VISITOR_WA_ID_PREFIX = "999";

/** Digits a visitor's `wa_id` carries in all, prefix included (Meta's wa_ids are 1-20 digits). */
export const VISITOR_WA_ID_LENGTH = 15;

function isJsonString(value: string): boolean {
	try {
		JSON.parse(value);

		return true;
	} catch {
		return false;
	}
}

function positiveInteger(message: string) {
	return z.string().regex(/^\d+$/, message).transform(Number).pipe(z.int().min(1, message));
}

const durationSchema = z.string().transform((value, ctx) => {
	const ms = parseDuration(value);

	if (ms === undefined || ms < 1000) {
		ctx.addIssue({ code: "custom", message: "must be a duration of at least 1s, e.g. 30m or 2h" });

		return z.NEVER;
	}

	return ms;
});

const visitorIdentitiesSchema = z
	.string()
	.refine(isJsonString, "must be valid JSON")
	.transform(value => JSON.parse(value) as unknown)
	.pipe(z.array(visitorIdentityTemplateSchema).min(1).max(4))
	.refine(identities => {
		const roles = new Set(identities.map(identity => identity.role.toUpperCase()));

		return roles.size === identities.length;
	}, "must not repeat a role");

/**
 * `MOCKWA_TRUSTED_PROXIES`: the exact addresses of the reverse proxies whose
 * `X-Forwarded-For` / `X-Forwarded-Proto` / `X-Forwarded-Host` are believed. Exact addresses,
 * not ranges: a public demo sits behind one or two known hops, and a typo in a range would
 * trust the whole internet.
 */
const trustedProxiesSchema = z
	.string()
	.transform(value => {
		return value
			.split(",")
			.map(entry => entry.trim())
			.filter(entry => entry !== "");
	})
	.refine(entries => entries.every(entry => isIP(entry) !== 0), "must be a comma-separated list of IP addresses")
	.default([]);

/** `MOCKWA_ALLOWED_ORIGINS`: browser origins besides the listener's own, for CSRF and socket checks. */
const allowedOriginsSchema = z
	.string()
	.transform(value => {
		return value
			.split(",")
			.map(entry => entry.trim().replace(/\/+$/, ""))
			.filter(entry => entry !== "");
	})
	.refine(
		entries => entries.every(entry => /^https?:\/\/[^/\s]+$/.test(entry)),
		"must be a comma-separated list of origins such as https://demo.example.com",
	)
	.default([]);

/** The `MOCKWA_*` keys this file owns, before the cross-field rules below. */
export const accessEnvShape = {
	MOCKWA_MODE: z.enum(ACCESS_MODES).default("dev"),
	MOCKWA_ADMIN_TOKEN: z.string().min(1).optional(),
	MOCKWA_PUBLIC_IDENTITIES: visitorIdentitiesSchema.default([...DEFAULT_VISITOR_IDENTITIES]),
	MOCKWA_PUBLIC_WA_ID_PREFIX: z
		.string()
		.regex(/^[1-9]\d{0,5}$/, "must be 1-6 digits and must not start with 0")
		.default(DEFAULT_VISITOR_WA_ID_PREFIX),
	MOCKWA_PUBLIC_SESSION_TTL: durationSchema.default(DEFAULT_PUBLIC_LIMITS.sessionTtlMs),
	MOCKWA_PUBLIC_MESSAGES_PER_MINUTE: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.messagesPerMinutePerSession,
	),
	MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.messagesPerMinutePerIp,
	),
	MOCKWA_PUBLIC_MEDIA_MAX_BYTES: positiveInteger("must be a whole number of bytes, at least 1").default(
		DEFAULT_PUBLIC_LIMITS.mediaMaxBytes,
	),
	MOCKWA_PUBLIC_MEDIA_PER_SESSION: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.mediaPerSession,
	),
	MOCKWA_PUBLIC_SESSIONS_PER_IP: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.sessionsPerIp,
	),
	MOCKWA_PUBLIC_MAX_SESSIONS: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.maxSessions,
	),
	MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE: positiveInteger("must be a whole number of at least 1").default(
		DEFAULT_PUBLIC_LIMITS.sessionCreatesPerMinutePerIp,
	),
	MOCKWA_TRUSTED_PROXIES: trustedProxiesSchema,
	MOCKWA_ALLOWED_ORIGINS: allowedOriginsSchema,
	MOCKWA_COOKIE_SECURE: z.enum(COOKIE_SECURE_MODES).default("auto"),
};

/** What `checkAccessEnv` needs to see of the whole environment. */
interface AccessEnv {
	MOCKWA_MODE: AccessMode;
	MOCKWA_ADMIN_TOKEN?: string | undefined;
	MOCKWA_CLOCK: string;
	MOCKWA_TOKENS?: readonly string[] | undefined;
	MOCKWA_PUBLIC_WA_ID_PREFIX: string;
}

/**
 * The combinations a public instance refuses to boot with (SPEC §7). Each one would leave a
 * door open that the mode exists to close:
 *
 * - no admin token, or a short one: the console would be unreachable, or guessable;
 * - the virtual clock: visitors run in real time, and one visitor must not move another's clock;
 * - no `MOCKWA_TOKENS`: the Graph listener would accept any bearer token, so anyone who reaches
 *   it could speak as the business.
 *
 * An admin token in dev mode is allowed and puts the whole console behind it (SPEC §7).
 */
export function checkAccessEnv(env: AccessEnv, ctx: z.RefinementCtx): void {
	if (env.MOCKWA_ADMIN_TOKEN !== undefined && env.MOCKWA_ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH) {
		ctx.addIssue({
			code: "custom",
			path: ["MOCKWA_ADMIN_TOKEN"],
			message: `must be at least ${String(MIN_ADMIN_TOKEN_LENGTH)} characters`,
		});
	}

	if (env.MOCKWA_MODE !== "public") {
		return;
	}

	if (env.MOCKWA_ADMIN_TOKEN === undefined) {
		ctx.addIssue({ code: "custom", path: ["MOCKWA_ADMIN_TOKEN"], message: 'is required when MOCKWA_MODE is "public"' });
	}

	if (env.MOCKWA_CLOCK !== "real") {
		ctx.addIssue({
			code: "custom",
			path: ["MOCKWA_CLOCK"],
			message: 'must be "real" when MOCKWA_MODE is "public": visitors run in real time',
		});
	}

	if (env.MOCKWA_TOKENS === undefined) {
		ctx.addIssue({
			code: "custom",
			path: ["MOCKWA_TOKENS"],
			message: 'is required when MOCKWA_MODE is "public": the Graph listener must not accept any bearer token',
		});
	}
}

/** The resolved access settings every listener reads (SPEC §7). */
export interface AccessConfig {
	mode: AccessMode;
	/** `undefined` only in dev mode without a token: the console is open. */
	adminToken: string | undefined;
	trustedProxies: readonly string[];
	allowedOrigins: readonly string[];
	cookieSecure: CookieSecureMode;
	visitors: VisitorConfig;
}

export interface VisitorConfig {
	identities: readonly VisitorIdentityTemplate[];
	waIdPrefix: string;
	sessionTtlMs: number;
	messagesPerMinutePerSession: number;
	messagesPerMinutePerIp: number;
	mediaMaxBytes: number;
	mediaPerSession: number;
	sessionsPerIp: number;
	maxSessions: number;
	sessionCreatesPerMinutePerIp: number;
}

export interface ParsedAccessEnv {
	MOCKWA_MODE: AccessMode;
	MOCKWA_ADMIN_TOKEN?: string | undefined;
	MOCKWA_PUBLIC_IDENTITIES: VisitorIdentityTemplate[];
	MOCKWA_PUBLIC_WA_ID_PREFIX: string;
	MOCKWA_PUBLIC_SESSION_TTL: number;
	MOCKWA_PUBLIC_MESSAGES_PER_MINUTE: number;
	MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE: number;
	MOCKWA_PUBLIC_MEDIA_MAX_BYTES: number;
	MOCKWA_PUBLIC_MEDIA_PER_SESSION: number;
	MOCKWA_PUBLIC_SESSIONS_PER_IP: number;
	MOCKWA_PUBLIC_MAX_SESSIONS: number;
	MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE: number;
	MOCKWA_TRUSTED_PROXIES: string[];
	MOCKWA_ALLOWED_ORIGINS: string[];
	MOCKWA_COOKIE_SECURE: CookieSecureMode;
}

export function accessConfigOf(env: ParsedAccessEnv): AccessConfig {
	return {
		mode: env.MOCKWA_MODE,
		adminToken: env.MOCKWA_ADMIN_TOKEN,
		trustedProxies: env.MOCKWA_TRUSTED_PROXIES,
		allowedOrigins: env.MOCKWA_ALLOWED_ORIGINS,
		cookieSecure: env.MOCKWA_COOKIE_SECURE,
		visitors: {
			identities: env.MOCKWA_PUBLIC_IDENTITIES,
			waIdPrefix: env.MOCKWA_PUBLIC_WA_ID_PREFIX,
			sessionTtlMs: env.MOCKWA_PUBLIC_SESSION_TTL,
			messagesPerMinutePerSession: env.MOCKWA_PUBLIC_MESSAGES_PER_MINUTE,
			messagesPerMinutePerIp: env.MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE,
			mediaMaxBytes: env.MOCKWA_PUBLIC_MEDIA_MAX_BYTES,
			mediaPerSession: env.MOCKWA_PUBLIC_MEDIA_PER_SESSION,
			sessionsPerIp: env.MOCKWA_PUBLIC_SESSIONS_PER_IP,
			maxSessions: env.MOCKWA_PUBLIC_MAX_SESSIONS,
			sessionCreatesPerMinutePerIp: env.MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE,
		},
	};
}
