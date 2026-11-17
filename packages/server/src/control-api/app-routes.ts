import {
	webhookAppCreateRequestSchema,
	handshakeResponseSchema,
	putPhoneNumberWebhookOverrideRequestSchema,
	putWebhookSubscriptionRequestSchema,
	webhookAppUpdateRequestSchema,
	webhookAppResponseSchema,
	webhookRouteListResponseSchema,
	webhookRouteQuerySchema,
	webhookRoutingResponseSchema,
} from "@mockwa/shared";
import { Hono } from "hono";
import { toWebhookAppDto, type AppService, type OverrideInput, type WebhookEmitter } from "../domain/index.ts";
import { controlError, parseOrThrow, readBody, readOptionalJsonBody, type ControlEnv } from "./control-env.ts";

export interface AppRoutesOptions {
	apps: AppService;
	webhooks: WebhookEmitter;
}

/**
 * Apps and webhook routing (SPEC §5, §3).
 *
 * - `GET /api/apps` — every app, every subscription and every number override, in one resource
 *   (`webhook_routing.changed` pushes the same shape).
 * - `POST /api/apps`, `PATCH|DELETE /api/apps/:key` — registered apps. The default app answers
 *   400: it is the environment's.
 * - `PUT|DELETE /api/apps/:key/subscriptions/:wabaId` — subscribe (with an optional WABA
 *   override) or unsubscribe, for any app, the default one included.
 * - `PUT|DELETE /api/apps/:key/phone-overrides/:phoneNumberId` — a number's override.
 * - `POST /api/apps/:key/handshake` — the `hub.challenge` round trip against the app's URL, or
 *   against `{url, verifyToken}` when one of its overrides is the one to check.
 * - `GET /api/webhook-routes?wabaId=&phoneNumberId=&field=` — where such an event would go now.
 */
export function createAppRoutes(options: AppRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const routing = async () => webhookRoutingResponseSchema.parse({ data: await options.apps.routing() });

	routes.get("/apps", async c => c.json(await routing()));

	routes.post("/apps", async c => {
		const request = await readBody(c, webhookAppCreateRequestSchema);
		const app = await options.apps.create(request);

		return c.json(webhookAppResponseSchema.parse({ data: toWebhookAppDto(app) }), 201);
	});

	routes.patch("/apps/:key", async c => {
		const request = await readBody(c, webhookAppUpdateRequestSchema);
		const app = await options.apps.update(c.req.param("key"), request);

		return c.json(webhookAppResponseSchema.parse({ data: toWebhookAppDto(app) }));
	});

	routes.delete("/apps/:key", async c => {
		await options.apps.delete(c.req.param("key"));

		return c.body(null, 204);
	});

	routes.put("/apps/:key/subscriptions/:wabaId", async c => {
		const app = await options.apps.require(c.req.param("key"));
		const request = parseOrThrow(putWebhookSubscriptionRequestSchema, (await readOptionalJsonBody(c)) ?? {});
		const override: OverrideInput | null =
			request.overrideCallbackUri === undefined
				? null
				: { callbackUri: request.overrideCallbackUri, verifyToken: request.verifyToken ?? null };
		const wabaId = c.req.param("wabaId");

		if (!(await options.apps.subscribe(app, wabaId, override))) {
			return controlError(c, 404, `WABA ${wabaId} not found`, "waba_not_found");
		}

		return c.json(await routing());
	});

	routes.delete("/apps/:key/subscriptions/:wabaId", async c => {
		const app = await options.apps.require(c.req.param("key"));
		const wabaId = c.req.param("wabaId");

		if (!(await options.apps.unsubscribe(app, wabaId))) {
			return controlError(c, 404, `WABA ${wabaId} not found`, "waba_not_found");
		}

		return c.json(await routing());
	});

	routes.put("/apps/:key/phone-overrides/:phoneNumberId", async c => {
		const app = await options.apps.require(c.req.param("key"));
		const request = await readBody(c, putPhoneNumberWebhookOverrideRequestSchema);
		const phoneNumberId = c.req.param("phoneNumberId");
		const isKnown = await options.apps.setPhoneOverride(app, phoneNumberId, {
			callbackUri: request.callbackUri,
			verifyToken: request.verifyToken ?? null,
		});

		if (!isKnown) {
			return controlError(c, 404, `phone number ${phoneNumberId} not found`, "phone_number_not_found");
		}

		return c.json(await routing());
	});

	routes.delete("/apps/:key/phone-overrides/:phoneNumberId", async c => {
		const app = await options.apps.require(c.req.param("key"));
		const phoneNumberId = c.req.param("phoneNumberId");

		if (!(await options.apps.setPhoneOverride(app, phoneNumberId, null))) {
			return controlError(c, 404, `phone number ${phoneNumberId} not found`, "phone_number_not_found");
		}

		return c.json(await routing());
	});

	routes.post("/apps/:key/handshake", async c => {
		const body = (await readOptionalJsonBody(c)) ?? {};
		const target = parseOrThrow(putPhoneNumberWebhookOverrideRequestSchema.partial(), body);
		const result = await options.webhooks.handshakeApp(c.req.param("key"), {
			...(target.callbackUri !== undefined && { url: target.callbackUri }),
			...(target.verifyToken !== undefined && { verifyToken: target.verifyToken }),
		});

		return c.json(handshakeResponseSchema.parse({ data: result }));
	});

	routes.get("/webhook-routes", async c => {
		const query = parseOrThrow(webhookRouteQuerySchema, c.req.query());
		const found = await options.apps.route({
			field: query.field,
			...(query.wabaId !== undefined && { wabaId: query.wabaId }),
			...(query.phoneNumberId !== undefined && { phoneNumberId: query.phoneNumberId }),
		});

		return c.json(
			webhookRouteListResponseSchema.parse({
				data: found.map(route => {
					return {
						appKey: route.app.key,
						appName: route.app.name,
						url: route.url,
						source: route.source,
						signed: route.app.appSecret !== null,
					};
				}),
			}),
		);
	});

	return routes;
}
