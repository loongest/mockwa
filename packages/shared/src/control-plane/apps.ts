import { z } from "zod";
import { metaIdSchema } from "./common.ts";

/**
 * Apps and webhook routing (SPEC §3, "Apps and routing"; SPEC §5, `/api/apps`).
 *
 * Secrets never leave the server: an app reports whether its secret, verify token and access
 * token are set, not their values. They are write-only from the console.
 */

/** The key the default app (the one `MOCKWA_WEBHOOK_URL` describes) is stored under. */
export const DEFAULT_APP_KEY = "default";

const httpUrlSchema = z.url({ protocol: /^https?$/, error: "must be an http(s) URL" });

/** Meta caps override URLs at 200 characters. */
export const overrideUrlSchema = httpUrlSchema.max(200, "must be at most 200 characters");

export const webhookAppSchema = z.object({
	/** `default`, or the registered app's id. What the other resources name an app by. */
	key: z.string(),
	id: metaIdSchema,
	name: z.string(),
	/** The default app comes from the environment and cannot be edited here. */
	isDefault: z.boolean(),
	callbackUrl: z.string().nullable(),
	hasAppSecret: z.boolean(),
	hasVerifyToken: z.boolean(),
	hasAccessToken: z.boolean(),
});

export type WebhookApp = z.infer<typeof webhookAppSchema>;

export const webhookSubscriptionSchema = z.object({
	wabaId: metaIdSchema,
	appKey: z.string(),
	overrideCallbackUri: z.string().nullable(),
	/** `null` for the default app when it receives the WABA's webhooks without subscribing. */
	subscribedAt: z.iso.datetime().nullable(),
	/** The default app, receiving because no registered app is subscribed (SPEC §2.20). */
	isImplicit: z.boolean(),
});

export type WebhookSubscription = z.infer<typeof webhookSubscriptionSchema>;

export const phoneNumberWebhookOverrideSchema = z.object({
	phoneNumberId: metaIdSchema,
	appKey: z.string(),
	callbackUri: z.string(),
	updatedAt: z.iso.datetime(),
});

export type PhoneNumberWebhookOverride = z.infer<typeof phoneNumberWebhookOverrideSchema>;

/** Everything that decides where a webhook goes, in one resource. */
export const webhookRoutingSchema = z.object({
	apps: z.array(webhookAppSchema),
	subscriptions: z.array(webhookSubscriptionSchema),
	phoneOverrides: z.array(phoneNumberWebhookOverrideSchema),
});

export type WebhookRouting = z.infer<typeof webhookRoutingSchema>;

export const webhookRoutingResponseSchema = z.object({ data: webhookRoutingSchema });

export type WebhookRoutingResponse = z.infer<typeof webhookRoutingResponseSchema>;

export const webhookAppResponseSchema = z.object({ data: webhookAppSchema });

export type WebhookAppResponse = z.infer<typeof webhookAppResponseSchema>;

const secretSchema = z.string().min(1).max(512);

/** `POST /api/apps`. */
export const webhookAppCreateRequestSchema = z.object({
	id: metaIdSchema.optional(),
	name: z.string().trim().min(1).max(80),
	callbackUrl: httpUrlSchema.optional(),
	appSecret: secretSchema.optional(),
	verifyToken: secretSchema.optional(),
	accessToken: secretSchema.optional(),
});

export type WebhookAppCreateRequest = z.infer<typeof webhookAppCreateRequestSchema>;

/** `PATCH /api/apps/:key` — `null` clears a field, an absent key keeps it. */
export const webhookAppUpdateRequestSchema = z.object({
	name: z.string().trim().min(1).max(80).optional(),
	callbackUrl: httpUrlSchema.nullable().optional(),
	appSecret: secretSchema.nullable().optional(),
	verifyToken: secretSchema.nullable().optional(),
	accessToken: secretSchema.nullable().optional(),
});

export type WebhookAppUpdateRequest = z.infer<typeof webhookAppUpdateRequestSchema>;

/**
 * `PUT /api/apps/:key/subscriptions/:wabaId` — subscribe, with or without a WABA override.
 * Omitting the override removes it, as a bare `POST /{waba}/subscribed_apps` does on Meta.
 */
export const putWebhookSubscriptionRequestSchema = z.object({
	overrideCallbackUri: overrideUrlSchema.optional(),
	verifyToken: secretSchema.optional(),
});

export type PutWebhookSubscriptionRequest = z.infer<typeof putWebhookSubscriptionRequestSchema>;

/** `PUT /api/apps/:key/phone-overrides/:phoneNumberId`. */
export const putPhoneNumberWebhookOverrideRequestSchema = z.object({
	callbackUri: overrideUrlSchema,
	verifyToken: secretSchema.optional(),
});

export type PutPhoneNumberWebhookOverrideRequest = z.infer<typeof putPhoneNumberWebhookOverrideRequestSchema>;

/** Which of Meta's three levels picked a URL. */
export const ROUTE_SOURCES = ["phone_number", "waba", "app"] as const;

export const routeSourceSchema = z.enum(ROUTE_SOURCES);

export type RouteSource = z.infer<typeof routeSourceSchema>;

/** `GET /api/webhook-routes?wabaId=&phoneNumberId=&field=` — where such an event would go. */
export const webhookRouteSchema = z.object({
	appKey: z.string(),
	appName: z.string(),
	url: z.string().nullable(),
	source: routeSourceSchema,
	signed: z.boolean(),
});

export type WebhookRoute = z.infer<typeof webhookRouteSchema>;

export const webhookRouteListResponseSchema = z.object({ data: z.array(webhookRouteSchema) });

export type WebhookRouteListResponse = z.infer<typeof webhookRouteListResponseSchema>;

export const webhookRouteQuerySchema = z.object({
	wabaId: metaIdSchema.optional(),
	phoneNumberId: metaIdSchema.optional(),
	field: z.string().min(1).default("messages"),
});

export type WebhookRouteQuery = z.infer<typeof webhookRouteQuerySchema>;
