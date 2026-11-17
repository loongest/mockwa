import type { WebhookApp as WebhookAppDto, WebhookRouting } from "@mockwa/shared";
import type { SeedApp } from "../config/index.ts";
import type {
	AppRecord,
	PhoneNumberRecord,
	PhoneNumberWebhookOverrideRecord,
	Repositories,
	WabaRecord,
	WebhookSubscriptionRecord,
} from "../db/index.ts";
import { controlBadRequest, controlConflict, controlNotFound } from "./control-plane-error.ts";
import { toWabaDto } from "./control-dto.ts";
import { noopEventPublisher, type EventPublisher } from "./event-bus.ts";
import { createNumericId, defaultRandomBytes, deriveNumericId, type RandomBytes } from "./ids.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";

/**
 * The apps webhooks are delivered to, and Meta's rules for picking a URL (SPEC §3, "Apps and
 * routing").
 *
 * There are two kinds of app:
 *
 * - **The default app** is the one the environment describes — `MOCKWA_WEBHOOK_URL`,
 *   `MOCKWA_APP_SECRET`, `MOCKWA_WEBHOOK_VERIFY_TOKEN`, `MOCKWA_APP_ID`. It is never stored and
 *   cannot be edited from the console; its subscriptions and overrides are stored under the key
 *   {@link DEFAULT_APP_KEY}.
 * - **Registered apps** are rows, created from the console, the control plane or `MOCKWA_APPS`,
 *   each with its own callback URL, app secret and verify token.
 *
 * Who receives a WABA's webhooks: every registered app subscribed to it, plus the default app
 * when it is subscribed **or when no registered app is**. The second half is what keeps a
 * mockwa with only the environment configured behaving exactly as before: the default app
 * receives everything, subscribed or not (the divergence SPEC §2.20 documents).
 *
 * Where each app's copy goes is Meta's lookup order: the phone number's override for that app,
 * then the WABA's, then the app's own callback URL. Only the fields Meta lets an override
 * redirect use the first two; template and account events always go to the app's callback.
 */

/** How the default app is named in the tables, so a changed `MOCKWA_APP_ID` orphans nothing. */
export const DEFAULT_APP_KEY = "default";

/** The name the default app reports, as `subscribed_apps` always has (SPEC §2.20). */
export const DEFAULT_APP_NAME = "whaloc";

const DERIVED_DEFAULT_APP_ID_KEY = "app:whaloc";

/**
 * Fields an override redirects, from Meta's override reference; every other field (templates,
 * account notices, quality updates) always goes to the app's own callback URL.
 */
export const OVERRIDABLE_FIELDS: ReadonlySet<string> = new Set([
	"messages",
	"message_echoes",
	"calls",
	"consumer_profile",
	"messaging_handovers",
	"standby",
	"history",
	"account_settings_update",
]);

/** Meta caps an override URL at 200 characters. */
export const MAX_OVERRIDE_URL_LENGTH = 200;

export interface WebhookApp {
	/** `default`, or the registered app's id. */
	key: string;
	id: string;
	name: string;
	isDefault: boolean;
	appSecret: string | null;
	verifyToken: string | null;
	callbackUrl: string | null;
	accessToken: string | null;
}

/** Which rule picked the URL: Meta's three levels. */
export type RouteSource = "phone_number" | "waba" | "app";

export interface WebhookRoute {
	app: WebhookApp;
	/** `null` when the app has nowhere to send it: the delivery is logged as skipped. */
	url: string | null;
	source: RouteSource;
	/** The verify token that goes with `url`: the override's own, or the app's. */
	verifyToken: string | null;
}

export interface RouteRequest {
	field: string;
	wabaId?: string | undefined;
	phoneNumberId?: string | undefined;
}

export interface DefaultAppConfig {
	id?: string | undefined;
	appSecret?: string | undefined;
	verifyToken?: string | undefined;
	callbackUrl?: string | undefined;
}

export interface AppServiceOptions {
	repositories: Repositories;
	defaultApp: DefaultAppConfig;
	events?: EventPublisher;
	scheduler?: Scheduler;
	random?: RandomBytes;
}

export interface CreateAppInput {
	id?: string | undefined;
	name: string;
	appSecret?: string | null | undefined;
	verifyToken?: string | null | undefined;
	callbackUrl?: string | null | undefined;
	accessToken?: string | null | undefined;
}

/** `null` clears a field, an absent one keeps it. */
export interface UpdateAppFields {
	name?: string | undefined;
	appSecret?: string | null | undefined;
	verifyToken?: string | null | undefined;
	callbackUrl?: string | null | undefined;
	accessToken?: string | null | undefined;
}

export interface OverrideInput {
	callbackUri: string;
	verifyToken: string | null;
}

/** An app's subscription to one WABA, as the control plane and `subscribed_apps` read it. */
export interface AppSubscription {
	app: WebhookApp;
	wabaId: string;
	overrideCallbackUri: string | null;
	overrideVerifyToken: string | null;
	subscribedAt: string | null;
	/** `true` for the default app when it receives a WABA's webhooks without a subscription. */
	isImplicit: boolean;
}

/** Secrets stay on the server: the console learns whether they are set, never their values. */
export function toWebhookAppDto(app: WebhookApp): WebhookAppDto {
	return {
		key: app.key,
		id: app.id,
		name: app.name,
		isDefault: app.isDefault,
		callbackUrl: app.callbackUrl,
		hasAppSecret: app.appSecret !== null,
		hasVerifyToken: app.verifyToken !== null,
		hasAccessToken: app.accessToken !== null,
	};
}

function fromRecord(record: AppRecord): WebhookApp {
	return {
		key: record.id,
		id: record.id,
		name: record.name,
		isDefault: false,
		appSecret: record.appSecret,
		verifyToken: record.verifyToken,
		callbackUrl: record.callbackUrl,
		accessToken: record.accessToken,
	};
}

/** Meta's override URLs are http(s) and short; a malformed one is the caller's mistake. */
export function overrideUrlProblem(value: string): string | undefined {
	if (value.length > MAX_OVERRIDE_URL_LENGTH) {
		return `must be at most ${String(MAX_OVERRIDE_URL_LENGTH)} characters`;
	}

	if (!URL.canParse(value)) {
		return "must be an http(s) URL";
	}

	const { protocol } = new URL(value);

	return protocol === "http:" || protocol === "https:" ? undefined : "must be an http(s) URL";
}

export class AppService {
	readonly #repositories: Repositories;
	readonly #default: WebhookApp;
	readonly #events: EventPublisher;
	readonly #scheduler: Scheduler;
	readonly #random: RandomBytes;

	constructor(options: AppServiceOptions) {
		this.#repositories = options.repositories;
		this.#default = {
			key: DEFAULT_APP_KEY,
			id: options.defaultApp.id ?? deriveNumericId(DERIVED_DEFAULT_APP_ID_KEY),
			name: DEFAULT_APP_NAME,
			isDefault: true,
			appSecret: options.defaultApp.appSecret ?? null,
			verifyToken: options.defaultApp.verifyToken ?? null,
			callbackUrl: options.defaultApp.callbackUrl ?? null,
			accessToken: null,
		};
		this.#events = options.events ?? noopEventPublisher;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#random = options.random ?? defaultRandomBytes;
	}

	async #changed(): Promise<void> {
		this.#events.publish({ type: "webhook_routing.changed", payload: { routing: await this.routing() } });
	}

	async #assertUnique(
		fields: { id?: string; name?: string; accessToken?: string | null },
		self?: string,
	): Promise<void> {
		const apps = await this.list();

		for (const app of apps) {
			if (app.key === self) {
				continue;
			}

			if (fields.id !== undefined && app.id === fields.id) {
				throw controlConflict(`an app with id ${fields.id} already exists`, "app_exists");
			}

			if (fields.name !== undefined && app.name === fields.name) {
				throw controlConflict(`an app named ${fields.name} already exists`, "app_exists");
			}

			if (fields.accessToken !== undefined && fields.accessToken !== null && app.accessToken === fields.accessToken) {
				throw controlConflict("another app already uses that access token", "app_exists");
			}
		}
	}

	#assertEditable(app: WebhookApp): void {
		if (app.isDefault) {
			throw controlBadRequest(
				"the default app comes from the environment (MOCKWA_WEBHOOK_URL, MOCKWA_APP_SECRET, MOCKWA_WEBHOOK_VERIFY_TOKEN): change those and restart",
				"default_app_read_only",
			);
		}
	}

	async #waba(wabaId: string): Promise<WabaRecord | null> {
		return this.#repositories.wabas.findById(wabaId);
	}

	/** The default app's subscription is the WABA's own `subscribedAt`, announced with it. */
	async #setDefaultSubscribedAt(wabaId: string, subscribedAt: string | null): Promise<void> {
		const updated = await this.#repositories.wabas.update(wabaId, { subscribedAt });

		if (updated !== null) {
			this.#events.publish({ type: "waba.changed", payload: { waba: toWabaDto(updated), event: "updated" } });
		}
	}

	#appRoute(app: WebhookApp): WebhookRoute {
		return { app, url: app.callbackUrl, source: "app", verifyToken: app.verifyToken };
	}

	/** Apps, subscriptions and overrides together: what `GET /api/apps` serves (SPEC §5). */
	async routing(): Promise<WebhookRouting> {
		const apps = await this.list();
		const wabas = await this.#repositories.wabas.list();
		const subscriptions = [];

		for (const waba of wabas) {
			const forWaba = await this.subscriptions(waba.id);

			for (const subscription of forWaba) {
				subscriptions.push({
					wabaId: waba.id,
					appKey: subscription.app.key,
					overrideCallbackUri: subscription.overrideCallbackUri,
					subscribedAt: subscription.subscribedAt,
					isImplicit: subscription.isImplicit,
				});
			}
		}

		const overrides = await this.listPhoneOverrides();
		const known = new Set(apps.map(app => app.key));

		return {
			apps: apps.map(app => toWebhookAppDto(app)),
			subscriptions,
			phoneOverrides: overrides
				.filter(override => known.has(override.appKey))
				.map(override => {
					return {
						phoneNumberId: override.phoneNumberId,
						appKey: override.appKey,
						callbackUri: override.callbackUri,
						updatedAt: override.updatedAt,
					};
				}),
		};
	}

	get defaultApp(): WebhookApp {
		return { ...this.#default };
	}

	/** The default app first, then the registered ones in the order they were created. */
	async list(): Promise<WebhookApp[]> {
		const records = await this.#repositories.apps.list();

		return [this.defaultApp, ...records.map(record => fromRecord(record))];
	}

	/** By key or by id: the default app answers to both `default` and its configured id. */
	async find(keyOrId: string): Promise<WebhookApp | null> {
		if (keyOrId === DEFAULT_APP_KEY || keyOrId === this.#default.id) {
			return this.defaultApp;
		}

		const record = await this.#repositories.apps.findById(keyOrId);

		return record === null ? null : fromRecord(record);
	}

	async require(keyOrId: string): Promise<WebhookApp> {
		const app = await this.find(keyOrId);

		if (app === null) {
			throw controlNotFound(`app ${keyOrId} not found`, "app_not_found");
		}

		return app;
	}

	/**
	 * The app a Graph call acts as: the registered app that owns its bearer token, otherwise the
	 * default app. This is how `subscribed_apps` and `webhook_configuration` know whose
	 * subscription or override they are changing, as the access token tells Meta.
	 */
	async forAccessToken(token: string | undefined): Promise<WebhookApp> {
		if (token === undefined) {
			return this.defaultApp;
		}

		const record = await this.#repositories.apps.findByAccessToken(token);

		return record === null ? this.defaultApp : fromRecord(record);
	}

	async create(input: CreateAppInput): Promise<WebhookApp> {
		const id = input.id ?? createNumericId(this.#random);

		if (id === DEFAULT_APP_KEY) {
			throw controlBadRequest("app ids are digits");
		}

		await this.#assertUnique({ id, name: input.name, accessToken: input.accessToken ?? null });

		const record = await this.#repositories.apps.insert({
			id,
			name: input.name,
			appSecret: input.appSecret ?? null,
			verifyToken: input.verifyToken ?? null,
			callbackUrl: input.callbackUrl ?? null,
			accessToken: input.accessToken ?? null,
			createdAt: this.#scheduler.now().toISOString(),
		});

		await this.#changed();

		return fromRecord(record);
	}

	async update(keyOrId: string, fields: UpdateAppFields): Promise<WebhookApp> {
		const app = await this.require(keyOrId);

		this.#assertEditable(app);
		await this.#assertUnique(
			{
				...(fields.name !== undefined && { name: fields.name }),
				...(fields.accessToken !== undefined && { accessToken: fields.accessToken }),
			},
			app.key,
		);

		const record = await this.#repositories.apps.update(app.id, {
			...(fields.name !== undefined && { name: fields.name }),
			...(fields.appSecret !== undefined && { appSecret: fields.appSecret }),
			...(fields.verifyToken !== undefined && { verifyToken: fields.verifyToken }),
			...(fields.callbackUrl !== undefined && { callbackUrl: fields.callbackUrl }),
			...(fields.accessToken !== undefined && { accessToken: fields.accessToken }),
			updatedAt: this.#scheduler.now().toISOString(),
		});

		if (record === null) {
			throw controlNotFound(`app ${keyOrId} not found`, "app_not_found");
		}

		await this.#changed();

		return fromRecord(record);
	}

	/** Deletes the app with its subscriptions and overrides; its pending retries are cancelled. */
	async delete(keyOrId: string): Promise<void> {
		const app = await this.require(keyOrId);

		this.#assertEditable(app);
		await this.#repositories.apps.delete(app.id);
		await this.#repositories.webhookDeliveries.cancelPending({ appKey: app.key });
		await this.#changed();
	}

	/**
	 * Subscribes an app to a WABA. `override` sets the WABA-level override, `null` removes it —
	 * Meta's own semantics: a subscribe call without the override fields clears it.
	 * Returns `false` when the WABA does not exist; the caller maps that to its own error.
	 */
	async subscribe(app: WebhookApp, wabaId: string, override: OverrideInput | null): Promise<boolean> {
		const waba = await this.#waba(wabaId);

		if (waba === null) {
			return false;
		}

		const now = this.#scheduler.now().toISOString();

		if (app.isDefault) {
			await this.#setDefaultSubscribedAt(wabaId, now);

			if (override === null) {
				await this.#repositories.webhookSubscriptions.delete(wabaId, app.key);
			}
		}

		if (override !== null || !app.isDefault) {
			await this.#repositories.webhookSubscriptions.upsert({
				wabaId,
				appKey: app.key,
				overrideCallbackUri: override?.callbackUri ?? null,
				overrideVerifyToken: override?.verifyToken ?? null,
				subscribedAt: now,
			});
		}

		await this.#changed();

		return true;
	}

	/** Idempotent. `false` when the WABA does not exist. */
	async unsubscribe(app: WebhookApp, wabaId: string): Promise<boolean> {
		const waba = await this.#waba(wabaId);

		if (waba === null) {
			return false;
		}

		if (app.isDefault && waba.subscribedAt !== null) {
			await this.#setDefaultSubscribedAt(wabaId, null);
		}

		await this.#repositories.webhookSubscriptions.delete(wabaId, app.key);
		await this.#changed();

		return true;
	}

	/**
	 * Every app that receives this WABA's webhooks, with its override. The default app is
	 * listed when subscribed, or — flagged `isImplicit` — when no registered app is.
	 */
	async subscriptions(wabaId: string): Promise<AppSubscription[]> {
		const waba = await this.#waba(wabaId);

		if (waba === null) {
			return [];
		}

		const rows = await this.#repositories.webhookSubscriptions.listForWaba(wabaId);
		const registered: AppSubscription[] = [];
		let defaultRow: WebhookSubscriptionRecord | undefined;

		for (const row of rows) {
			if (row.appKey === DEFAULT_APP_KEY) {
				defaultRow = row;
				continue;
			}

			const record = await this.#repositories.apps.findById(row.appKey);

			if (record !== null) {
				registered.push({
					app: fromRecord(record),
					wabaId,
					overrideCallbackUri: row.overrideCallbackUri,
					overrideVerifyToken: row.overrideVerifyToken,
					subscribedAt: row.subscribedAt,
					isImplicit: false,
				});
			}
		}

		const isDefaultSubscribed = waba.subscribedAt !== null;

		if (!isDefaultSubscribed && registered.length > 0) {
			return registered;
		}

		return [
			{
				app: this.defaultApp,
				wabaId,
				overrideCallbackUri: defaultRow?.overrideCallbackUri ?? null,
				overrideVerifyToken: defaultRow?.overrideVerifyToken ?? null,
				subscribedAt: waba.subscribedAt,
				isImplicit: !isDefaultSubscribed,
			},
			...registered,
		];
	}

	/** The phone-number override of one app, or `null`. */
	async phoneOverride(app: WebhookApp, phoneNumberId: string): Promise<PhoneNumberWebhookOverrideRecord | null> {
		return this.#repositories.webhookSubscriptions.findPhoneOverride(phoneNumberId, app.key);
	}

	/** Sets (or, with `null`, removes) an app's override on a number. `false` for an unknown number. */
	async setPhoneOverride(app: WebhookApp, phoneNumberId: string, override: OverrideInput | null): Promise<boolean> {
		const phoneNumber: PhoneNumberRecord | null = await this.#repositories.phoneNumbers.findById(phoneNumberId);

		if (phoneNumber === null) {
			return false;
		}

		await (override === null
			? this.#repositories.webhookSubscriptions.deletePhoneOverride(phoneNumberId, app.key)
			: this.#repositories.webhookSubscriptions.upsertPhoneOverride({
					phoneNumberId,
					appKey: app.key,
					callbackUri: override.callbackUri,
					verifyToken: override.verifyToken,
					updatedAt: this.#scheduler.now().toISOString(),
				}));
		await this.#changed();

		return true;
	}

	async listPhoneOverrides(): Promise<PhoneNumberWebhookOverrideRecord[]> {
		return this.#repositories.webhookSubscriptions.listPhoneOverrides();
	}

	/**
	 * Where one event goes, one route per receiving app. A WABA mockwa does not know — a raw
	 * webhook, say — goes to the default app's callback URL, the only address it has.
	 */
	async route(request: RouteRequest): Promise<WebhookRoute[]> {
		if (request.wabaId === undefined) {
			return [this.#appRoute(this.defaultApp)];
		}

		const subscriptions = await this.subscriptions(request.wabaId);

		if (subscriptions.length === 0) {
			return [this.#appRoute(this.defaultApp)];
		}

		const isOverridable = OVERRIDABLE_FIELDS.has(request.field);
		const routes: WebhookRoute[] = [];

		for (const subscription of subscriptions) {
			const phoneOverride =
				isOverridable && request.phoneNumberId !== undefined
					? await this.phoneOverride(subscription.app, request.phoneNumberId)
					: null;

			if (phoneOverride !== null) {
				routes.push({
					app: subscription.app,
					url: phoneOverride.callbackUri,
					source: "phone_number",
					verifyToken: phoneOverride.verifyToken ?? subscription.app.verifyToken,
				});
			} else if (isOverridable && subscription.overrideCallbackUri !== null) {
				routes.push({
					app: subscription.app,
					url: subscription.overrideCallbackUri,
					source: "waba",
					verifyToken: subscription.overrideVerifyToken ?? subscription.app.verifyToken,
				});
			} else {
				routes.push(this.#appRoute(subscription.app));
			}
		}

		return routes;
	}

	/**
	 * Registers `MOCKWA_APPS` (SPEC §7). Idempotent like the seed: an app that already exists
	 * is left as it is, so edits made at runtime survive a restart with a file database, and a
	 * reset (which empties the table first) brings back exactly the configured apps.
	 */
	async applySeed(apps: readonly SeedApp[]): Promise<WebhookApp[]> {
		const applied: WebhookApp[] = [];
		const createdAt = this.#scheduler.now().toISOString();

		for (const seedApp of apps) {
			const id = seedApp.id ?? deriveNumericId(`app:${seedApp.name}`);
			let record = await this.#repositories.apps.findById(id);

			record ??= await this.#repositories.apps.insert({
				id,
				name: seedApp.name,
				appSecret: seedApp.appSecret ?? null,
				verifyToken: seedApp.verifyToken ?? null,
				callbackUrl: seedApp.callbackUrl ?? null,
				accessToken: seedApp.accessToken ?? null,
				createdAt,
			});

			for (const wabaId of seedApp.wabas) {
				if ((await this.#waba(wabaId)) === null) {
					throw new Error(`MOCKWA_APPS: app "${seedApp.name}" subscribes to WABA ${wabaId}, which does not exist`);
				}

				if ((await this.#repositories.webhookSubscriptions.find(wabaId, id)) === null) {
					await this.#repositories.webhookSubscriptions.upsert({
						wabaId,
						appKey: id,
						overrideCallbackUri: null,
						overrideVerifyToken: null,
						subscribedAt: createdAt,
					});
				}
			}

			applied.push(fromRecord(record));
		}

		return applied;
	}
}
