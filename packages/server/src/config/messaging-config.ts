import { z } from "zod";
import { parseDuration } from "./webhook-config.ts";

/**
 * The M3 messaging rules (SPEC §4, "Messaging rules"): the customer service window, throughput,
 * the pair rate limit and the messaging limit. Every number that has a Meta default is Meta's
 * documented one; the variables exist so a test can reach a boundary without waiting a day.
 */

/** Meta: "a 24-hour timer called a customer service window". */
export const DEFAULT_SERVICE_WINDOW_MS = 86_400_000;

/** Meta: up to 80 messages per second by default, up to 1,000 after the automatic upgrade. */
export const META_THROUGHPUT_MPS = { STANDARD: 80, HIGH: 1000 } as const;

/** Meta: "1 message every 6 seconds to the same WhatsApp user", with bursts of up to 45. */
export const META_PAIR_RATE_LIMIT = { intervalMs: 6000, burst: 45 } as const;

/** Meta's messaging-limit tiers: unique users reached outside a window per moving 24 hours. */
export const META_MESSAGING_LIMIT_TIERS = [250, 2000, 10_000, 100_000] as const;

/**
 * `null` = the rule is off. `throughput` is `"meta"` (the phone number's own `throughput.level`
 * decides) or one fixed figure for every number.
 */
export interface MessagingRulesConfig {
	serviceWindowMs: number | null;
	throughput: "meta" | { messagesPerSecond: number } | null;
	pairRateLimit: { intervalMs: number; burst: number } | null;
	messagingLimit: number | null;
}

/** `24h` (default), `off`, or any duration — a short one is how a test reaches the boundary. */
export const serviceWindowSchema = z
	.string()
	.transform((value, ctx) => {
		if (value === "off") {
			return null;
		}

		const duration = parseDuration(value);

		if (duration === undefined || duration <= 0) {
			ctx.addIssue({ code: "custom", message: 'must be "off" or a duration such as "24h" or "30s"' });

			return z.NEVER;
		}

		return duration;
	})
	.default(DEFAULT_SERVICE_WINDOW_MS);

const WHOLE_NUMBER_PATTERN = /^\d+$/;

/** `off` (default), `meta`, or a whole number of messages per second for every number. */
export const throughputSchema = z
	.string()
	.transform((value, ctx): MessagingRulesConfig["throughput"] => {
		if (value === "off") {
			return null;
		}

		if (value === "meta") {
			return "meta";
		}

		if (!WHOLE_NUMBER_PATTERN.test(value) || Number(value) < 1) {
			ctx.addIssue({ code: "custom", message: 'must be "off", "meta" or a whole number of messages per second' });

			return z.NEVER;
		}

		return { messagesPerSecond: Number(value) };
	})
	.default(null);

const PAIR_RATE_PATTERN = /^(.+)\/(\d+)$/;

/** `off` (default), `meta` (6s, burst 45), or `<interval>/<burst>` such as `2s/3`. */
export const pairRateLimitSchema = z
	.string()
	.transform((value, ctx): MessagingRulesConfig["pairRateLimit"] => {
		if (value === "off") {
			return null;
		}

		if (value === "meta") {
			return { ...META_PAIR_RATE_LIMIT };
		}

		const match = PAIR_RATE_PATTERN.exec(value);
		const intervalMs = match === null ? undefined : parseDuration(match[1]!);
		const burst = match === null ? 0 : Number(match[2]);

		if (intervalMs === undefined || intervalMs <= 0 || burst < 1) {
			ctx.addIssue({
				code: "custom",
				message: 'must be "off", "meta" or "<interval>/<burst>" such as "6s/45"',
			});

			return z.NEVER;
		}

		return { intervalMs, burst };
	})
	.default(null);

/** `off`/`unlimited` (default), or the number of unique users; Meta's tiers are 250 … 100000. */
export const messagingLimitSchema = z
	.string()
	.transform((value, ctx) => {
		if (value === "off" || value === "unlimited") {
			return null;
		}

		if (!WHOLE_NUMBER_PATTERN.test(value) || Number(value) < 1) {
			ctx.addIssue({
				code: "custom",
				message: 'must be "off", "unlimited" or a whole number of unique users, such as 250',
			});

			return z.NEVER;
		}

		return Number(value);
	})
	.default(null);
