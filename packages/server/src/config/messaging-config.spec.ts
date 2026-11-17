import { describe, expect, it } from "vitest";
import { parseConfig } from "./parse-config.ts";
import type { MessagingRulesConfig } from "./messaging-config.ts";

function messagingOf(env: NodeJS.ProcessEnv): MessagingRulesConfig {
	const result = parseConfig(env);

	if (!result.success) {
		throw new Error(result.errors.join("\n"));
	}

	return result.config.messaging;
}

function errorsOf(env: NodeJS.ProcessEnv): string[] {
	const result = parseConfig(env);

	return result.success ? [] : result.errors;
}

describe("messaging rules configuration (SPEC §4)", () => {
	it("enforces Meta's 24-hour window and leaves every limit off by default", () => {
		expect(messagingOf({})).toEqual({
			serviceWindowMs: 86_400_000,
			throughput: null,
			pairRateLimit: null,
			messagingLimit: null,
		});
	});

	it("accepts a shorter window, or none", () => {
		expect(messagingOf({ MOCKWA_SERVICE_WINDOW: "30s" }).serviceWindowMs).toBe(30_000);
		expect(messagingOf({ MOCKWA_SERVICE_WINDOW: "off" }).serviceWindowMs).toBeNull();
		expect(messagingOf({ WHALOC_SERVICE_WINDOW: "2m" }).serviceWindowMs).toBe(120_000);
	});

	it("reads throughput as Meta's per-level figures or one fixed rate", () => {
		expect(messagingOf({ MOCKWA_THROUGHPUT: "meta" }).throughput).toBe("meta");
		expect(messagingOf({ MOCKWA_THROUGHPUT: "5" }).throughput).toEqual({ messagesPerSecond: 5 });
	});

	it("reads the pair rate limit as Meta's figures or an interval and a burst", () => {
		expect(messagingOf({ MOCKWA_PAIR_RATE_LIMIT: "meta" }).pairRateLimit).toEqual({ intervalMs: 6000, burst: 45 });
		expect(messagingOf({ MOCKWA_PAIR_RATE_LIMIT: "2s/3" }).pairRateLimit).toEqual({ intervalMs: 2000, burst: 3 });
	});

	it("reads the messaging limit as a number of unique users", () => {
		expect(messagingOf({ MOCKWA_MESSAGING_LIMIT: "250" }).messagingLimit).toBe(250);
		expect(messagingOf({ MOCKWA_MESSAGING_LIMIT: "unlimited" }).messagingLimit).toBeNull();
	});

	it("names the variable in every complaint", () => {
		expect(errorsOf({ MOCKWA_SERVICE_WINDOW: "a day" })).toEqual([expect.stringMatching(/^MOCKWA_SERVICE_WINDOW: /)]);
		expect(errorsOf({ MOCKWA_THROUGHPUT: "0" })).toEqual([expect.stringMatching(/^MOCKWA_THROUGHPUT: /)]);
		expect(errorsOf({ MOCKWA_PAIR_RATE_LIMIT: "6s" })).toEqual([expect.stringMatching(/^MOCKWA_PAIR_RATE_LIMIT: /)]);
		expect(errorsOf({ MOCKWA_PAIR_RATE_LIMIT: "6s/0" })).toEqual([expect.stringMatching(/^MOCKWA_PAIR_RATE_LIMIT: /)]);
		expect(errorsOf({ MOCKWA_MESSAGING_LIMIT: "lots" })).toEqual([expect.stringMatching(/^MOCKWA_MESSAGING_LIMIT: /)]);
	});
});
