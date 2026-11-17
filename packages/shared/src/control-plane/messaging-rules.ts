import { z } from "zod";

/**
 * Meta's messaging rules (SPEC §4, "Messaging rules"): the customer service window, throughput,
 * the pair rate limit and the messaging limit, as the control plane reports them.
 */

/** `GET /api/service-window?phoneNumberId=&waId=`. */
export const serviceWindowQuerySchema = z.object({
	phoneNumberId: z.string().min(1),
	waId: z.string().min(1),
});

export type ServiceWindowQuery = z.infer<typeof serviceWindowQuerySchema>;

/**
 * The customer service window between one business number and one contact. It opens when the
 * contact writes and closes `windowMs` later; another message from them restarts it.
 */
export const serviceWindowSchema = z.object({
	phoneNumberId: z.string(),
	waId: z.string(),
	/** `false` when `MOCKWA_SERVICE_WINDOW=off`: reported, never enforced. */
	isEnforced: z.boolean(),
	isOpen: z.boolean(),
	/** The contact's latest message to this number; `null` if they never wrote. */
	lastInboundAt: z.iso.datetime().nullable(),
	/** When the window closes (or closed); `null` if it never opened. */
	expiresAt: z.iso.datetime().nullable(),
	windowMs: z.number().int().positive(),
});

export type ServiceWindow = z.infer<typeof serviceWindowSchema>;

export const serviceWindowResponseSchema = z.object({ data: serviceWindowSchema });

export type ServiceWindowResponse = z.infer<typeof serviceWindowResponseSchema>;

/** One WABA's messaging-limit count: unique contacts reached outside a window in 24 hours. */
export const messagingLimitUsageSchema = z.object({
	wabaId: z.string(),
	/** `null` when no limit is configured. */
	limit: z.number().int().positive().nullable(),
	used: z.number().int().nonnegative(),
});

export type MessagingLimitUsage = z.infer<typeof messagingLimitUsageSchema>;

const throughputSchema = z.union([z.literal("meta"), z.object({ messagesPerSecond: z.number().int().positive() })]);

const pairRateLimitSchema = z.object({ intervalMs: z.number().int().positive(), burst: z.number().int().positive() });

/** What is configured — also served as `behavior.messaging` in `GET /api/state`. */
export const messagingRulesConfigSchema = z.object({
	/** `null` = the window is not enforced (`MOCKWA_SERVICE_WINDOW=off`). */
	serviceWindowMs: z.number().int().positive().nullable(),
	/** `meta` = 80 per second for a `STANDARD` number and 1,000 for `HIGH`; `null` = off. */
	throughput: throughputSchema.nullable(),
	pairRateLimit: pairRateLimitSchema.nullable(),
	messagingLimit: z.number().int().positive().nullable(),
});

export type MessagingRulesConfig = z.infer<typeof messagingRulesConfigSchema>;

/** `GET /api/messaging-rules` — what is configured, and how much of the messaging limit is spent. */
export const messagingRulesSchema = messagingRulesConfigSchema.extend({ usage: z.array(messagingLimitUsageSchema) });

export type MessagingRules = z.infer<typeof messagingRulesSchema>;

export const messagingRulesResponseSchema = z.object({ data: messagingRulesSchema });

export type MessagingRulesResponse = z.infer<typeof messagingRulesResponseSchema>;
