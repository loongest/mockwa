import { DEFAULT_SERVICE_WINDOW_MS, META_THROUGHPUT_MPS, type MessagingRulesConfig } from "../config/index.ts";
import type { PhoneNumberRecord, Repositories } from "../db/index.ts";
import { RETRY_AFTER_HEADER } from "./injection-presets.ts";
import { SIMULATED_MESSAGING_LIMIT_CODE, type SendFailure } from "./message-error-presets.ts";
import { pairRateLimitError, rateLimitError } from "./meta-errors.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * Meta's messaging rules (SPEC §4, "Messaging rules"), decided in one place.
 *
 * Two kinds of answer, because Meta gives two kinds:
 *
 * - **Refusals** happen before a send is accepted and are thrown as Graph errors: throughput
 *   (`130429`) and the pair rate limit (`131056`). {@link MessagingRules.admit} checks and
 *   consumes both in one synchronous step, so two sends in the same tick cannot both take the
 *   last slot.
 * - **Failures** happen after: the send answers 200 with a wamid, and its status webhook says
 *   `failed` instead of `sent`. That is how a free-form message outside the customer service
 *   window (`131047`) and a send over the messaging limit (mockwa's own `990001`) end.
 *
 * Throughput and pair-rate state lives in memory, like every other timer here: a restart or a
 * reset starts both counts afresh. Everything reads the injected clock, so a test steps over a
 * boundary instead of waiting for it.
 */

/** Meta's messaging limit counts unique users over a moving 24 hours, whatever the window is set to. */
const MESSAGING_LIMIT_PERIOD_MS = 86_400_000;
const SECOND_MS = 1000;

export interface MessagingRulesOptions {
	repositories: Repositories;
	config: MessagingRulesConfig;
	scheduler?: Scheduler;
}

/** The customer service window between one business number and one contact. */
export interface ServiceWindowState {
	/** `false` when `MOCKWA_SERVICE_WINDOW=off`: the state is still reported, never enforced. */
	isEnforced: boolean;
	isOpen: boolean;
	/** The contact's latest message to this number; `null` if they never wrote. */
	lastInboundAt: Date | null;
	/** When the window closes (or closed); `null` if it never opened. */
	expiresAt: Date | null;
	windowMs: number;
}

/** How an admitted send ends, decided before it is stored. */
export interface SendVerdict {
	/** Sent while the window was closed — the messaging limit counts it. */
	isBusinessInitiated: boolean;
	/** The `failed` status it ends with instead of `sent`, or `null` to climb the ladder. */
	failure: SendFailure | null;
}

export interface MessagingLimitUsage {
	wabaId: string;
	/** `null` when no limit is configured. */
	limit: number | null;
	/** Unique contacts reached by business-initiated sends in the last 24 hours. */
	used: number;
}

export class MessagingRules {
	readonly #repositories: Repositories;
	readonly #config: MessagingRulesConfig;
	readonly #scheduler: Scheduler;
	/** Per phone number: the second being counted, and the sends admitted in it. */
	readonly #throughput = new Map<string, { second: number; count: number }>();
	/** Per (number, contact): the theoretical arrival time of the next send, in epoch ms. */
	readonly #pairArrivals = new Map<string, number>();

	constructor(options: MessagingRulesOptions) {
		this.#repositories = options.repositories;
		this.#config = options.config;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
	}

	/** Meta's figure for the number's `throughput.level`, or the one configured for every number. */
	#messagesPerSecond(phoneNumber: PhoneNumberRecord): number | null {
		const throughput = this.#config.throughput;

		if (throughput === null) {
			return null;
		}

		return throughput === "meta" ? META_THROUGHPUT_MPS[phoneNumber.throughputLevel] : throughput.messagesPerSecond;
	}

	/** Fixed one-second windows per number: the count resets on each new second. */
	#checkThroughput(phoneNumber: PhoneNumberRecord, now: number): (() => void) | null {
		const limit = this.#messagesPerSecond(phoneNumber);

		if (limit === null) {
			return null;
		}

		const second = Math.floor(now / SECOND_MS);
		const current = this.#throughput.get(phoneNumber.id);
		const count = current?.second === second ? current.count : 0;

		if (count >= limit) {
			// Meta documents the code and nothing about headers; `Retry-After` is the honest one,
			// since the next second is when a send goes through again.
			throw rateLimitError({ [RETRY_AFTER_HEADER]: "1" });
		}

		return () => {
			this.#throughput.set(phoneNumber.id, { second, count: count + 1 });
		};
	}

	/**
	 * Meta's pair rate limit as a generic cell rate: one send per interval on average, with up to
	 * `burst` at once — a burst "borrows" from the future, so it is paid back by waiting.
	 */
	#checkPairRate(phoneNumberId: string, waId: string, now: number): (() => void) | null {
		const limit = this.#config.pairRateLimit;

		if (limit === null) {
			return null;
		}

		const key = `${phoneNumberId}:${waId}`;
		const arrival = Math.max(this.#pairArrivals.get(key) ?? now, now);

		if (arrival - now > (limit.burst - 1) * limit.intervalMs) {
			throw pairRateLimitError();
		}

		return () => {
			this.#pairArrivals.set(key, arrival + limit.intervalMs);
		};
	}

	/** Whether this send would reach a contact beyond the messaging limit of the number's WABA. */
	async #isOverMessagingLimit(phoneNumber: PhoneNumberRecord, waId: string): Promise<boolean> {
		const limit = this.#config.messagingLimit;

		if (limit === null) {
			return false;
		}

		const recipients = await this.#recipientsInPeriod(phoneNumber.wabaId);

		return !recipients.includes(waId) && recipients.length >= limit;
	}

	/**
	 * Messaging limits are set per business portfolio, which mockwa does not model; the WABA is
	 * the nearest thing it has, so every number in one WABA shares one count (SPEC §4).
	 */
	async #recipientsInPeriod(wabaId: string): Promise<string[]> {
		const phoneNumbers = await this.#repositories.phoneNumbers.listByWabaId(wabaId);
		const since = new Date(this.#scheduler.now().getTime() - MESSAGING_LIMIT_PERIOD_MS);

		return this.#repositories.messages.listBusinessInitiatedRecipients(
			phoneNumbers.map(phoneNumber => phoneNumber.id),
			since,
		);
	}

	/**
	 * The window opens when the contact writes and closes `windowMs` later; another message
	 * from them restarts it. Closed **at** the boundary: 24 hours after the last message, the
	 * timer has run out.
	 */
	async serviceWindow(phoneNumberId: string, waId: string): Promise<ServiceWindowState> {
		const windowMs = this.#config.serviceWindowMs ?? DEFAULT_SERVICE_WINDOW_MS;
		const lastInboundAt = await this.#repositories.messages.lastInboundAt(phoneNumberId, waId);
		const expiresAt = lastInboundAt === null ? null : new Date(lastInboundAt.getTime() + windowMs);

		return {
			isEnforced: this.#config.serviceWindowMs !== null,
			isOpen: expiresAt !== null && this.#scheduler.now().getTime() < expiresAt.getTime(),
			lastInboundAt,
			expiresAt,
			windowMs,
		};
	}

	/**
	 * The two refusals, checked together and consumed together: a send the pair limit refuses
	 * must not have used up a throughput slot. Throws Meta's envelope; returns when admitted.
	 */
	admit(phoneNumber: PhoneNumberRecord, waId: string): void {
		const now = this.#scheduler.now().getTime();
		const consumers = [this.#checkThroughput(phoneNumber, now), this.#checkPairRate(phoneNumber.id, waId, now)];

		for (const consume of consumers) {
			consume?.();
		}
	}

	/**
	 * How an admitted send ends. Templates may go out at any time — that is what they are for —
	 * and one sent while the window is closed is business-initiated, which is what the
	 * messaging limit counts. Anything else needs an open window.
	 */
	async verdict(phoneNumber: PhoneNumberRecord, waId: string, isTemplate: boolean): Promise<SendVerdict> {
		const window = await this.serviceWindow(phoneNumber.id, waId);

		if (!isTemplate) {
			const isRefused = window.isEnforced && !window.isOpen;

			return { isBusinessInitiated: false, failure: isRefused ? 131_047 : null };
		}

		if (window.isOpen) {
			return { isBusinessInitiated: false, failure: null };
		}

		// A send that fails reaches nobody, so it is not counted against the limit either.
		return (await this.#isOverMessagingLimit(phoneNumber, waId))
			? { isBusinessInitiated: false, failure: SIMULATED_MESSAGING_LIMIT_CODE }
			: { isBusinessInitiated: true, failure: null };
	}

	/** Each WABA's messaging-limit count, for the control plane. */
	async messagingLimitUsage(): Promise<MessagingLimitUsage[]> {
		const wabas = await this.#repositories.wabas.list();
		const usage: MessagingLimitUsage[] = [];

		for (const waba of wabas) {
			const recipients = await this.#recipientsInPeriod(waba.id);

			usage.push({ wabaId: waba.id, limit: this.#config.messagingLimit, used: recipients.length });
		}

		return usage;
	}

	get config(): MessagingRulesConfig {
		return this.#config;
	}

	/** `POST /api/reset`: throughput and pair-rate counts start afresh. */
	reset(): void {
		this.#throughput.clear();
		this.#pairArrivals.clear();
	}
}
