import path from "node:path";
import { z } from "zod";
import { DEFAULT_SEED, seedSchema } from "./seed.ts";
import {
	messagingLimitSchema,
	pairRateLimitSchema,
	serviceWindowSchema,
	throughputSchema,
	type MessagingRulesConfig,
} from "./messaging-config.ts";
import { appsEnvSchema, retryMaxAgeSchema, retryScheduleSchema } from "./webhook-config.ts";

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
/** Where media bytes live (SPEC §6): a directory, or an S3-compatible bucket. */
export const MEDIA_BACKENDS = ["local", "s3"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];
export type MediaBackend = (typeof MEDIA_BACKENDS)[number];

export const DEFAULT_STATUS_DELAYS = { sent: 0, delivered: 800, read: null } as const;

/**
 * The built web UI (SPEC §8). `packages/web/dist` sits at the same depth from `src/config` as
 * it does from the emitted `dist/config`, so one relative path covers running from source and
 * running the build; the Docker image, which lays the bundle out differently, sets the
 * variable.
 */
export const DEFAULT_WEB_DIR = path.resolve(import.meta.dirname, "../../../web/dist");

/** Whole, non-negative number given as an environment string. */
function integerString(message: string) {
	return z.string().regex(/^\d+$/, message).transform(Number);
}

function isJsonString(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

/** Both URLs are fetched over the wire (media downloads, webhook POSTs), so a scheme is not enough. */
const httpUrl = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

const STATUS_DELAY_ENTRY_PATTERN = /^(sent|delivered|read):(\d+)$/;

/** `sent:0,delivered:800[,read:<ms>]` — a missing `read` entry means "read receipts are manual". */
function parseStatusDelays(value: string): StatusDelays {
	const delays = new Map<string, number>();

	for (const entry of value.split(",")) {
		const match = STATUS_DELAY_ENTRY_PATTERN.exec(entry.trim());

		if (match) {
			delays.set(match[1]!, Number(match[2]!));
		}
	}

	return {
		sent: delays.get("sent") ?? DEFAULT_STATUS_DELAYS.sent,
		delivered: delays.get("delivered") ?? DEFAULT_STATUS_DELAYS.delivered,
		read: delays.get("read") ?? DEFAULT_STATUS_DELAYS.read,
	};
}

export interface StatusDelays {
	sent: number;
	delivered: number;
	/** `null` = the `read` status is only sent when explicitly triggered (SPEC §4). */
	read: number | null;
}

/** The two listeners (SPEC §8): the Graph API the app under test calls, and the console people use. */
export const DEFAULT_GRAPH_PORT = 8888;
export const DEFAULT_CONSOLE_PORT = 8025;

const portSchema = integerString("must be a whole number").pipe(z.int().min(1).max(65_535));

const statusDelaysSchema = z
	.string()
	.refine(
		value => value.split(",").every(entry => STATUS_DELAY_ENTRY_PATTERN.test(entry.trim())),
		'must be a comma-separated list of "<sent|delivered|read>:<milliseconds>" pairs, e.g. "sent:0,delivered:800"',
	)
	.transform(parseStatusDelays)
	.default({ ...DEFAULT_STATUS_DELAYS });

const templateAutoApproveSchema = z
	.union([z.literal("off"), integerString('must be a whole number of milliseconds, or "off"')])
	.transform(value => (value === "off" ? null : value))
	.default(2000);

const seedEnvSchema = z
	.string()
	.refine(isJsonString, "must be valid JSON")
	.transform(value => JSON.parse(value) as unknown)
	.pipe(seedSchema)
	.default(DEFAULT_SEED);

function hasNoDuplicates(tokens: readonly string[]): boolean {
	const unique = new Set(tokens);

	return unique.size === tokens.length;
}

/**
 * `MOCKWA_TOKENS` — the strict token registry (SPEC §1.9). Comma-separated; blank entries are
 * dropped, so a trailing comma is harmless. **Left unset the variable changes nothing**: whaloc
 * stays permissive and accepts any non-empty bearer token.
 */
const tokensSchema = z
	.string()
	.transform(value => {
		return value
			.split(",")
			.map(token => token.trim())
			.filter(token => token !== "");
	})
	.refine(tokens => tokens.length > 0, "must list at least one token")
	.refine(tokens => hasNoDuplicates(tokens), "must not repeat a token")
	.optional();

/** `MOCKWA_MEDIA_TTL_SECONDS` — media expiry (SPEC §4); unset means media never expires. */
const mediaTtlSchema = integerString("must be a whole number of seconds").pipe(z.int().min(1)).optional();

/** The S3-compatible media backend (SPEC §6), resolved once the environment has been checked. */
export interface S3Config {
	bucket: string;
	region: string;
	/** Set for RustFS, R2 or any other S3-compatible server; unset means AWS itself. */
	endpoint: string | undefined;
	/** Path-style addressing; defaults to `true` whenever an endpoint is configured. */
	forcePathStyle: boolean;
	/** `undefined` = fall back to the SDK's default credential chain (profile, IMDS, env). */
	credentials: { accessKeyId: string; secretAccessKey: string } | undefined;
}

/** The `MOCKWA_S3_*` half of the environment, before the cross-field rules below are applied. */
interface S3Env {
	MOCKWA_MEDIA_BACKEND: MediaBackend;
	MOCKWA_S3_ENDPOINT?: string | undefined;
	MOCKWA_S3_REGION?: string | undefined;
	MOCKWA_S3_BUCKET?: string | undefined;
	MOCKWA_S3_ACCESS_KEY_ID?: string | undefined;
	MOCKWA_S3_SECRET_ACCESS_KEY?: string | undefined;
	MOCKWA_S3_FORCE_PATH_STYLE?: boolean | undefined;
}

/**
 * An S3 backend that cannot work is a boot failure, not a first-upload failure (SPEC §7): the
 * bucket and the region are required, and the two credential variables are all-or-nothing —
 * one of them alone is a typo, not a request for the default credential chain.
 */
function checkS3Env(env: S3Env, ctx: z.RefinementCtx): void {
	if (env.MOCKWA_MEDIA_BACKEND === "s3") {
		for (const key of ["MOCKWA_S3_BUCKET", "MOCKWA_S3_REGION"] as const) {
			if (env[key] === undefined) {
				ctx.addIssue({ code: "custom", path: [key], message: 'is required when MOCKWA_MEDIA_BACKEND is "s3"' });
			}
		}
	}

	const credentials = [
		["MOCKWA_S3_ACCESS_KEY_ID", "MOCKWA_S3_SECRET_ACCESS_KEY"],
		["MOCKWA_S3_SECRET_ACCESS_KEY", "MOCKWA_S3_ACCESS_KEY_ID"],
	] as const;

	for (const [key, other] of credentials) {
		if (env[key] === undefined && env[other] !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: [key],
				message: `is required when ${other} is set (leave both unset to use the SDK's default credential chain)`,
			});
		}
	}
}

/** One port cannot be two listeners: the Graph surface and the console never share an origin. */
function checkPorts(env: { MOCKWA_GRAPH_PORT: number; MOCKWA_CONSOLE_PORT: number }, ctx: z.RefinementCtx): void {
	if (env.MOCKWA_GRAPH_PORT === env.MOCKWA_CONSOLE_PORT) {
		ctx.addIssue({
			code: "custom",
			path: ["MOCKWA_CONSOLE_PORT"],
			message: `must differ from MOCKWA_GRAPH_PORT (both are ${String(env.MOCKWA_GRAPH_PORT)})`,
		});
	}
}

/** The resolved {@link S3Config}, or `undefined` when the bytes go to a directory instead. */
function s3ConfigOf(env: S3Env): S3Config | undefined {
	if (env.MOCKWA_MEDIA_BACKEND !== "s3") {
		return undefined;
	}

	const accessKeyId = env.MOCKWA_S3_ACCESS_KEY_ID;
	const secretAccessKey = env.MOCKWA_S3_SECRET_ACCESS_KEY;
	const endpoint = env.MOCKWA_S3_ENDPOINT;

	return {
		// Both are guaranteed by `checkS3Env`, which fails the parse before this runs.
		bucket: env.MOCKWA_S3_BUCKET!,
		region: env.MOCKWA_S3_REGION!,
		endpoint,
		// RustFS and friends are addressed as `<endpoint>/<bucket>/<key>`; AWS is not.
		forcePathStyle: env.MOCKWA_S3_FORCE_PATH_STYLE ?? endpoint !== undefined,
		credentials:
			accessKeyId === undefined || secretAccessKey === undefined ? undefined : { accessKeyId, secretAccessKey },
	};
}

/**
 * Every `MOCKWA_*` environment variable (SPEC §7). Keys are the variable names so validation
 * issues carry them as their path; the transform below is the only place that maps them to
 * the camelCase {@link AppConfig} the rest of the server consumes. The `MOCKWA_*` aliases are
 * folded in by `parseConfig` before this schema sees the environment.
 */
export const appConfigSchema = z
	.object({
		MOCKWA_GRAPH_PORT: portSchema.default(DEFAULT_GRAPH_PORT),
		MOCKWA_CONSOLE_PORT: portSchema.default(DEFAULT_CONSOLE_PORT),
		MOCKWA_HOST: z.string().min(1).default("0.0.0.0"),
		MOCKWA_PUBLIC_URL: httpUrl
			.transform(value => value.replace(/\/+$/, ""))
			.default(`http://localhost:${String(DEFAULT_GRAPH_PORT)}`),
		MOCKWA_WEBHOOK_URL: httpUrl.optional(),
		MOCKWA_APP_SECRET: z.string().min(1).optional(),
		MOCKWA_WEBHOOK_VERIFY_TOKEN: z.string().min(1).optional(),
		MOCKWA_VERIFY_ON_START: z.stringbool().default(false),
		// The app id `subscribed_apps` reports (SPEC §2.20). Left unset it is derived, so the
		// value is stable across restarts; set it to the `META_APP_ID` the app under test uses.
		MOCKWA_APP_ID: z
			.string()
			.regex(/^\d{1,32}$/, "must be a string of 1-32 digits")
			.optional(),
		MOCKWA_SEED: seedEnvSchema,
		MOCKWA_APPS: appsEnvSchema,
		MOCKWA_WEBHOOK_RETRY_SCHEDULE: retryScheduleSchema,
		MOCKWA_WEBHOOK_RETRY_MAX_AGE: retryMaxAgeSchema,
		MOCKWA_STATUS_DELAYS: statusDelaysSchema,
		MOCKWA_TEMPLATE_AUTO_APPROVE: templateAutoApproveSchema,
		MOCKWA_TOKENS: tokensSchema,
		MOCKWA_MEDIA_TTL_SECONDS: mediaTtlSchema,
		MOCKWA_SERVICE_WINDOW: serviceWindowSchema,
		MOCKWA_THROUGHPUT: throughputSchema,
		MOCKWA_PAIR_RATE_LIMIT: pairRateLimitSchema,
		MOCKWA_MESSAGING_LIMIT: messagingLimitSchema,
		MOCKWA_DB_PATH: z.string().min(1).default(":memory:"),
		// Where the bytes go (SPEC §6). `local` is the default and needs nothing else; `s3`
		// requires the bucket and region below, and is checked before the server boots.
		MOCKWA_MEDIA_BACKEND: z.enum(MEDIA_BACKENDS).default("local"),
		// The Docker image sets `/data/media` (a declared volume); outside a container the
		// storage root stays inside the working directory (SPEC §6).
		MOCKWA_MEDIA_DIR: z.string().min(1).default("./data/media"),
		MOCKWA_S3_BUCKET: z.string().min(1).optional(),
		MOCKWA_S3_REGION: z.string().min(1).optional(),
		/** RustFS, R2, Ceph …; left unset the SDK talks to AWS S3 itself. */
		MOCKWA_S3_ENDPOINT: httpUrl.optional(),
		MOCKWA_S3_ACCESS_KEY_ID: z.string().min(1).optional(),
		MOCKWA_S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
		MOCKWA_S3_FORCE_PATH_STYLE: z.stringbool().optional(),
		MOCKWA_WEB_DIR: z
			.string()
			.min(1)
			.transform(value => path.resolve(value))
			.default(DEFAULT_WEB_DIR),
		MOCKWA_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
	})
	.superRefine(checkS3Env)
	.superRefine(checkPorts)
	.transform(env => ({
		graphPort: env.MOCKWA_GRAPH_PORT,
		consolePort: env.MOCKWA_CONSOLE_PORT,
		host: env.MOCKWA_HOST,
		publicUrl: env.MOCKWA_PUBLIC_URL,
		webhookUrl: env.MOCKWA_WEBHOOK_URL,
		appSecret: env.MOCKWA_APP_SECRET,
		webhookVerifyToken: env.MOCKWA_WEBHOOK_VERIFY_TOKEN,
		verifyOnStart: env.MOCKWA_VERIFY_ON_START,
		/** `undefined` = derive it; {@link SubscribedAppService} owns that fallback. */
		appId: env.MOCKWA_APP_ID,
		seed: env.MOCKWA_SEED,
		/** Apps registered at boot and after every reset, next to the default app (SPEC §3). */
		apps: env.MOCKWA_APPS,
		/** Delay before each retry; the last repeats. `[]` = no retries (SPEC §3). */
		webhookRetryScheduleMs: env.MOCKWA_WEBHOOK_RETRY_SCHEDULE,
		/** A chain stops retrying once its first attempt is this old. */
		webhookRetryMaxAgeMs: env.MOCKWA_WEBHOOK_RETRY_MAX_AGE,
		statusDelays: env.MOCKWA_STATUS_DELAYS,
		/** `null` = templates stay `PENDING` until approved through the control plane. */
		templateAutoApproveMs: env.MOCKWA_TEMPLATE_AUTO_APPROVE,
		/** `undefined` = permissive auth: any non-empty bearer token is accepted (SPEC §1.9). */
		tokens: env.MOCKWA_TOKENS,
		/** `undefined` = uploaded media never expires (SPEC §4). */
		mediaTtlSeconds: env.MOCKWA_MEDIA_TTL_SECONDS,
		/** The window, throughput, pair rate and messaging limit rules (SPEC §4); `null` = off. */
		messaging: {
			serviceWindowMs: env.MOCKWA_SERVICE_WINDOW,
			throughput: env.MOCKWA_THROUGHPUT,
			pairRateLimit: env.MOCKWA_PAIR_RATE_LIMIT,
			messagingLimit: env.MOCKWA_MESSAGING_LIMIT,
		} satisfies MessagingRulesConfig,
		dbPath: env.MOCKWA_DB_PATH,
		/** Which `MediaStorage` the boot sequence builds (SPEC §6). */
		mediaBackend: env.MOCKWA_MEDIA_BACKEND,
		mediaDir: env.MOCKWA_MEDIA_DIR,
		/** Set only for the `s3` backend; `undefined` means the bytes go to {@link mediaDir}. */
		s3: s3ConfigOf(env),
		/** Where the static UI is served from; an absent directory just leaves `/` unrouted. */
		webDir: env.MOCKWA_WEB_DIR,
		logLevel: env.MOCKWA_LOG_LEVEL,
	}));

export type AppConfig = z.infer<typeof appConfigSchema>;
