import type { z } from "zod";
import { appConfigSchema, type AppConfig } from "./app-config.ts";

const ENV_PREFIX = "WASANDBOX_";
/**
 * Earlier spellings of the prefix, still read so an existing setup keeps working after each
 * rename (SPEC §7). Order is priority: mockwa's own name beats whaloc's when both are set.
 */
const LEGACY_ENV_PREFIXES: readonly string[] = ["MOCKWA_", "WHALOC_"];
/**
 * Legacy names that are not a plain prefix swap. whaloc had one port and the app under test
 * pointed at it, so `WHALOC_PORT` keeps that meaning: it moves the Graph API listener.
 */
const RENAMED_LEGACY_KEYS: Readonly<Record<string, string>> = { WHALOC_PORT: "WASANDBOX_GRAPH_PORT" };
const SEED_KEY = "WASANDBOX_SEED";
const SEED_FILE_KEY = "WASANDBOX_SEED_FILE";

export type ParseConfigResult = { success: true; config: AppConfig } | { success: false; errors: string[] };

/** Reads a whole file as UTF-8. Injected, so parsing the configuration never touches the disk itself. */
export type ReadTextFile = (filePath: string) => string;

function legacyPrefixOf(key: string): string | undefined {
	return LEGACY_ENV_PREFIXES.find(prefix => key.startsWith(prefix));
}

/**
 * The `WASANDBOX_*` name a `MOCKWA_*` or `WHALOC_*` variable stands for, or `undefined` when
 * `key` is not a legacy name.
 */
export function canonicalEnvKey(key: string): string | undefined {
	const prefix = legacyPrefixOf(key);

	if (prefix === undefined) {
		return undefined;
	}

	return RENAMED_LEGACY_KEYS[key] ?? `${ENV_PREFIX}${key.slice(prefix.length)}`;
}

function legacyRank(key: string): number {
	const prefix = legacyPrefixOf(key);

	return prefix === undefined ? LEGACY_ENV_PREFIXES.length : LEGACY_ENV_PREFIXES.indexOf(prefix);
}

interface NormalizedEnv {
	/** Keyed by the `WASANDBOX_*` name, whichever spelling supplied the value. */
	values: Record<string, string>;
	/** Canonical name → the name the operator actually set, so errors quote what they typed. */
	sourceNames: Map<string, string>;
}

function blankToUndefined(value: string | undefined): string | undefined {
	const trimmed = value?.trim();

	return trimmed === "" ? undefined : trimmed;
}

/**
 * Keeps only WaSandbox's own variables and treats blank ones as unset, so an empty
 * `WASANDBOX_WEBHOOK_URL=` in a compose file behaves like an absent variable instead of
 * failing validation. Values are trimmed (secrets read from files often carry a newline).
 * A `MOCKWA_*` or `WHALOC_*` alias fills its `WASANDBOX_*` name only when that name is unset,
 * and a `MOCKWA_*` alias is taken before a `WHALOC_*` one.
 */
function normalizeEnv(env: NodeJS.ProcessEnv): NormalizedEnv {
	const values: Record<string, string> = {};
	const sourceNames = new Map<string, string>();

	for (const [key, value] of Object.entries(env)) {
		const trimmed = blankToUndefined(value);

		if (trimmed !== undefined && key.startsWith(ENV_PREFIX)) {
			values[key] = trimmed;
			sourceNames.set(key, key);
		}
	}

	const legacyEntries = Object.entries(env)
		.filter(([key]) => legacyPrefixOf(key) !== undefined)
		.toSorted(([a], [b]) => legacyRank(a) - legacyRank(b));

	for (const [key, value] of legacyEntries) {
		const canonical = canonicalEnvKey(key);
		const trimmed = blankToUndefined(value);

		if (canonical !== undefined && trimmed !== undefined && values[canonical] === undefined) {
			values[canonical] = trimmed;
			sourceNames.set(canonical, key);
		}
	}

	return { values, sourceNames };
}

/**
 * `WASANDBOX_SEED_FILE` names a file that holds the seed JSON, for seeds too long to keep inline
 * in a compose file. It stands in for `WASANDBOX_SEED`, so setting both is ambiguous and refused
 * rather than silently preferring one. An empty file is refused too: falling back to the
 * default seed would hide a broken mount behind a world that merely looks wrong.
 */
function resolveSeedFile(env: NormalizedEnv, readTextFile: ReadTextFile | undefined): string[] {
	const seedFile = env.values[SEED_FILE_KEY];

	if (seedFile === undefined) {
		return [];
	}

	const seedFileName = env.sourceNames.get(SEED_FILE_KEY) ?? SEED_FILE_KEY;

	if (env.values[SEED_KEY] !== undefined) {
		return [`${env.sourceNames.get(SEED_KEY) ?? SEED_KEY} and ${seedFileName} are both set: use only one of them`];
	}

	if (readTextFile === undefined) {
		return [`${seedFileName}: reading files is not available here`];
	}

	let contents: string;

	try {
		contents = readTextFile(seedFile).trim();
	} catch (error) {
		const reason = Error.isError(error) ? error.message : String(error);

		return [`${seedFileName}: cannot read ${seedFile}: ${reason}`];
	}

	if (contents === "") {
		return [`${seedFileName}: ${seedFile} is empty`];
	}

	env.values[SEED_KEY] = contents;
	env.sourceNames.set(SEED_KEY, seedFileName);

	return [];
}

/** Each issue names the variable the operator actually set (an alias, or the seed file). */
function formatIssues(error: z.ZodError, sourceNames: ReadonlyMap<string, string>): string[] {
	return error.issues.map(issue => {
		const segments = issue.path.map(String);

		if (segments[0] !== undefined) {
			segments[0] = sourceNames.get(segments[0]) ?? segments[0];
		}

		const path = segments.join(".");

		return path === "" ? issue.message : `${path}: ${issue.message}`;
	});
}

/**
 * Parses the environment once at boot. Never throws: the caller decides how to report the
 * (complete) list of problems and how to exit. `readTextFile` is only needed for the variables
 * that point at a file (`WASANDBOX_SEED_FILE`).
 */
export function parseConfig(env: NodeJS.ProcessEnv, readTextFile?: ReadTextFile): ParseConfigResult {
	const normalized = normalizeEnv(env);
	const fileErrors = resolveSeedFile(normalized, readTextFile);
	const result = appConfigSchema.safeParse(normalized.values);
	const errors = [...fileErrors, ...(result.success ? [] : formatIssues(result.error, normalized.sourceNames))];

	return result.success && errors.length === 0 ? { success: true, config: result.data } : { success: false, errors };
}

/**
 * The `WASANDBOX_S3_*` variables, named here because a `local` backend drops them during parsing:
 * a bucket nobody reads leaves no trace in {@link AppConfig} to warn about.
 */
const S3_ENV_KEYS = [
	"WASANDBOX_S3_BUCKET",
	"WASANDBOX_S3_REGION",
	"WASANDBOX_S3_ENDPOINT",
	"WASANDBOX_S3_ACCESS_KEY_ID",
	"WASANDBOX_S3_SECRET_ACCESS_KEY",
	"WASANDBOX_S3_FORCE_PATH_STYLE",
] as const;

/** Whether `key` (a `WASANDBOX_*` name) or one of its legacy aliases carries a non-blank value. */
function isSet(env: NodeJS.ProcessEnv, key: string): boolean {
	return Object.entries(env).some(
		([name, value]) => (name === key || canonicalEnvKey(name) === key) && blankToUndefined(value) !== undefined,
	);
}

/**
 * Configuration that is valid but leaves a feature disabled — logged loudly at boot. `env` is
 * the raw environment, for the handful of variables the parsed config does not carry.
 */
export function collectConfigWarnings(config: AppConfig, env: NodeJS.ProcessEnv = {}): string[] {
	const warnings: string[] = [];

	if (config.webhookUrl === undefined) {
		warnings.push(
			"WASANDBOX_WEBHOOK_URL is not set: webhook delivery is disabled, nothing will be sent to the app under test",
		);
	} else if (config.appSecret === undefined) {
		warnings.push(
			"WASANDBOX_APP_SECRET is not set: webhook deliveries will be sent without an X-Hub-Signature-256 header",
		);
	}

	if (config.verifyOnStart && config.webhookVerifyToken === undefined) {
		warnings.push(
			"WASANDBOX_VERIFY_ON_START is enabled but WASANDBOX_WEBHOOK_VERIFY_TOKEN is not set: the handshake cannot run",
		);
	}

	// A configured bucket that nothing reads is the kind of mistake that only surfaces when
	// somebody goes looking for objects that were never written (SPEC §6).
	if (config.mediaBackend === "local" && S3_ENV_KEYS.some(key => isSet(env, key))) {
		warnings.push(
			'WASANDBOX_S3_* is set but WASANDBOX_MEDIA_BACKEND is not "s3": media bytes go to WASANDBOX_MEDIA_DIR and the bucket is ignored',
		);
	}

	if (config.s3 !== undefined && config.s3.credentials === undefined) {
		warnings.push(
			"WASANDBOX_S3_ACCESS_KEY_ID / WASANDBOX_S3_SECRET_ACCESS_KEY are not set: the AWS SDK's default credential chain will be used",
		);
	}

	// Two spellings set is not an error (the newest name wins), but a differing value means the
	// operator probably edited one of them and expects it to count.
	const { values, sourceNames } = normalizeEnv(env);

	for (const [name, value] of Object.entries(env)) {
		const canonical = canonicalEnvKey(name);
		const legacy = blankToUndefined(value);
		const used = canonical === undefined ? undefined : sourceNames.get(canonical);

		if (
			canonical !== undefined &&
			used !== undefined &&
			used !== name &&
			legacy !== undefined &&
			legacy !== values[canonical]
		) {
			warnings.push(`${name} and ${used} are both set to different values: ${used} is used`);
		}
	}

	return warnings;
}

/** Boot-time summary for the logs: counts instead of the whole seed, secrets never printed. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
	let phoneNumbers = 0;
	let contacts = 0;
	let templates = 0;

	for (const waba of config.seed) {
		phoneNumbers += waba.phoneNumbers.length;
		contacts += waba.contacts.length;
		templates += waba.templates.length;
	}

	return {
		graphPort: config.graphPort,
		consolePort: config.consolePort,
		host: config.host,
		publicUrl: config.publicUrl,
		webhookUrl: config.webhookUrl ?? null,
		appSecret: config.appSecret === undefined ? "unset" : "set",
		webhookVerifyToken: config.webhookVerifyToken === undefined ? "unset" : "set",
		verifyOnStart: config.verifyOnStart,
		statusDelays: config.statusDelays,
		templateAutoApproveMs: config.templateAutoApproveMs,
		// Counted, never printed: the registry is a list of credentials (SPEC §1.9).
		tokens: config.tokens === undefined ? "unset" : { registered: config.tokens.length },
		mediaTtlSeconds: config.mediaTtlSeconds ?? null,
		dbPath: config.dbPath,
		mediaBackend: config.mediaBackend,
		mediaDir: config.mediaDir,
		// The bucket and where it lives, never the keys that open it (SPEC §6).
		s3:
			config.s3 === undefined
				? null
				: {
						bucket: config.s3.bucket,
						region: config.s3.region,
						endpoint: config.s3.endpoint ?? null,
						forcePathStyle: config.s3.forcePathStyle,
						credentials: config.s3.credentials === undefined ? "default-chain" : "configured",
					},
		webDir: config.webDir,
		logLevel: config.logLevel,
		seed: { wabas: config.seed.length, phoneNumbers, contacts, templates },
		// Names only: each app carries a secret and possibly a token.
		apps: config.apps.map(app => app.name),
		webhookRetryScheduleMs: config.webhookRetryScheduleMs,
		webhookRetryMaxAgeMs: config.webhookRetryMaxAgeMs,
		messaging: config.messaging,
		clock: {
			mode: config.clock.mode,
			start: config.clock.mode === "virtual" ? config.clock.start.toISOString() : null,
		},
		// Whether a token is set, never the token (SPEC §7, "Access modes").
		access: {
			mode: config.access.mode,
			adminToken: config.access.adminToken === undefined ? "unset" : "set",
			trustedProxies: config.access.trustedProxies,
			allowedOrigins: config.access.allowedOrigins,
			cookieSecure: config.access.cookieSecure,
			visitors: config.access.mode === "public" ? config.access.visitors : null,
		},
	};
}
