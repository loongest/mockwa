import { describe, expect, it } from "vitest";
import { DEFAULT_PUBLIC_LIMITS, DEFAULT_VISITOR_IDENTITIES } from "./access-config.ts";
import { parseConfig } from "./parse-config.ts";

/** Access modes (SPEC §7): what a public instance requires, and what dev mode keeps. */
const PUBLIC = {
	WASANDBOX_MODE: "public",
	WASANDBOX_ADMIN_TOKEN: "a-long-enough-admin-token",
	WASANDBOX_TOKENS: "app-token",
};

function errorsOf(env: Record<string, string>): string[] {
	const result = parseConfig(env);

	return result.success ? [] : result.errors;
}

describe("WASANDBOX_MODE", () => {
	it("defaults to dev, with no admin token and nothing a visitor needs", () => {
		const result = parseConfig({});

		expect(result.success).toBe(true);

		if (result.success) {
			expect(result.config.access.mode).toBe("dev");
			expect(result.config.access.adminToken).toBeUndefined();
			expect(result.config.access.trustedProxies).toEqual([]);
			expect(result.config.access.cookieSecure).toBe("auto");
		}
	});

	it("starts a public instance with the documented conservative defaults", () => {
		const result = parseConfig(PUBLIC);

		expect(result.success).toBe(true);

		if (result.success) {
			expect(result.config.access.mode).toBe("public");
			expect(result.config.access.visitors).toEqual({
				identities: DEFAULT_VISITOR_IDENTITIES,
				waIdPrefix: "999",
				sessionTtlMs: DEFAULT_PUBLIC_LIMITS.sessionTtlMs,
				messagesPerMinutePerSession: 20,
				messagesPerMinutePerIp: 60,
				mediaMaxBytes: 1_048_576,
				mediaPerSession: 10,
				sessionsPerIp: 3,
				maxSessions: 500,
				sessionCreatesPerMinutePerIp: 10,
			});
		}
	});

	it("refuses a public instance without an admin token, on the virtual clock, or without a token registry", () => {
		expect(errorsOf({ WASANDBOX_MODE: "public", WASANDBOX_TOKENS: "app-token" })).toEqual([
			'WASANDBOX_ADMIN_TOKEN: is required when WASANDBOX_MODE is "public"',
		]);
		expect(errorsOf({ ...PUBLIC, WASANDBOX_CLOCK: "virtual" })).toEqual([
			'WASANDBOX_CLOCK: must be "real" when WASANDBOX_MODE is "public": visitors run in real time',
		]);
		expect(errorsOf({ WASANDBOX_MODE: "public", WASANDBOX_ADMIN_TOKEN: "a-long-enough-admin-token" })).toEqual([
			'WASANDBOX_TOKENS: is required when WASANDBOX_MODE is "public": the Graph listener must not accept any bearer token',
		]);
	});

	it("refuses an admin token shorter than 16 characters, in either mode", () => {
		expect(errorsOf({ WASANDBOX_ADMIN_TOKEN: "short" })).toEqual([
			"WASANDBOX_ADMIN_TOKEN: must be at least 16 characters",
		]);
		expect(errorsOf({ ...PUBLIC, WASANDBOX_ADMIN_TOKEN: "short" })).toEqual([
			"WASANDBOX_ADMIN_TOKEN: must be at least 16 characters",
		]);
	});

	it("refuses an unknown mode", () => {
		expect(errorsOf({ WASANDBOX_MODE: "demo" })[0]).toMatch(/^WASANDBOX_MODE: /);
	});
});

describe("visitor settings", () => {
	it("reads the identity template, limits, trusted proxies and allowed origins", () => {
		const result = parseConfig({
			...PUBLIC,
			WASANDBOX_PUBLIC_IDENTITIES: JSON.stringify([{ role: "CUSTOMER", name: "You" }]),
			WASANDBOX_PUBLIC_WA_ID_PREFIX: "1555",
			WASANDBOX_PUBLIC_SESSION_TTL: "10m",
			WASANDBOX_PUBLIC_MESSAGES_PER_MINUTE: "5",
			WASANDBOX_PUBLIC_MEDIA_MAX_BYTES: "2048",
			WASANDBOX_TRUSTED_PROXIES: "10.0.0.2, ::1",
			WASANDBOX_ALLOWED_ORIGINS: "https://demo.example.com/",
			WASANDBOX_COOKIE_SECURE: "always",
		});

		expect(result.success).toBe(true);

		if (result.success) {
			const { access } = result.config;

			expect(access.visitors.identities).toEqual([{ role: "CUSTOMER", name: "You" }]);
			expect(access.visitors.waIdPrefix).toBe("1555");
			expect(access.visitors.sessionTtlMs).toBe(600_000);
			expect(access.visitors.messagesPerMinutePerSession).toBe(5);
			expect(access.visitors.mediaMaxBytes).toBe(2048);
			expect(access.trustedProxies).toEqual(["10.0.0.2", "::1"]);
			expect(access.allowedOrigins).toEqual(["https://demo.example.com"]);
			expect(access.cookieSecure).toBe("always");
		}
	});

	it("names each invalid visitor setting", () => {
		const errors = errorsOf({
			...PUBLIC,
			WASANDBOX_PUBLIC_IDENTITIES: JSON.stringify([
				{ role: "CUSTOMER", name: "A" },
				{ role: "customer", name: "B" },
			]),
			WASANDBOX_PUBLIC_WA_ID_PREFIX: "0123",
			WASANDBOX_PUBLIC_SESSION_TTL: "soon",
			WASANDBOX_PUBLIC_MESSAGES_PER_MINUTE: "0",
			WASANDBOX_TRUSTED_PROXIES: "proxy.internal",
			WASANDBOX_ALLOWED_ORIGINS: "demo.example.com",
		});

		expect(errors).toEqual([
			"WASANDBOX_PUBLIC_IDENTITIES: must not repeat a role",
			"WASANDBOX_PUBLIC_WA_ID_PREFIX: must be 1-6 digits and must not start with 0",
			"WASANDBOX_PUBLIC_SESSION_TTL: must be a duration of at least 1s, e.g. 30m or 2h",
			"WASANDBOX_PUBLIC_MESSAGES_PER_MINUTE: must be a whole number of at least 1",
			"WASANDBOX_TRUSTED_PROXIES: must be a comma-separated list of IP addresses",
			"WASANDBOX_ALLOWED_ORIGINS: must be a comma-separated list of origins such as https://demo.example.com",
		]);
	});
});
