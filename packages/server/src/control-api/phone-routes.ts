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
} from "@mockwa/shared";
import { Hono } from "hono";
import {
	ControlPlaneError,
	isPhoneEvent,
	toContactDto,
	toMessageDto,
	type ClockService,
	type EventBus,
	type InboundService,
	type MediaService,
	type PhoneService,
} from "../domain/index.ts";
import type { Logger } from "../logging/index.ts";
import { parseOrThrow, readJsonBody, type ControlEnv } from "./control-env.ts";
import { readUploadForm } from "./upload-form.ts";
import { eventSocket } from "./ws-routes.ts";

export interface PhoneRoutesOptions {
	phone: PhoneService;
	inbound: InboundService;
	events: EventBus;
	media: MediaService;
	clock: ClockService;
	logger: Logger;
}

/**
 * The virtual phone's API in developer mode, under `/api/phone` (SPEC §5). Every route is scoped
 * to one identity by its path, so a phone can only send as itself and only hears its own
 * conversations — the console's `/api/inbound` and `/api/ws` stay the developer's unrestricted
 * tools. Public mode mounts `visitor-routes.ts` in its place, where the identity also has to be
 * the session's.
 */
export function createPhoneRoutes(options: PhoneRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const chat = "/phone/identities/:waId/chats/:phoneNumberId";

	routes.get("/phone/identities", async c => {
		const identities = await options.phone.identities();

		return c.json(phoneIdentityListResponseSchema.parse({ data: identities.map(contact => toContactDto(contact)) }));
	});

	routes.get("/phone/identities/:waId/chats", async c => {
		const chats = await options.phone.chats(c.req.param("waId"));

		return c.json(phoneChatListResponseSchema.parse({ data: chats }));
	});

	routes.get(`${chat}/messages`, async c => {
		const query = parseOrThrow(listMessagesQuerySchema, c.req.query());
		const page = await options.phone.messages({
			waId: c.req.param("waId"),
			phoneNumberId: c.req.param("phoneNumberId"),
			limit: query.limit,
			...(query.before !== undefined && { before: query.before }),
		});

		return c.json(
			conversationMessagesResponseSchema.parse({
				data: page.messages.map(message => toMessageDto(message)),
				paging: { before: page.before },
			}),
		);
	});

	// The body is `POST /api/inbound`'s without its endpoints: the path names them, and a value
	// in the body cannot override them, so a phone cannot speak for somebody else.
	routes.post(`${chat}/messages`, async c => {
		const waId = c.req.param("waId");
		const body = await readJsonBody(c);

		if (body === null || typeof body !== "object" || Array.isArray(body)) {
			throw new ControlPlaneError("expected a JSON object", { status: 400, code: "invalid_request" });
		}

		await options.phone.identity(waId);

		const request = parseOrThrow(inboundRequestSchema, {
			...body,
			phoneNumberId: c.req.param("phoneNumberId"),
			from: waId,
		});
		const message = await options.inbound.simulate(request);

		return c.json(inboundResponseSchema.parse({ data: toMessageDto(message) }), 201);
	});

	// The phone's own upload, so an attachment goes out as this identity without the console's API.
	routes.post(`${chat}/media`, async c => {
		await options.phone.identity(c.req.param("waId"));

		const upload = await readUploadForm(c);
		const media = await options.media.upload({
			phoneNumberId: c.req.param("phoneNumberId"),
			bytes: upload.bytes,
			mimeType: upload.mimeType,
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
	});

	routes.get("/phone/identities/:waId/media/:mediaId", async c => {
		await options.phone.identity(c.req.param("waId"));

		const mediaId = c.req.param("mediaId");
		const media = await options.media.find(mediaId);

		if (media === null) {
			throw new ControlPlaneError(`no media object with ID ${mediaId}`, { status: 404, code: "unknown_media" });
		}

		return c.json(mediaResponseSchema.parse({ data: options.media.descriptor(media) }));
	});

	routes.get("/phone/clock", c => c.json(clockResponseSchema.parse({ data: options.clock.view() })));

	routes.post(`${chat}/read`, async c => {
		const read = await options.phone.markChatRead(c.req.param("waId"), c.req.param("phoneNumberId"));

		return c.json(phoneReadResponseSchema.parse({ data: { read } }));
	});

	// An unknown identity is refused before the upgrade, with the usual 404.
	routes.get(
		"/phone/identities/:waId/ws",
		async (c, next) => {
			await options.phone.identity(c.req.param("waId"));
			await next();
		},
		async (c, next) => {
			const waId = c.req.param("waId");

			return eventSocket(options, event => isPhoneEvent(event, waId))(c, next);
		},
	);

	return routes;
}
