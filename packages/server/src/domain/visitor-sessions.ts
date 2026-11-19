import type { Message, WsEvent } from "@mockwa/shared";
import { createHash } from "node:crypto";
import { VISITOR_WA_ID_LENGTH, type VisitorConfig } from "../config/index.ts";
import { WaIdTakenError, type ContactRecord, type PublicSessionRecord, type Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { MediaStorage } from "../storage/index.ts";
import { ControlPlaneError } from "./control-plane-error.ts";
import type { EventBus } from "./event-bus.ts";
import { defaultRandomBytes, type RandomBytes } from "./ids.ts";
import { deleteStoredMedia } from "./media-cleanup.ts";
import { RateLimiter, type RateLimitResult } from "./rate-limiter.ts";
import type { Scheduler } from "./scheduler.ts";

/** A drawn number that was handed out before is drawn again; this many tries is plenty. */
const MAX_WA_ID_DRAWS = 8;

/** `last_seen_at` is written at most this often, so a busy phone is not a write per request. */
const TOUCH_INTERVAL_MS = 5000;

/** How often the cleanup job looks for idle sessions, at most; a short TTL looks more often. */
const MAX_SWEEP_INTERVAL_MS = 60_000;

/** Why an authenticated request was refused; the phone shows a different message for each. */
export type VisitorAuthResult =
	| { status: "valid"; session: PublicSessionRecord }
	/** The browser sent no session cookie. */
	| { status: "none" }
	/** It sent one that names no live session: it expired, was cleaned up, or never existed. */
	| { status: "expired" };

export interface CreatedVisitorSession {
	/** The cookie's secret; only its hash is stored. */
	token: string;
	session: PublicSessionRecord;
	identities: ContactRecord[];
}

export interface VisitorSessionServiceOptions {
	config: VisitorConfig;
	repositories: Repositories;
	mediaStorage: MediaStorage;
	events: EventBus;
	logger: Logger;
	scheduler: Scheduler;
	random?: RandomBytes;
}

/** Refused for a quota or a rate: always a 429 with `Retry-After` (SPEC §5). */
export function limitExceeded(message: string, code: string, retryAfterSeconds?: number): ControlPlaneError {
	return new ControlPlaneError(message, {
		status: 429,
		code,
		...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
	});
}

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function base64Url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** The media IDs a message's payload names: `{image:{id}}`, `{document:{id}}`, … */
export function mediaIdsOf(message: Pick<Message, "type" | "payload">): string[] {
	const node = message.payload[message.type];

	if (node === null || typeof node !== "object" || Array.isArray(node)) {
		return [];
	}

	const id = (node as Record<string, unknown>)["id"];

	return typeof id === "string" ? [id] : [];
}

/**
 * Whether a control-plane event belongs on a visitor's phone socket (SPEC §5, "Public demo
 * mode"). Narrower than the developer phone's {@link isPhoneEvent}: a visitor gets its own
 * identity's messages, typing and contact row and **nothing world-wide** — a reset's or an
 * import's payload is the whole instance's state, and a phone number's carries its pending
 * verification code, so neither may reach an anonymous browser. A visitor's socket is closed
 * on a reset anyway, because the reset ends its session.
 */
export function isVisitorEvent(event: WsEvent, waId: string): boolean {
	switch (event.type) {
		case "message.created":
		case "message.status_changed": {
			return event.payload.message.contactWaId === waId;
		}

		case "typing.changed": {
			return event.payload.typing.contactWaId === waId;
		}

		case "contact.changed": {
			return event.payload.contact.waId === waId && event.payload.previousWaId === undefined;
		}

		default: {
			return false;
		}
	}
}

/**
 * What a visitor may see of a message: everything the phone renders, without the app's own
 * `biz_opaque_callback_data`, which is the app's bookkeeping and never shown on a real phone.
 */
export function toVisitorMessage(message: Message): Message {
	const { bizOpaqueCallbackData: _omitted, ...visible } = message;

	return visible;
}

export function toVisitorEvent(event: WsEvent): WsEvent {
	if (event.type === "message.created" || event.type === "message.status_changed") {
		return { ...event, payload: { ...event.payload, message: toVisitorMessage(event.payload.message) } } as WsEvent;
	}

	return event;
}

/**
 * Anonymous visitor sessions (SPEC §5, "Public demo mode").
 *
 * A session is a random cookie secret (stored hashed) that owns a few fresh identities drawn from
 * a reserved number range, and the media it uploaded. Everything a phone does is checked
 * against that ownership on the server; nothing in a request can name another visitor's data.
 *
 * Work for one session runs one at a time ({@link withSession}): a send and the cleanup that
 * ends the session cannot interleave, so cleanup never races a write into rows it is deleting,
 * and a write that arrives after the cleanup finds no session at all.
 */
export class VisitorSessionService {
	readonly #config: VisitorConfig;
	readonly #repositories: Repositories;
	readonly #mediaStorage: MediaStorage;
	readonly #logger: Logger;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #endListeners = new Set<(sessionId: string | null) => void>();
	readonly #messagesBySession: RateLimiter;
	readonly #messagesByIp: RateLimiter;
	readonly #createsByIp: RateLimiter;
	#sweepTimer: { cancel: () => void } | null = null;

	constructor(options: VisitorSessionServiceOptions) {
		this.#config = options.config;
		this.#repositories = options.repositories;
		this.#mediaStorage = options.mediaStorage;
		this.#logger = options.logger;
		this.#scheduler = options.scheduler;
		this.#random = options.random ?? defaultRandomBytes;

		const now = (): Date => this.#scheduler.now();

		this.#messagesBySession = new RateLimiter({
			limit: options.config.messagesPerMinutePerSession,
			windowMs: 60_000,
			now,
		});
		this.#messagesByIp = new RateLimiter({ limit: options.config.messagesPerMinutePerIp, windowMs: 60_000, now });
		this.#createsByIp = new RateLimiter({
			limit: options.config.sessionCreatesPerMinutePerIp,
			windowMs: 60_000,
			now,
		});

		// A reset or an import replaces the world the sessions lived in: every visitor starts over.
		options.events.subscribe(event => {
			if (event.type === "state.reset" || event.type === "state.imported") {
				void this.endAll(event.type);
			}
		});
	}

	#drawWaId(): string {
		const digits = VISITOR_WA_ID_LENGTH - this.#config.waIdPrefix.length;
		const bytes = this.#random(digits);
		let body = "";

		for (const byte of bytes) {
			body += String(byte % 10);
		}

		return `${this.#config.waIdPrefix}${body}`;
	}

	#isExpired(session: PublicSessionRecord, now: Date): boolean {
		return now.getTime() - Date.parse(session.lastSeenAt) >= this.#config.sessionTtlMs;
	}

	#notifyEnd(sessionId: string | null): void {
		for (const listener of this.#endListeners) {
			try {
				listener(sessionId);
			} catch (error) {
				this.#logger.warn({ err: error }, "a visitor session listener threw");
			}
		}
	}

	get config(): VisitorConfig {
		return this.#config;
	}

	/** Runs `work` after every earlier piece of work for the same session has finished. */
	async withSession<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(sessionId) ?? Promise.resolve();
		// `previous` never rejects: it is the settled tail of the queue.
		const current = (async () => {
			await previous;

			return work();
		})();
		const settled = (async () => {
			try {
				await current;
			} catch {
				// The caller of `withSession` sees the error; the queue only needs to move on.
			}
		})();

		this.#locks.set(sessionId, settled);

		try {
			return await current;
		} finally {
			if (this.#locks.get(sessionId) === settled) {
				this.#locks.delete(sessionId);
			}
		}
	}

	/**
	 * Called with a session's ID just before its rows go, so its sockets close first; with `null`
	 * when every session ended at once (a reset or an import).
	 */
	onEnd(listener: (sessionId: string | null) => void): () => void {
		this.#endListeners.add(listener);

		return () => {
			this.#endListeners.delete(listener);
		};
	}

	/** When a session that is not used again ends. */
	expiresAt(session: PublicSessionRecord): string {
		const expiresAt = new Date(Date.parse(session.lastSeenAt) + this.#config.sessionTtlMs);

		return expiresAt.toISOString();
	}

	/**
	 * A new visitor: fresh identities from the template, and the cookie secret that proves it.
	 * Refused with a 429 when this address already holds its share of live sessions, has
	 * created too many in the last minute, or the instance is full.
	 */
	async create(clientIp: string): Promise<CreatedVisitorSession> {
		await this.sweep();

		const creates = this.#createsByIp.check(clientIp);

		if (!creates.allowed) {
			throw limitExceeded(
				"too many new demo sessions from this address; wait a minute",
				"session_rate_limited",
				creates.retryAfterSeconds,
			);
		}

		if ((await this.#repositories.publicSessions.countByIp(clientIp)) >= this.#config.sessionsPerIp) {
			throw limitExceeded(
				`this address already has ${String(this.#config.sessionsPerIp)} demo sessions; close one or wait for it to expire`,
				"session_quota_exceeded",
				Math.ceil(this.#config.sessionTtlMs / 1000),
			);
		}

		if ((await this.#repositories.publicSessions.count()) >= this.#config.maxSessions) {
			throw limitExceeded("the demo is full right now; try again in a few minutes", "demo_full", 60);
		}

		this.#createsByIp.take(clientIp);

		const token = base64Url(this.#random(32));
		const id = hashToken(token);
		const csrfToken = base64Url(this.#random(24));
		const now = this.#scheduler.now().toISOString();

		for (let attempt = 1; ; attempt += 1) {
			const identities = this.#config.identities.map(template => {
				return {
					waId: this.#drawWaId(),
					profileName: template.name,
					role: template.role,
				};
			});

			try {
				const created = await this.#repositories.publicSessions.create({
					id,
					csrfToken,
					clientIp,
					now,
					identities,
				});
				const session = await this.#repositories.publicSessions.findById(id);

				this.#logger.info({ identities: created.map(contact => contact.waId) }, "visitor session created");

				return { token, session: session!, identities: created };
			} catch (error) {
				if (!(error instanceof WaIdTakenError) || attempt >= MAX_WA_ID_DRAWS) {
					throw error;
				}
			}
		}
	}

	/**
	 * The session a cookie secret proves, if it is still alive. An idle one past its TTL is
	 * ended right here rather than waiting for the cleanup job, so the first request after the
	 * TTL already sees it gone.
	 */
	async authenticate(token: string | undefined): Promise<VisitorAuthResult> {
		if (token === undefined || token === "") {
			return { status: "none" };
		}

		const session = await this.#repositories.publicSessions.findById(hashToken(token));

		if (session === null) {
			return { status: "expired" };
		}

		const now = this.#scheduler.now();

		if (this.#isExpired(session, now)) {
			await this.end(session.id, "expired");

			return { status: "expired" };
		}

		if (now.getTime() - Date.parse(session.lastSeenAt) >= TOUCH_INTERVAL_MS) {
			const lastSeenAt = now.toISOString();

			await this.#repositories.publicSessions.touch(session.id, lastSeenAt);

			return { status: "valid", session: { ...session, lastSeenAt } };
		}

		return { status: "valid", session };
	}

	/** Whether `session` is still the one in the database: checked again inside the lock. */
	async isAlive(sessionId: string): Promise<boolean> {
		return (await this.#repositories.publicSessions.findById(sessionId)) !== null;
	}

	async identities(sessionId: string): Promise<ContactRecord[]> {
		return this.#repositories.publicSessions.identities(sessionId);
	}

	async ownsIdentity(sessionId: string, waId: string): Promise<boolean> {
		return (await this.#repositories.publicSessions.ownerOf(waId)) === sessionId;
	}

	/**
	 * One message from a visitor: counted against the session and the address together, and
	 * refused (uncounted) when either is over its limit.
	 */
	takeMessage(sessionId: string, clientIp: string): void {
		const bySession = this.#messagesBySession.check(sessionId);
		const byIp = this.#messagesByIp.check(clientIp);

		if (!bySession.allowed || !byIp.allowed) {
			const retry: RateLimitResult = bySession.allowed ? byIp : bySession;

			throw limitExceeded(
				bySession.allowed
					? `too many messages from this address: at most ${String(this.#config.messagesPerMinutePerIp)} a minute`
					: `too many messages: at most ${String(this.#config.messagesPerMinutePerSession)} a minute`,
				"message_rate_limited",
				retry.retryAfterSeconds,
			);
		}

		this.#messagesBySession.take(sessionId);
		this.#messagesByIp.take(clientIp);
	}

	/** Refuses an upload over the size limit (413) or past the session's count (429). */
	async checkUpload(sessionId: string, size: number): Promise<void> {
		if (size > this.#config.mediaMaxBytes) {
			throw new ControlPlaneError(
				`the file is larger than the demo's ${String(this.#config.mediaMaxBytes)}-byte limit`,
				{
					status: 413,
					code: "media_too_large",
				},
			);
		}

		if ((await this.#repositories.publicSessions.countMedia(sessionId)) >= this.#config.mediaPerSession) {
			throw limitExceeded(
				`this demo session already uploaded ${String(this.#config.mediaPerSession)} files`,
				"media_quota_exceeded",
			);
		}
	}

	async recordUpload(sessionId: string, mediaId: string): Promise<void> {
		await this.#repositories.publicSessions.addMedia(sessionId, mediaId);
	}

	async ownsUpload(sessionId: string, mediaId: string): Promise<boolean> {
		return this.#repositories.publicSessions.ownsMedia(sessionId, mediaId);
	}

	/**
	 * Whether a visitor may see a media object: one it uploaded, or one a message in one of its
	 * own conversations names (what the app under test sent it).
	 */
	async canSeeMedia(sessionId: string, mediaId: string): Promise<boolean> {
		if (await this.ownsUpload(sessionId, mediaId)) {
			return true;
		}

		const identities = await this.identities(sessionId);

		for (const identity of identities) {
			const messages = await this.#repositories.messages.listMentioningMedia(identity.waId, mediaId);

			if (messages.some(message => mediaIdsOf(message).includes(mediaId))) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Ends a session and removes everything it owned (SPEC §5): its sockets close first, then
	 * its rows go in one transaction, then the stored bytes of its uploads. Runs inside the
	 * session's lock, so a request in flight for it finishes before, and one arriving after
	 * finds no session.
	 */
	async end(sessionId: string, reason: string): Promise<void> {
		await this.withSession(sessionId, async () => {
			this.#notifyEnd(sessionId);

			const deleted = await this.#repositories.publicSessions.delete(sessionId);

			this.#messagesBySession.forget(sessionId);
			await deleteStoredMedia({
				storageKeys: deleted.mediaStorageKeys,
				mediaStorage: this.#mediaStorage,
				logger: this.#logger,
			});

			if (deleted.waIds.length > 0 || deleted.mediaStorageKeys.length > 0) {
				this.#logger.info(
					{ reason, identities: deleted.waIds, media: deleted.mediaStorageKeys.length },
					"visitor session ended",
				);
			}
		});
	}

	/**
	 * The cleanup job (SPEC §5): ends every session idle for the TTL, then removes contacts on a
	 * visitor number that no session owns any more — what a late reply from the app under test
	 * creates after its visitor left. Nothing else is touched.
	 */
	async sweep(): Promise<void> {
		const cutoffAt = new Date(this.#scheduler.now().getTime() - this.#config.sessionTtlMs);
		const cutoff = cutoffAt.toISOString();

		const idle = await this.#repositories.publicSessions.listIdleSince(cutoff);

		for (const sessionId of idle) {
			await this.end(sessionId, "expired");
		}

		const orphans = await this.#repositories.publicSessions.listOrphanedVisitorContacts();

		if (orphans.length > 0) {
			await this.#repositories.publicSessions.deleteContacts(orphans);
			this.#logger.info({ identities: orphans }, "removed visitor identities no session owns");
		}
	}

	/**
	 * Every session ends: a reset or an import replaced the world they lived in. A reset has
	 * already deleted the rows, so the sockets are closed from what is in memory, not the table.
	 */
	async endAll(reason: string): Promise<void> {
		this.#notifyEnd(null);

		const live = await this.#repositories.publicSessions.listIds();

		for (const sessionId of live) {
			await this.end(sessionId, reason);
		}

		this.#messagesBySession.clear();
	}

	/** Starts the cleanup job; its timer never keeps the process alive. */
	start(): void {
		const interval = Math.max(1000, Math.min(MAX_SWEEP_INTERVAL_MS, Math.floor(this.#config.sessionTtlMs / 4)));
		const tick = (): void => {
			this.#sweepTimer = this.#scheduler.schedule(interval, () => {
				void this.sweep()
					.catch((error: unknown) => {
						this.#logger.error({ err: error }, "visitor session cleanup failed");
					})
					.finally(() => {
						if (this.#sweepTimer !== null) {
							tick();
						}
					});
			});
		};

		tick();
	}

	stop(): void {
		const timer = this.#sweepTimer;

		this.#sweepTimer = null;
		timer?.cancel();
	}
}
