import { phoneConfigResponseSchema } from "@wasandbox/shared";
import { Hono } from "hono";
import type { DomainServices } from "../composition.ts";
import type { AccessConfig } from "../config/index.ts";
import type { Logger } from "../logging/index.ts";
import { createAppRoutes } from "./app-routes.ts";
import { createClockRoutes } from "./clock-routes.ts";
import { createScenarioRoutes } from "./scenario-routes.ts";
import { createContactRoutes } from "./contact-routes.ts";
import { createControlErrorHandler, type ControlEnv } from "./control-env.ts";
import { createConversationRoutes } from "./conversation-routes.ts";
import { createHealthRoutes } from "./health-routes.ts";
import { createInboundRoutes } from "./inbound-routes.ts";
import { createInjectionRoutes } from "./injection-routes.ts";
import { createMediaRoutes } from "./media-routes.ts";
import { createMessageRoutes } from "./message-routes.ts";
import { createPhoneNumberRoutes } from "./phone-number-routes.ts";
import { createPhoneRoutes } from "./phone-routes.ts";
import { createSnapshotRoutes } from "./snapshot-routes.ts";
import { createStateRoutes } from "./state-routes.ts";
import { createTemplateRoutes } from "./template-routes.ts";
import { createTokenRoutes } from "./token-routes.ts";
import { createGraphRequestRoutes } from "./graph-request-routes.ts";
import { createMessagingRulesRoutes } from "./messaging-rules-routes.ts";
import { createTypingRoutes } from "./typing-routes.ts";
import { createWabaRoutes } from "./waba-routes.ts";
import { createWebhookRoutes } from "./webhook-routes.ts";
import { createWsRoutes } from "./ws-routes.ts";
import type { AdminStateSize } from "./access.ts";
import { createVisitorPhoneRoutes, createVisitorSessionRoutes } from "./visitor-routes.ts";

export interface ControlRoutesOptions {
	services: DomainServices;
	logger: Logger;
	/** `dev` (the default) or `public` (SPEC §7, "Access modes"); decides which phone API is mounted. */
	access?: AccessConfig;
	/** The admin side's in-memory state, reported by `GET /api/public/stats`. */
	adminState?: () => AdminStateSize;
}

/**
 * The whole control plane, as one router mounted at `/api` (SPEC §5).
 *
 * In dev mode there is no authentication: WaSandbox is a local dev tool whose UI runs in a browser
 * with no credential to give it. The admin token and public mode guard this router from in front
 * (`access.ts`, mounted by `app.ts`), so nothing in here checks who is calling — except the
 * visitor phone API, which is scoped to the session in its cookie (SPEC §5, §7).
 *
 * The error handler is registered here so the plain `{error:{message,code?}}` shape stays a
 * property of *this* surface, while the Graph routes keep answering with Meta's envelope
 * (SPEC §8).
 */
export function createControlRoutes(options: ControlRoutesOptions): Hono<ControlEnv> {
	const { services } = options;
	const routes = new Hono<ControlEnv>();

	routes.route("/", createHealthRoutes());
	routes.route("/", createStateRoutes({ state: services.state, reset: services.reset }));
	routes.route("/", createSnapshotRoutes({ snapshots: services.snapshots }));
	routes.route("/", createContactRoutes({ contacts: services.contacts }));
	routes.route("/", createConversationRoutes({ conversations: services.conversations }));
	routes.route("/", createInboundRoutes({ inbound: services.inbound, media: services.media }));
	routes.route("/", createMediaRoutes({ media: services.media, uploads: services.uploads }));
	routes.route("/", createMessageRoutes({ statusLadder: services.statusLadder }));
	routes.route(
		"/",
		createTemplateRoutes({ templates: services.templates, templateLifecycle: services.templateLifecycle }),
	);
	routes.route("/", createTypingRoutes({ typing: services.typing }));
	routes.route("/", createMessagingRulesRoutes({ messagingRules: services.messagingRules }));
	routes.route("/", createInjectionRoutes({ injection: services.injection }));
	routes.route("/", createClockRoutes({ clock: services.clock }));
	routes.route("/", createScenarioRoutes({ scenarios: services.scenarios }));
	routes.route("/", createGraphRequestRoutes({ graphRequests: services.graphRequests }));
	routes.route("/", createTokenRoutes({ tokens: services.tokens }));
	routes.route("/", createWebhookRoutes({ webhooks: services.webhooks, accountEvents: services.accountEvents }));
	routes.route(
		"/",
		createAppRoutes({
			apps: services.apps,
			webhooks: services.webhooks,
			destinationsLocked: options.access?.mode === "public",
		}),
	);
	routes.route(
		"/",
		createPhoneNumberRoutes({ phoneNumbers: services.phoneNumbers, businessProfiles: services.businessProfiles }),
	);
	routes.route("/", createWabaRoutes({ wabas: services.wabas }));
	const mode = options.access?.mode ?? "dev";

	routes.get("/phone/config", c => c.json(phoneConfigResponseSchema.parse({ data: { mode } })));

	if (options.access?.mode === "public") {
		const visitorOptions = {
			access: options.access,
			sessions: services.visitors,
			phone: services.phone,
			inbound: services.inbound,
			media: services.media,
			clock: services.clock,
			events: services.events,
			logger: options.logger,
			...(options.adminState !== undefined && { adminState: options.adminState }),
		};

		routes.route("/", createVisitorSessionRoutes(visitorOptions));
		routes.route("/", createVisitorPhoneRoutes(visitorOptions));
	} else {
		routes.route(
			"/",
			createPhoneRoutes({
				phone: services.phone,
				inbound: services.inbound,
				events: services.events,
				media: services.media,
				clock: services.clock,
				logger: options.logger,
			}),
		);
	}
	routes.route("/", createWsRoutes({ events: services.events, logger: options.logger }));

	routes.onError(createControlErrorHandler());

	return routes;
}
