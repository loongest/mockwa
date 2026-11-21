import type { HandshakeResult } from "@wasandbox/shared";
import type { DepartedNumbers } from "./departed-numbers.ts";
import { DEFAULT_RETRY_MAX_AGE_MS, DEFAULT_RETRY_SCHEDULE_MS } from "../config/index.ts";
import type { JsonObject, Repositories, WebhookDeliveryHeaders, WebhookDeliveryRecord } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import { AppService, DEFAULT_APP_KEY, type WebhookApp, type WebhookRoute } from "./app-service.ts";
import { toWebhookDeliveryDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createWebhookChallenge, createWebhookDeliveryId, defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { metaSignatureHeader, serializeMetaJson, SIGNATURE_HEADER } from "./meta-json.ts";
import { createSystemScheduler, type ScheduledTask, type Scheduler } from "./scheduler.ts";

/**
 * The one service that talks to the apps under test (SPEC §3).
 *
 * - **The body is produced once.** `serializeMetaJson` runs, and that exact string is what is
 *   signed and what is sent to every app (SPEC §1.12). Re-encoding anywhere in between would
 *   break every receiver that verifies the signature.
 * - **Each app gets its own copy**, routed by Meta's rules ({@link AppService.route}) and
 *   signed with that app's secret.
 * - **Every attempt is logged**, including the ones that never happened because an app has no
 *   URL. The delivery log is a first-class feature: pointing WaSandbox at nothing and still seeing
 *   what it would have sent is how the console is useful before an integration exists.
 * - **Retries are Meta's and they are persisted.** Only an HTTP 200 is a success; anything else
 *   — a 4xx, a 204, a timeout — is retried on a fixed schedule until the chain is 7 days old.
 *   The next due time is stored on the attempt row, so a restart with a file database resumes
 *   the queue instead of losing it. The schedule is the injected clock's, so specs drive it
 *   without waiting.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The webhook half of `AppConfig` (SPEC §7): the default app. */
export interface WebhookTarget {
	url?: string | undefined;
	appSecret?: string | undefined;
	verifyToken?: string | undefined;
}

export interface WebhookEmitterOptions {
	repositories: Repositories;
	logger: Logger;
	/** Routes and apps. Built from `target` when omitted, which is what most specs do. */
	apps?: AppService;
	/** The default app, when `apps` is not given. */
	target?: WebhookTarget;
	events?: EventPublisher;
	scheduler?: Scheduler;
	/** Injected in tests; defaults to the global `fetch`. */
	fetch?: FetchLike;
	random?: RandomBytes;
	/** Tie-breaker of the delivery IDs; the ID stream's under the virtual clock. */
	nextSequence?: () => number;
	/** Delay before each retry; the last repeats. `[]` disables retries. */
	retryScheduleMs?: readonly number[];
	/** A chain stops retrying once its first attempt is this old. */
	retryMaxAgeMs?: number;
	requestTimeoutMs?: number;
	/**
	 * Public mode: refuses to log a delivery naming a visitor who left while it was in flight,
	 * so a late response can neither write the visitor's text back nor queue a retry for it.
	 */
	departed?: DepartedNumbers;
}

/** Response bodies are logged for debugging, not archived — 64 KiB is plenty. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

/** Same ceiling for what a receiver echoes back during the handshake. */
const MAX_ECHO_LENGTH = 1024;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** `setTimeout` overflows past 2^31 - 1 ms; a longer wait is re-armed when it fires. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A timer that fired with nothing due is re-armed once; then the next emit re-arms it. */
const MAX_IDLE_FIRES = 1;

/** The `url` a skipped delivery is stored with; `toWebhookDeliveryDto` reads it as `skipped`. */
export const SKIPPED_DELIVERY_URL = "";

export const SKIPPED_DELIVERY_ERROR = "WASANDBOX_WEBHOOK_URL is not set: nothing was sent, the payload is logged only";

/** Event type of a `POST /api/webhook/raw` escape-hatch delivery (SPEC §5). */
export const RAW_EVENT_TYPE = "raw";

/** Meta's success is exactly this status; a 2xx that is not it is retried (SPEC §3). */
export const SUCCESS_STATUS = 200;

const USER_AGENT = "facebookexternalua";

function truncate(value: string, max: number): string {
	return value.length > max ? value.slice(0, max) : value;
}

/**
 * The response body, capped and never fatal: a receiver that answers with a broken stream has
 * still answered, and the status is the part that decides whether to retry.
 */
async function readBody(response: Response, max: number): Promise<string> {
	try {
		return truncate(await response.text(), max);
	} catch {
		return "";
	}
}

/** What lands in `webhook_deliveries.error`: readable, no stack, cause included. */
function describeError(error: unknown): string {
	if (Error.isError(error)) {
		const cause = Error.isError(error.cause) ? ` (${error.cause.message})` : "";

		return `${error.name}: ${error.message}${cause}`;
	}

	return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads where an envelope belongs off the envelope itself: `entry[0].id` is the WABA, the
 * change's `field` names the event, and `value["metadata"].phone_number_id` the number a
 * `messages` change is about. A raw payload shaped like something else routes to the default
 * app, the only address it can have.
 */
export function routeOf(
	eventType: string,
	envelope: JsonObject,
): { field: string; wabaId?: string; phoneNumberId?: string } {
	const entry = Array.isArray(envelope["entry"]) ? (envelope["entry"][0] as unknown) : undefined;

	if (!isRecord(entry)) {
		return { field: eventType };
	}

	const change = Array.isArray(entry["changes"]) ? (entry["changes"][0] as unknown) : undefined;
	const field = isRecord(change) && typeof change["field"] === "string" ? change["field"] : eventType;
	const value = isRecord(change) ? change["value"] : undefined;
	const metadata = isRecord(value) ? value["metadata"] : undefined;
	const phoneNumberId = isRecord(metadata) ? metadata["phone_number_id"] : undefined;

	return {
		field,
		...(typeof entry["id"] === "string" && { wabaId: entry["id"] }),
		...(typeof phoneNumberId === "string" && { phoneNumberId }),
	};
}

interface AttemptOutcome {
	status: number | null;
	responseBody: string | null;
	error: string | null;
	durationMs: number;
}

export class WebhookEmitter {
	readonly #repositories: Repositories;
	readonly #logger: Logger;
	readonly #apps: AppService;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #fetch: FetchLike;
	readonly #random: RandomBytes;
	readonly #nextSequence: (() => number) | undefined;
	readonly #retryScheduleMs: readonly number[];
	readonly #retryMaxAgeMs: number;
	readonly #requestTimeoutMs: number;
	readonly #departed: DepartedNumbers | undefined;
	#lastHandshake: HandshakeResult | null = null;
	#timer: ScheduledTask | null = null;
	#timerDueAt: number | null = null;
	#idleFires = 0;
	#draining: Promise<void> | null = null;
	#isStopped = false;

	constructor(options: WebhookEmitterOptions) {
		this.#repositories = options.repositories;
		this.#logger = options.logger;
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#apps =
			options.apps ??
			new AppService({
				repositories: options.repositories,
				defaultApp: {
					callbackUrl: options.target?.url,
					appSecret: options.target?.appSecret,
					verifyToken: options.target?.verifyToken,
				},
				scheduler: this.#scheduler,
			});
		this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
		this.#random = options.random ?? defaultRandomBytes;
		this.#nextSequence = options.nextSequence;
		this.#retryScheduleMs = options.retryScheduleMs ?? DEFAULT_RETRY_SCHEDULE_MS;
		this.#retryMaxAgeMs = options.retryMaxAgeMs ?? DEFAULT_RETRY_MAX_AGE_MS;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.#departed = options.departed;
	}

	#headers(app: WebhookApp, body: string): WebhookDeliveryHeaders {
		return {
			"content-type": "application/json",
			// Meta's own user agent; receivers log it and some check it.
			"user-agent": USER_AGENT,
			...(app.appSecret !== null && { [SIGNATURE_HEADER]: metaSignatureHeader(app.appSecret, body) }),
		};
	}

	async #record(input: {
		eventType: string;
		url: string;
		body: string;
		headers: WebhookDeliveryHeaders;
		attempt: number;
		appKey: string;
		chainId?: string;
		nextAttemptAt?: string | null;
		responseStatus?: number | null;
		responseBody?: string | null;
		error?: string | null;
		durationMs?: number | null;
	}): Promise<WebhookDeliveryRecord> {
		const row = {
			id: createWebhookDeliveryId(this.#random, this.#scheduler.now().getTime(), this.#nextSequence),
			eventType: input.eventType,
			url: input.url,
			requestBody: input.body,
			requestHeaders: input.headers,
			responseStatus: input.responseStatus ?? null,
			responseBody: input.responseBody ?? null,
			error: input.error ?? null,
			attempt: input.attempt,
			durationMs: input.durationMs ?? null,
			createdAt: this.#scheduler.now().toISOString(),
			appKey: input.appKey,
			...(input.chainId !== undefined && { chainId: input.chainId }),
			nextAttemptAt: input.nextAttemptAt ?? null,
		};

		if (await this.#isForDeparted(input.body)) {
			return { ...row, chainId: input.chainId ?? row.id, nextAttemptAt: null };
		}

		const record = await this.#repositories.webhookDeliveries.insert(row);

		// Checked again after the insert: a cleanup that ran between the two checks has already
		// deleted what it found, so this row would outlive it otherwise.
		if (await this.#isForDeparted(input.body)) {
			await this.#repositories.webhookDeliveries.deleteById(record.id);

			return { ...record, nextAttemptAt: null };
		}

		this.#announce(record);

		return record;
	}

	async #isForDeparted(body: string): Promise<boolean> {
		return this.#departed === undefined ? false : this.#departed.isMentionedIn(body);
	}

	#announce(record: WebhookDeliveryRecord): void {
		this.#events.publish({ type: "webhook.delivery", payload: { delivery: toWebhookDeliveryDto(record) } });
	}

	/**
	 * One POST. Never throws: a network failure is an outcome, and the retry queue decides
	 * whether it is worth another attempt.
	 */
	async #attempt(url: string, body: string, headers: WebhookDeliveryHeaders): Promise<AttemptOutcome> {
		// Wall-clock on purpose: the duration and the request timeout measure the network, which
		// the virtual clock does not move — a receiver that never answers still gives up after
		// `requestTimeoutMs` of real time, so no clock operation can hang on it.
		const startedAt = Date.now();

		try {
			const response = await this.#fetch(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(this.#requestTimeoutMs),
			});
			return {
				status: response.status,
				responseBody: await readBody(response, MAX_RESPONSE_BODY_BYTES),
				error: null,
				durationMs: Date.now() - startedAt,
			};
		} catch (error) {
			return { status: null, responseBody: null, error: describeError(error), durationMs: Date.now() - startedAt };
		}
	}

	/**
	 * When the attempt after `attempt` is due, or `null` when the chain is done: retries are
	 * off, or the next one would land past the chain's maximum age (Meta's 7 days).
	 */
	#nextAttemptAt(chainStartedAt: string, attempt: number): string | null {
		if (this.#retryScheduleMs.length === 0) {
			return null;
		}

		const delay = this.#retryScheduleMs[Math.min(attempt, this.#retryScheduleMs.length) - 1]!;
		const due = this.#scheduler.now().getTime() + delay;

		if (due - Date.parse(chainStartedAt) > this.#retryMaxAgeMs) {
			return null;
		}

		const dueAt = new Date(due);

		return dueAt.toISOString();
	}

	#skipReason(app: WebhookApp): string {
		return app.isDefault
			? SKIPPED_DELIVERY_ERROR
			: `app "${app.name}" has no callback URL: nothing was sent, the payload is logged only`;
	}

	/** The first attempt of one app's copy; a failure leaves a retry on the queue. */
	async #deliver(route: WebhookRoute, eventType: string, body: string): Promise<WebhookDeliveryRecord> {
		const headers = this.#headers(route.app, body);

		if (route.url === null) {
			// Still logged so the console shows what the app would have received (SPEC §3).
			this.#logger.debug({ eventType, app: route.app.key }, "webhook delivery skipped, the app has no URL");

			return this.#record({
				eventType,
				url: SKIPPED_DELIVERY_URL,
				body,
				headers,
				attempt: 1,
				appKey: route.app.key,
				error: this.#skipReason(route.app),
			});
		}

		const outcome = await this.#attempt(route.url, body, headers);
		const isSuccess = outcome.status === SUCCESS_STATUS;
		const startedAt = this.#scheduler.now().toISOString();
		const record = await this.#record({
			eventType,
			url: route.url,
			body,
			headers,
			attempt: 1,
			appKey: route.app.key,
			nextAttemptAt: isSuccess ? null : this.#nextAttemptAt(startedAt, 1),
			responseStatus: outcome.status,
			responseBody: outcome.responseBody,
			error: outcome.error,
			durationMs: outcome.durationMs,
		});

		this.#logOutcome(record);

		if (record.nextAttemptAt !== null) {
			await this.#arm();
		}

		return record;
	}

	#logOutcome(record: WebhookDeliveryRecord): void {
		const context = {
			eventType: record.eventType,
			url: record.url,
			app: record.appKey,
			status: record.responseStatus,
			attempt: record.attempt,
			nextAttemptAt: record.nextAttemptAt,
		};

		if (record.responseStatus === SUCCESS_STATUS) {
			this.#logger.debug(context, "webhook delivered");
		} else {
			this.#logger.warn({ ...context, err: record.error }, "webhook delivery attempt failed");
		}
	}

	/** One retry of a claimed row: the same URL, headers and bytes, as the next attempt of its chain. */
	async #retry(previous: WebhookDeliveryRecord): Promise<void> {
		const chainStart = await this.#repositories.webhookDeliveries.findById(previous.chainId);
		const startedAt = chainStart?.createdAt ?? previous.createdAt;
		const outcome = await this.#attempt(previous.url, previous.requestBody, previous.requestHeaders);
		const attempt = previous.attempt + 1;
		const record = await this.#record({
			eventType: previous.eventType,
			url: previous.url,
			body: previous.requestBody,
			headers: previous.requestHeaders,
			attempt,
			appKey: previous.appKey ?? DEFAULT_APP_KEY,
			chainId: previous.chainId,
			nextAttemptAt: outcome.status === SUCCESS_STATUS ? null : this.#nextAttemptAt(startedAt, attempt),
			responseStatus: outcome.status,
			responseBody: outcome.responseBody,
			error: outcome.error,
			durationMs: outcome.durationMs,
		});

		this.#logOutcome(record);
	}

	/** Points the timer at the earliest due retry, or clears it when nothing is owed. */
	async #arm(): Promise<void> {
		if (this.#isStopped) {
			return;
		}

		let nextDueAt: string | null;

		// Arming runs after a send and from timers, where nobody awaits it: a failure (a database
		// closed during shutdown) is logged rather than left as an unhandled rejection.
		try {
			nextDueAt = await this.#repositories.webhookDeliveries.nextDueAt();
		} catch (error) {
			this.#logger.error({ err: error }, "could not schedule webhook retries");

			return;
		}

		if (nextDueAt === null) {
			this.#timer?.cancel();
			this.#timer = null;
			this.#timerDueAt = null;

			return;
		}

		const dueAt = Date.parse(nextDueAt);

		if (this.#timer !== null && this.#timerDueAt !== null && this.#timerDueAt <= dueAt) {
			return;
		}

		this.#timer?.cancel();
		this.#timerDueAt = dueAt;

		const delay = Math.min(Math.max(0, dueAt - this.#scheduler.now().getTime()), MAX_TIMER_DELAY_MS);

		this.#timer = this.#scheduler.schedule(
			delay,
			() => {
				this.#timer = null;
				this.#timerDueAt = null;
				void this.runDueRetries();
			},
			"webhook retry",
		);
	}

	/** Sends one batch of due rows, each claimed first so it can never go out twice. */
	async #sendDue(due: readonly WebhookDeliveryRecord[]): Promise<number> {
		let sent = 0;

		for (const row of due) {
			const isClaimed = await this.#repositories.webhookDeliveries.claim(row.id);

			if (isClaimed) {
				await this.#retry(row);
				sent += 1;
			}
		}

		return sent;
	}

	/** Batches until nothing is due; a retry that fails again is due later, not now. */
	async #sendAllDue(): Promise<number> {
		let processed = 0;

		for (;;) {
			const now = this.#scheduler.now().toISOString();
			const due = await this.#repositories.webhookDeliveries.listDue(now);

			if (due.length === 0 || this.#isStopped) {
				return processed;
			}

			processed += await this.#sendDue(due);
		}
	}

	async #drain(): Promise<void> {
		let processed = 0;

		try {
			processed = await this.#sendAllDue();
		} catch (error) {
			this.#logger.error({ err: error }, "webhook retry pass failed");
		}

		// A timer that fired a hair early finds nothing due; re-arm once, not forever.
		this.#idleFires = processed === 0 ? this.#idleFires + 1 : 0;

		if (this.#idleFires <= MAX_IDLE_FIRES) {
			await this.#arm();
		}
	}

	async #runPass(): Promise<void> {
		try {
			await this.#drain();
		} finally {
			this.#draining = null;
		}
	}

	#handshakeFailure(url: string, challenge: string, error: string): HandshakeResult {
		return {
			ok: false,
			url,
			status: null,
			challenge,
			echo: null,
			error,
			at: this.#scheduler.now().toISOString(),
		};
	}

	/** The round trip itself: `hub.mode=subscribe` in, the challenge echoed back out. */
	async #verify(url: string, verifyToken: string, challenge: string): Promise<HandshakeResult> {
		const target = new URL(url);

		target.searchParams.set("hub.mode", "subscribe");
		target.searchParams.set("hub.verify_token", verifyToken);
		target.searchParams.set("hub.challenge", challenge);

		const response = await this.#fetch(target.href, {
			method: "GET",
			headers: { "user-agent": USER_AGENT },
			signal: AbortSignal.timeout(this.#requestTimeoutMs),
		});
		const echo = await readBody(response, MAX_ECHO_LENGTH);
		const isEchoed = response.ok && echo === challenge;

		return {
			ok: isEchoed,
			url,
			status: response.status,
			challenge,
			echo,
			error: isEchoed ? null : "the receiver did not echo the challenge",
			at: this.#scheduler.now().toISOString(),
		};
	}

	async #emitToRoutes(eventType: string, envelope: JsonObject): Promise<WebhookDeliveryRecord[]> {
		const body = serializeMetaJson(envelope);
		const routes = await this.#apps.route(routeOf(eventType, envelope));
		const records: WebhookDeliveryRecord[] = [];

		for (const route of routes) {
			records.push(await this.#deliver(route, eventType, body));
		}

		return records;
	}

	async #handshakeWith(url: string | null, verifyToken: string | null, missing: { url: string; token: string }) {
		const challenge = createWebhookChallenge(this.#random);

		if (url === null) {
			return this.#handshakeFailure("", challenge, missing.url);
		}

		if (verifyToken === null) {
			return this.#handshakeFailure(url, challenge, missing.token);
		}

		let result: HandshakeResult;

		try {
			result = await this.#verify(url, verifyToken, challenge);
		} catch (error) {
			this.#logger.warn({ url, err: error }, "webhook handshake failed");

			return this.#handshakeFailure(url, challenge, describeError(error));
		}

		if (result.ok) {
			this.#logger.info({ url }, "webhook handshake succeeded");
		} else {
			this.#logger.warn({ url, status: result.status }, "webhook handshake failed");
		}

		return result;
	}

	/**
	 * Sends every retry that is due, then re-arms for the next one. Public so a spec (and the
	 * boot sequence) can drain the queue without waiting on a timer; concurrent calls share one
	 * pass.
	 */
	async runDueRetries(): Promise<void> {
		this.#draining ??= this.#runPass();

		return this.#draining;
	}

	/** Whether a retry pass is running right now. */
	get isBusy(): boolean {
		return this.#draining !== null;
	}

	/** Resolves once no retry pass is running; part of what a virtual-clock advance waits for. */
	async whenIdle(): Promise<void> {
		while (this.#draining !== null) {
			await this.#draining;
		}
	}

	/** Boot, reset and import call this: whatever the database owes is scheduled again. */
	async resumeRetries(): Promise<void> {
		this.#isStopped = false;
		this.#idleFires = 0;
		this.#timer?.cancel();
		this.#timer = null;
		this.#timerDueAt = null;
		await this.#arm();
	}

	/** Shutdown: stops the timer. Pending rows stay pending, for the next boot. */
	stop(): void {
		this.#isStopped = true;
		this.#timer?.cancel();
		this.#timer = null;
		this.#timerDueAt = null;
	}

	/** Cancels the pending retry of the chain a delivery belongs to. `null` for an unknown delivery. */
	async cancelRetry(deliveryId: string): Promise<WebhookDeliveryRecord | null> {
		const delivery = await this.#repositories.webhookDeliveries.findById(deliveryId);

		if (delivery === null) {
			return null;
		}

		const chain = await this.#repositories.webhookDeliveries.listChain(delivery.chainId);
		const pending = chain.filter(row => row.nextAttemptAt !== null);

		await this.#repositories.webhookDeliveries.cancelPending({ chainId: delivery.chainId });

		for (const row of pending) {
			this.#announce({ ...row, nextAttemptAt: null });
		}

		await this.#arm();

		return (await this.#repositories.webhookDeliveries.findById(deliveryId)) ?? delivery;
	}

	get apps(): AppService {
		return this.#apps;
	}

	/** Whether the default app has somewhere to send to. */
	get isConfigured(): boolean {
		return this.#apps.defaultApp.callbackUrl !== null;
	}

	/** Result of the most recent default-app handshake, served by `GET /api/state` (SPEC §5). */
	get lastHandshake(): HandshakeResult | null {
		return this.#lastHandshake;
	}

	/**
	 * Serializes once, then signs and delivers a copy to every app the event routes to. Returns
	 * each copy's first attempt; failures go on the retry queue. Never rejects — a failure is a
	 * logged delivery row.
	 */
	async emit(eventType: string, envelope: JsonObject): Promise<WebhookDeliveryRecord[]> {
		try {
			return await this.#emitToRoutes(eventType, envelope);
		} catch (error) {
			this.#logger.error({ err: error, eventType }, "webhook emission failed");

			return [];
		}
	}

	/**
	 * `POST /api/webhook/raw` — any JSON object, signed and logged like a real event. Routed by
	 * its own `entry`, or to one app when `appKey` names it.
	 */
	async emitRaw(payload: JsonObject, appKey?: string): Promise<WebhookDeliveryRecord[]> {
		if (appKey === undefined) {
			return this.emit(RAW_EVENT_TYPE, payload);
		}

		const app = await this.#apps.require(appKey);

		return [
			await this.#deliver(
				{ app, url: app.callbackUrl, source: "app", verifyToken: app.verifyToken },
				RAW_EVENT_TYPE,
				serializeMetaJson(payload),
			),
		];
	}

	/**
	 * Re-sends a stored delivery's body as a new chain (SPEC §5). The body is replayed byte for
	 * byte and **re-signed** with its app's current secret, and it goes where that app's copy
	 * would go now — so a delivery captured before a URL or a secret was set goes out the second
	 * time. A delivery whose app is gone falls back to the URL it went to.
	 */
	async redeliver(deliveryId: string): Promise<WebhookDeliveryRecord[] | null> {
		const delivery = await this.#repositories.webhookDeliveries.findById(deliveryId);

		if (delivery === null) {
			return null;
		}

		const appKey = delivery.appKey ?? DEFAULT_APP_KEY;
		const app = await this.#apps.find(appKey);

		if (app === null) {
			return [
				await this.#deliver(
					{
						app: { ...this.#apps.defaultApp, key: appKey, name: appKey, isDefault: false, callbackUrl: null },
						url: delivery.url === SKIPPED_DELIVERY_URL ? null : delivery.url,
						source: "app",
						verifyToken: null,
					},
					delivery.eventType,
					delivery.requestBody,
				),
			];
		}

		const envelope = JSON.parse(delivery.requestBody) as unknown;
		const routes = isRecord(envelope) ? await this.#apps.route(routeOf(delivery.eventType, envelope)) : [];
		const route = routes.find(candidate => candidate.app.key === app.key) ?? {
			app,
			url: app.callbackUrl,
			source: "app" as const,
			verifyToken: app.verifyToken,
		};

		return [await this.#deliver(route, delivery.eventType, delivery.requestBody)];
	}

	async listDeliveries(query: { limit?: number; before?: string } = {}): Promise<WebhookDeliveryRecord[]> {
		return this.#repositories.webhookDeliveries.list(query);
	}

	/**
	 * The `hub.challenge` handshake against the default app, initiated by WaSandbox (SPEC §1.13):
	 * `GET <webhookUrl>` with `hub.mode=subscribe`, the configured verify token and a random
	 * challenge, which the receiver must echo back verbatim. Run on demand from the control
	 * plane, and at boot when `WASANDBOX_VERIFY_ON_START` is set.
	 */
	async handshake(): Promise<HandshakeResult> {
		const app = this.#apps.defaultApp;
		const result = await this.#handshakeWith(app.callbackUrl, app.verifyToken, {
			url: "WASANDBOX_WEBHOOK_URL is not set",
			token: "WASANDBOX_WEBHOOK_VERIFY_TOKEN is not set",
		});

		this.#lastHandshake = result;

		return result;
	}

	/**
	 * The handshake against any app, at its callback URL or at one of its overrides (`url`),
	 * with the verify token that belongs to that URL.
	 */
	async handshakeApp(
		appKey: string,
		target: { url?: string; verifyToken?: string | null } = {},
	): Promise<HandshakeResult> {
		const app = await this.#apps.require(appKey);

		if (app.isDefault && target.url === undefined) {
			return this.handshake();
		}

		return this.#handshakeWith(target.url ?? app.callbackUrl, target.verifyToken ?? app.verifyToken, {
			url: `app "${app.name}" has no callback URL`,
			token: `app "${app.name}" has no verify token`,
		});
	}
}
