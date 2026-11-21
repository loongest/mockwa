import {
	messagingRulesResponseSchema,
	serviceWindowExpireRequestSchema,
	serviceWindowQuerySchema,
	serviceWindowResponseSchema,
} from "@wasandbox/shared";
import { Hono } from "hono";
import { toServiceWindowDto, type MessagingRules } from "../domain/index.ts";
import { parseOrThrow, readBody, type ControlEnv } from "./control-env.ts";

export interface MessagingRulesRoutesOptions {
	messagingRules: MessagingRules;
}

/**
 * `GET /api/service-window`, `POST /api/service-window/expire` and `GET /api/messaging-rules`
 * (SPEC §5) — the messaging rules of SPEC §4. They are configured by environment variables, and
 * the window is opened by the contact writing, exactly as on WhatsApp. The one thing the console
 * may do is close a window early, for one number and one contact.
 */
export function createMessagingRulesRoutes(options: MessagingRulesRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();

	routes.get("/service-window", async c => {
		const query = parseOrThrow(serviceWindowQuerySchema, c.req.query());
		const state = await options.messagingRules.serviceWindow(query.phoneNumberId, query.waId);

		return c.json(
			serviceWindowResponseSchema.parse({ data: toServiceWindowDto(query.phoneNumberId, query.waId, state) }),
		);
	});

	routes.post("/service-window/expire", async c => {
		const body = await readBody(c, serviceWindowExpireRequestSchema);
		const state = await options.messagingRules.expireServiceWindow(body.phoneNumberId, body.waId);

		return c.json(
			serviceWindowResponseSchema.parse({ data: toServiceWindowDto(body.phoneNumberId, body.waId, state) }),
		);
	});

	routes.get("/messaging-rules", async c => {
		const { config } = options.messagingRules;

		return c.json(
			messagingRulesResponseSchema.parse({
				data: { ...config, usage: await options.messagingRules.messagingLimitUsage() },
			}),
		);
	});

	return routes;
}
