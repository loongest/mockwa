import {
	conversationMessagesResponseSchema,
	inboundRequestSchema,
	inboundResponseSchema,
	listMessagesQuerySchema,
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
	type EventBus,
	type InboundService,
	type PhoneService,
} from "../domain/index.ts";
import type { Logger } from "../logging/index.ts";
import { parseOrThrow, readJsonBody, type ControlEnv } from "./control-env.ts";
import { eventSocket } from "./ws-routes.ts";

export interface PhoneRoutesOptions {
	phone: PhoneService;
	inbound: InboundService;
	events: EventBus;
	logger: Logger;
}

/**
 * The virtual phone's API, under `/api/phone` (SPEC §5). Every route is scoped to one identity
 * by its path, so a phone can only send as itself and only hears its own conversations — the
 * console's `/api/inbound` and `/api/ws` stay the developer's unrestricted tools.
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
