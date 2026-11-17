import { z } from "zod";

/**
 * The M2 webhook settings (SPEC §3, §7): the retry schedule and the apps registered from the
 * environment. They live apart from `app-config.ts` because both are small grammars of their
 * own, with their own tests.
 */

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `500ms`, `10s`, `5m`, `3h`, `7d` → milliseconds; `undefined` when it does not parse. */
export function parseDuration(value: string): number | undefined {
	const match = DURATION_PATTERN.exec(value.trim());

	if (match === null) {
		return undefined;
	}

	return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/**
 * The delay before each retry, in order; the last one repeats until the chain is
 * {@link DEFAULT_RETRY_MAX_AGE_MS} old. Meta only says it retries "with decreasing frequency"
 * for up to 7 days, so the steps are mockwa's choice: quick enough to see a fix land within
 * seconds, sparse enough that a receiver left broken overnight gets a handful of attempts.
 */
export const DEFAULT_RETRY_SCHEDULE_MS: readonly number[] = [
	10_000, 30_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
];

/** Meta: "for up to 7 days". */
export const DEFAULT_RETRY_MAX_AGE_MS = 7 * 86_400_000;

/** `off`, or a comma-separated list of durations (`10s,1m,1h`). `[]` means no retries at all. */
export const retryScheduleSchema = z
	.string()
	.transform((value, ctx) => {
		if (value.trim() === "off") {
			return [];
		}

		const delays = value.split(",").map(entry => parseDuration(entry));

		if (delays.some(delay => delay === undefined || delay <= 0)) {
			ctx.addIssue({
				code: "custom",
				message: 'must be "off" or a comma-separated list of durations such as "10s,1m,1h" (units ms, s, m, h, d)',
			});

			return z.NEVER;
		}

		return delays as number[];
	})
	.default([...DEFAULT_RETRY_SCHEDULE_MS]);

export const retryMaxAgeSchema = z
	.string()
	.transform((value, ctx) => {
		const duration = parseDuration(value);

		if (duration === undefined || duration <= 0) {
			ctx.addIssue({ code: "custom", message: 'must be a duration such as "7d", "12h" or "30s"' });

			return z.NEVER;
		}

		return duration;
	})
	.default(DEFAULT_RETRY_MAX_AGE_MS);

const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

const appIdSchema = z.string().regex(/^\d{1,32}$/, "must be a string of 1-32 digits");

/** One `MOCKWA_APPS` entry. An omitted id is derived from the name, so it is stable. */
export const seedAppSchema = z.object({
	id: appIdSchema.optional(),
	name: z.string().trim().min(1).max(80),
	appSecret: z.string().min(1).optional(),
	verifyToken: z.string().min(1).optional(),
	callbackUrl: httpUrl.optional(),
	accessToken: z.string().min(1).optional(),
	/** WABA ids the app is subscribed to from the start. */
	wabas: z.array(appIdSchema).default([]),
});

export type SeedApp = z.infer<typeof seedAppSchema>;

function isJsonString(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

function hasUnique(apps: readonly SeedApp[], key: "id" | "name" | "accessToken"): boolean {
	const values = apps.map(app => app[key]).filter(value => value !== undefined);

	const distinct = new Set(values);

	return distinct.size === values.length;
}

export const seedAppsSchema = z
	.array(seedAppSchema)
	.refine(apps => hasUnique(apps, "id"), "must not repeat an app id")
	.refine(apps => hasUnique(apps, "name"), "must not repeat an app name")
	.refine(apps => hasUnique(apps, "accessToken"), "must not repeat an access token");

export const appsEnvSchema = z
	.string()
	.refine(isJsonString, "must be valid JSON")
	.transform(value => JSON.parse(value) as unknown)
	.pipe(seedAppsSchema)
	.default([]);
