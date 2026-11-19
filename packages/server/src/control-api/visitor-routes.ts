import { upgradeWebSocket } from "@hono/node-server";
import {
	clockResponseSchema,
	conversationMessagesResponseSchema,
	inboundMediaResponseSchema,
	inboundRequestSchema,
	inboundResponseSchema,
	listMessagesQuerySchema,
	mediaResponseSchema,
	phoneChatListResponseSchema,
	phoneIdentityListResponseSchema,
	phoneReadResponseSchema,
	visitorSessionResponseSchema,
	type InboundRequest,
	type VisitorSession,
} from "@mockwa/shared";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { WSContext } from "hono/ws";
import type { AccessConfig } from "../config/index.ts";
import type { ContactRecord, PublicSessionRecord } from "../db/index.ts";
import {
	ControlPlaneError,
	MEDIA_DOWNLOAD_PATH,
	isVisitorEvent,
	toContactDto,
	toMessageDto,
	toVisitorEvent,
	toVisitorMessage,
	type ClockService,
	type EventBus,
	type InboundService,
	type MediaService,
	type PhoneService,
	type VisitorSessionService,
} from "../domain/index.ts";
import type { Logger } from "../logging/index.ts";
import {
	clearVisitorCookie,
	clientIpOf,
	CSRF_HEADER,
	isAllowedOrigin,
	isUnsafeMethod,
	isSafeEqual,
	setVisitorCookie,
	visitorTokenOf,
} from "./access.ts";
import { parseOrThrow, readJsonBody, type ControlEnv } from "./control-env.ts";
import { readUploadForm } from "./upload-form.ts";

/**
 * What a visitor's phone may send (SPEC §5, "Public demo mode"): what a customer types or taps.
 * Contact cards, stickers, audio, video and "unsupported" stay developer tools.
 */
export const VISITOR_MESSAGE_TYPES: ReadonlySet<InboundRequest["type"]> = new Set([
	"text",
	"image",
	"document",
	"interactive",
	"button",
	"location",
	"reaction",
]);

/** The fields a developer may set on a simulated message but a visitor may not: ignored. */
const DEVELOPER_ONLY_FIELDS: ReadonlySet<string> = new Set([
	"timestamp",
	"profileName",
	"referral",
	"referredProduct",
	"forwarded",
	"frequentlyForwarded",
]);

/** Meta caps a text body at 4,096 characters; a visitor's is held to the same. */
const MAX_TEXT_LENGTH = 4096;

/** Live sockets one session may hold at once; more than a few tabs is not a person. */
export const MAX_SOCKETS_PER_SESSION = 8;

/** The upload types a visitor may send, each recognized by its first bytes, not by its claim. */
export const VISITOR_MEDIA_TYPES: Readonly<Record<string, (bytes: Uint8Array) => boolean>> = {
	"image/jpeg": bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
	"image/png": bytes => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte),
	"image/webp": bytes => {
		return (
			Buffer.from(bytes.subarray(0, 4)).toString("latin1") === "RIFF" &&
			Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WEBP"
		);
	},
	"application/pdf": bytes => Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-",
};

/** Room for the multipart envelope around the file itself. */
const MULTIPART_OVERHEAD_BYTES = 16 * 1024;

export interface VisitorRoutesOptions {
	access: AccessConfig;
	sessions: VisitorSessionService;
	phone: PhoneService;
	inbound: InboundService;
	media: MediaService;
	clock: ClockService;
	events: EventBus;
	logger: Logger;
}

function sessionView(
	sessions: VisitorSessionService,
	session: PublicSessionRecord,
	identities: ContactRecord[],
): VisitorSession {
	const { config } = sessions;

	return {
		identities: identities.map(contact => toContactDto(contact)),
		csrfToken: session.csrfToken,
		expiresAt: sessions.expiresAt(session),
		limits: {
			sessionTtlSeconds: Math.floor(config.sessionTtlMs / 1000),
			messagesPerMinute: config.messagesPerMinutePerSession,
			mediaMaxBytes: config.mediaMaxBytes,
			mediaPerSession: config.mediaPerSession,
			mediaTypes: Object.keys(VISITOR_MEDIA_TYPES),
		},
	};
}

function sessionRefused(status: "none" | "expired"): ControlPlaneError {
	return status === "none"
		? new ControlPlaneError("start a demo session first", { status: 401, code: "session_required" })
		: new ControlPlaneError("this demo session has ended; start a new one", { status: 401, code: "session_expired" });
}

/**
 * `GET`, `POST` and `DELETE /api/public/session` (SPEC §5, "Public demo mode"): a visitor's
 * session and its identities. `POST` is idempotent for a browser that already holds a live
 * session — it gets the same identities back, never a second set.
 */
export function createVisitorSessionRoutes(options: VisitorRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const { sessions, access } = options;

	routes.get("/public/session", async c => {
		const auth = await sessions.authenticate(visitorTokenOf(c));

		if (auth.status !== "valid") {
			if (auth.status === "expired") {
				clearVisitorCookie(c, access);
			}

			throw sessionRefused(auth.status);
		}

		const identities = await sessions.identities(auth.session.id);

		return c.json(visitorSessionResponseSchema.parse({ data: sessionView(sessions, auth.session, identities) }));
	});

	routes.post("/public/session", async c => {
		if (!isAllowedOrigin(c, access)) {
			throw new ControlPlaneError("cross-origin request refused", { status: 403, code: "origin_refused" });
		}

		const existing = await sessions.authenticate(visitorTokenOf(c));

		if (existing.status === "valid") {
			const identities = await sessions.identities(existing.session.id);

			return c.json(visitorSessionResponseSchema.parse({ data: sessionView(sessions, existing.session, identities) }));
		}

		const created = await sessions.create(clientIpOf(c, access));

		setVisitorCookie(c, access, created.token);

		return c.json(
			visitorSessionResponseSchema.parse({ data: sessionView(sessions, created.session, created.identities) }),
			201,
		);
	});

	// Leaving the demo: the same cleanup the TTL would do, now.
	routes.delete("/public/session", async c => {
		const auth = await sessions.authenticate(visitorTokenOf(c));

		if (auth.status === "valid") {
			assertCsrf(c, access, auth.session);
			await sessions.end(auth.session.id, "left");
		}

		clearVisitorCookie(c, access);

		return c.body(null, 204);
	});

	return routes;
}

/** The CSRF check on a cookie-authenticated write: the session's token, from this origin. */
function assertCsrf(c: Context<ControlEnv>, access: AccessConfig, session: PublicSessionRecord): void {
	const sent = c.req.header(CSRF_HEADER);

	if (sent === undefined || !isAllowedOrigin(c, access) || !isSafeEqual(sent, session.csrfToken)) {
		throw new ControlPlaneError("missing or wrong CSRF token", { status: 403, code: "csrf_failed" });
	}
}

/** The relative URL a visitor's browser loads media from: the console's own origin, never the Graph host. */
function visitorMediaUrl(descriptorUrl: string): string {
	const url = new URL(descriptorUrl);

	return `${url.pathname}${url.search}`;
}

/**
 * The visitor's phone API (SPEC §5, "Public demo mode"): the same paths as the developer phone,
 * but every one is scoped to the session in the cookie. A path naming an identity the session
 * does not own answers the same 404 as one that does not exist; a write needs the session's
 * CSRF token and this origin; and each request runs inside the session's lock, so a request and
 * the cleanup that ends the session never interleave.
 */
export function createVisitorPhoneRoutes(options: VisitorRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const { sessions, access, phone } = options;
	const chat = "/phone/identities/:waId/chats/:phoneNumberId";
	const sockets = new Map<string, Set<WSContext>>();

	sessions.onEnd(sessionId => {
		const open =
			sessionId === null
				? sockets
						.values()
						.flatMap(set => set.values())
						.toArray()
				: (sockets.get(sessionId)?.values().toArray() ?? []);

		if (sessionId === null) {
			sockets.clear();
		} else {
			sockets.delete(sessionId);
		}

		for (const ws of open) {
			try {
				ws.close(4401, "session ended");
			} catch {
				// Already closing.
			}
		}
	});

	const authenticate: MiddlewareHandler<ControlEnv> = async (c, next) => {
		const auth = await sessions.authenticate(visitorTokenOf(c));

		if (auth.status !== "valid") {
			if (auth.status === "expired") {
				clearVisitorCookie(c, access);
			}

			throw sessionRefused(auth.status);
		}

		if (isUnsafeMethod(c.req.method)) {
			assertCsrf(c, access, auth.session);
		}

		c.set("visitor", { sessionId: auth.session.id, clientIp: clientIpOf(c, access) });
		await next();
	};

	function visitorOf(c: Context<ControlEnv>): { sessionId: string; clientIp: string } {
		const visitor = c.get("visitor");

		if (visitor === undefined) {
			throw sessionRefused("none");
		}

		return visitor;
	}

	/**
	 * Runs `work` inside the session's lock, after checking the session is still alive there —
	 * a request queued behind the cleanup that ended it finds it gone and does nothing.
	 */
	async function asVisitor<T>(
		c: Context<ControlEnv>,
		waId: string | undefined,
		work: (visitor: { sessionId: string; clientIp: string }) => Promise<T>,
	): Promise<T> {
		const visitor = visitorOf(c);

		return sessions.withSession(visitor.sessionId, async () => {
			if (!(await sessions.isAlive(visitor.sessionId))) {
				throw sessionRefused("expired");
			}

			if (waId !== undefined && !(await sessions.ownsIdentity(visitor.sessionId, waId))) {
				throw new ControlPlaneError(`no contact with wa_id ${waId}`, { status: 404, code: "unknown_contact" });
			}

			return work(visitor);
		});
	}

	routes.use("/phone/*", authenticate);

	routes.get("/phone/identities", async c => {
		const identities = await asVisitor(c, undefined, visitor => sessions.identities(visitor.sessionId));

		return c.json(phoneIdentityListResponseSchema.parse({ data: identities.map(contact => toContactDto(contact)) }));
	});

	routes.get("/phone/clock", c => c.json(clockResponseSchema.parse({ data: options.clock.view() })));

	routes.get("/phone/identities/:waId/chats", async c => {
		const waId = c.req.param("waId");
		const chats = await asVisitor(c, waId, async () => phone.chats(waId));

		return c.json(
			phoneChatListResponseSchema.parse({
				data: chats.map(entry => {
					return {
						...entry,
						lastMessage: entry.lastMessage === null ? null : toVisitorMessage(entry.lastMessage),
					};
				}),
			}),
		);
	});

	routes.get(`${chat}/messages`, async c => {
		const waId = c.req.param("waId");
		const query = parseOrThrow(listMessagesQuerySchema, c.req.query());
		const page = await asVisitor(c, waId, async () => {
			return phone.messages({
				waId,
				phoneNumberId: c.req.param("phoneNumberId"),
				limit: query.limit,
				...(query.before !== undefined && { before: query.before }),
			});
		});

		return c.json(
			conversationMessagesResponseSchema.parse({
				data: page.messages.map(message => toVisitorMessage(toMessageDto(message))),
				paging: { before: page.before },
			}),
		);
	});

	routes.post(`${chat}/messages`, async c => {
		const waId = c.req.param("waId");
		const phoneNumberId = c.req.param("phoneNumberId");
		const body = await readJsonBody(c);

		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			throw new ControlPlaneError("expected a JSON object", { status: 400, code: "invalid_request" });
		}

		const fields = Object.fromEntries(
			Object.entries(body as Record<string, unknown>).filter(([field]) => !DEVELOPER_ONLY_FIELDS.has(field)),
		);

		const request = parseOrThrow(inboundRequestSchema, { ...fields, phoneNumberId, from: waId });

		if (!VISITOR_MESSAGE_TYPES.has(request.type)) {
			throw new ControlPlaneError(`a demo phone cannot send ${request.type} messages`, {
				status: 400,
				code: "unsupported_type",
			});
		}

		if (request.type === "text" && request.text.body.length > MAX_TEXT_LENGTH) {
			throw new ControlPlaneError(`text is longer than ${String(MAX_TEXT_LENGTH)} characters`, {
				status: 400,
				code: "invalid_request",
			});
		}

		const message = await asVisitor(c, waId, async visitor => {
			// Everything the message points at has to be this visitor's to point at.
			if (request.replyTo !== undefined) {
				await phone.conversationMessage(waId, phoneNumberId, request.replyTo);
			}

			if (request.type === "reaction") {
				await phone.conversationMessage(waId, phoneNumberId, request.reaction.message_id);
			}

			if (
				(request.type === "image" || request.type === "document") &&
				!(await sessions.ownsUpload(visitor.sessionId, request.media.id))
			) {
				throw new ControlPlaneError(`no media object with ID ${request.media.id}`, {
					status: 404,
					code: "unknown_media",
				});
			}

			sessions.takeMessage(visitor.sessionId, visitor.clientIp);

			return options.inbound.simulate(request);
		});

		const created = toVisitorMessage(toMessageDto(message));

		return c.json(inboundResponseSchema.parse({ data: created }), 201);
	});

	routes.post(`${chat}/read`, async c => {
		const waId = c.req.param("waId");
		const read = await asVisitor(c, waId, async () => phone.markChatRead(waId, c.req.param("phoneNumberId")));

		return c.json(phoneReadResponseSchema.parse({ data: { read } }));
	});

	routes.post(
		`${chat}/media`,
		bodyLimit({
			maxSize: sessions.config.mediaMaxBytes + MULTIPART_OVERHEAD_BYTES,
			onError: () => {
				throw new ControlPlaneError(
					`the file is larger than the demo's ${String(sessions.config.mediaMaxBytes)}-byte limit`,
					{ status: 413, code: "media_too_large" },
				);
			},
		}),
		async c => {
			const waId = c.req.param("waId");
			const phoneNumberId = c.req.param("phoneNumberId");
			const upload = await readUploadForm(c);
			const isType = VISITOR_MEDIA_TYPES[upload.mimeType];

			if (isType === undefined || !isType(upload.bytes)) {
				throw new ControlPlaneError(
					`a demo phone can send ${Object.keys(VISITOR_MEDIA_TYPES).join(", ")} files, and the file must be one`,
					{ status: 415, code: "unsupported_media_type" },
				);
			}

			const media = await asVisitor(c, waId, async visitor => {
				await sessions.checkUpload(visitor.sessionId, upload.bytes.byteLength);

				const stored = await options.media.upload({ phoneNumberId, bytes: upload.bytes, mimeType: upload.mimeType });

				await sessions.recordUpload(visitor.sessionId, stored.id);

				return stored;
			});

			return c.json(
				inboundMediaResponseSchema.parse({
					data: {
						id: media.id,
						phoneNumberId: media.phoneNumberId,
						mimeType: media.mimeType,
						sha256: media.sha256,
						fileSize: media.fileSize,
						createdAt: media.createdAt,
					},
				}),
				201,
			);
		},
	);

	routes.get("/phone/identities/:waId/media/:mediaId", async c => {
		const waId = c.req.param("waId");
		const mediaId = c.req.param("mediaId");
		const media = await asVisitor(c, waId, async visitor => {
			const found = (await sessions.canSeeMedia(visitor.sessionId, mediaId)) ? await options.media.find(mediaId) : null;

			if (found === null) {
				throw new ControlPlaneError(`no media object with ID ${mediaId}`, { status: 404, code: "unknown_media" });
			}

			return found;
		});
		const descriptor = options.media.descriptor(media);

		return c.json(mediaResponseSchema.parse({ data: { ...descriptor, url: visitorMediaUrl(descriptor.url) } }));
	});

	routes.get(
		"/phone/identities/:waId/ws",
		async (c, next) => {
			if (!isAllowedOrigin(c, access)) {
				throw new ControlPlaneError("cross-origin socket refused", { status: 403, code: "origin_refused" });
			}

			const visitor = visitorOf(c);

			await asVisitor(c, c.req.param("waId"), async () => {
				await Promise.resolve();

				if ((sockets.get(visitor.sessionId)?.size ?? 0) >= MAX_SOCKETS_PER_SESSION) {
					throw new ControlPlaneError(`at most ${String(MAX_SOCKETS_PER_SESSION)} live connections per demo session`, {
						status: 429,
						code: "socket_quota_exceeded",
						retryAfterSeconds: 5,
					});
				}
			});
			await next();
		},
		upgradeWebSocket((c: Context<ControlEnv>) => {
			const waId = c.req.param("waId") ?? "";
			const { sessionId } = visitorOf(c);
			let unsubscribe: (() => void) | null = null;
			let socket: WSContext | null = null;

			const stop = (): void => {
				unsubscribe?.();
				unsubscribe = null;

				if (socket !== null) {
					sockets.get(sessionId)?.delete(socket);
				}
			};

			return {
				onOpen: (_event, ws) => {
					socket = ws;
					sockets.set(sessionId, (sockets.get(sessionId) ?? new Set()).add(ws));
					unsubscribe = options.events.subscribe(event => {
						if (!isVisitorEvent(event, waId)) {
							return;
						}

						try {
							ws.send(JSON.stringify(toVisitorEvent(event)));
						} catch (error) {
							options.logger.debug({ err: error }, "dropping a visitor socket that could not be written to");
							stop();
						}
					});
				},
				onClose: stop,
				onError: error => {
					options.logger.debug({ err: error }, "visitor websocket errored");
					stop();
				},
			};
		}),
	);

	return routes;
}

/** The media path a visitor may load bytes from, checked against its session (SPEC §5). */
export function createVisitorMediaGuard(options: {
	sessions: VisitorSessionService;
	media: MediaService;
}): MiddlewareHandler<ControlEnv> {
	return async (c, next) => {
		// The admin sees every byte, as in dev mode.
		if (c.get("adminAuth") !== null && c.get("adminAuth") !== undefined) {
			await next();

			return;
		}

		const auth = await options.sessions.authenticate(visitorTokenOf(c));
		const token = c.req.path.slice(MEDIA_DOWNLOAD_PATH.length + 1);
		const media = auth.status === "valid" ? await options.media.findByUrlToken(token) : null;

		if (media === null || auth.status !== "valid" || !(await options.sessions.canSeeMedia(auth.session.id, media.id))) {
			return c.text("Not Found", 404);
		}

		c.header("X-Content-Type-Options", "nosniff");
		c.header("Cache-Control", "private, no-store");
		// Bytes the app under test sent may be any type; on the visitor's origin they never run.
		c.header("Content-Security-Policy", "default-src 'none'; sandbox");
		await next();

		return;
	};
}
