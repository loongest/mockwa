import {
	messagingRulesResponseSchema,
	serviceWindowQuerySchema,
	serviceWindowResponseSchema,
	type ServiceWindow,
} from "@mockwa/shared";
import { Hono } from "hono";
import type { MessagingRules, ServiceWindowState } from "../domain/index.ts";
import { parseOrThrow, type ControlEnv } from "./control-env.ts";

export interface MessagingRulesRoutesOptions {
	messagingRules: MessagingRules;
}

function toServiceWindowDto(phoneNumberId: string, waId: string, state: ServiceWindowState): ServiceWindow {
	return {
		phoneNumberId,
		waId,
		isEnforced: state.isEnforced,
		isOpen: state.isOpen,
		lastInboundAt: state.lastInboundAt?.toISOString() ?? null,
		expiresAt: state.expiresAt?.toISOString() ?? null,
		windowMs: state.windowMs,
	};
}

/**
 * `GET /api/service-window` and `GET /api/messaging-rules` (SPEC §5) — the messaging rules of
 * SPEC §4, read-only. They are configured by environment variables, and the window is opened by
 * the contact writing, exactly as on WhatsApp: there is nothing here to set.
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
