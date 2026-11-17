import type { AppIdentity } from "@mockwa/shared";
import { AppService, overrideUrlProblem, type OverrideInput, type WebhookApp } from "./app-service.ts";
import { invalidParameterError, unknownObjectError } from "./meta-errors.ts";

/**
 * The Graph side of Meta's webhook model (SPEC §2.20, §3): `subscribed_apps` on a WABA and
 * `webhook_configuration` on a phone number.
 *
 * The app a call acts on is the one its access token belongs to — a registered app with that
 * `accessToken`, otherwise the default app — just as Meta reads the app off the token.
 *
 * Divergences, documented in SPEC:
 *
 * - The default app is not gated by its subscription while no registered app subscribes to the
 *   WABA: it keeps receiving, because a dev tool that silently stopped delivering after a
 *   `DELETE` would be a support question, not a feature.
 * - `DELETE` on a WABA nothing is subscribed to answers `{success:true}` rather than an error:
 *   the call is idempotent, which is how a consumer's teardown wants to behave.
 * - Setting an override does not call the URL. Meta's reference does not say whether it
 *   verifies an override when it is set, so mockwa does not invent a failure for it; the
 *   console's handshake checks any URL on demand.
 *
 * An unknown WABA or number keeps the uniform missing-object envelope (SPEC §1.4).
 */

/** One entry of `GET /{wabaId}/subscribed_apps`. */
export interface SubscribedApp {
	id: string;
	name: string;
	link: string;
	overrideCallbackUri: string | null;
}

/** `GET /{phoneNumberId}?fields=webhook_configuration`, the keys Meta's reference shows. */
export interface WebhookConfiguration {
	phone_number?: string;
	whatsapp_business_account?: string;
	application?: string;
}

export interface SubscribedAppServiceOptions {
	apps: AppService;
	/** `MOCKWA_PUBLIC_URL`, reported as every app's `link`. */
	publicUrl: string;
}

/** Both or neither: Meta marks the URL and its verify token as required together. */
export function parseOverride(uri: unknown, verifyToken: unknown, parameter: string): OverrideInput | null {
	if (uri === undefined && verifyToken === undefined) {
		return null;
	}

	if (typeof uri !== "string" || typeof verifyToken !== "string" || verifyToken === "") {
		throw invalidParameterError(`${parameter} and verify_token are required together`);
	}

	const problem = overrideUrlProblem(uri);

	if (problem !== undefined) {
		throw invalidParameterError(`${parameter} ${problem}`);
	}

	return { callbackUri: uri, verifyToken };
}

export class SubscribedAppService {
	readonly #apps: AppService;
	readonly #publicUrl: string;

	constructor(options: SubscribedAppServiceOptions) {
		this.#apps = options.apps;
		this.#publicUrl = options.publicUrl;
	}

	/** A known WABA always has at least the default app routed to it, so none means unknown. */
	async #assertWaba(wabaId: string): Promise<void> {
		const subscriptions = await this.#apps.subscriptions(wabaId);

		if (subscriptions.length === 0) {
			throw unknownObjectError(wabaId);
		}
	}

	/** The default app, for `GET /api/state` and the Upload API's scope. */
	get identity(): AppIdentity {
		const app = this.#apps.defaultApp;

		return { id: app.id, name: app.name };
	}

	/**
	 * `POST /{wabaId}/subscribed_apps`. With `override_callback_uri` and `verify_token` it sets
	 * the WABA override; without them it clears it, as Meta's reference describes.
	 */
	async subscribe(wabaId: string, accessToken: string | undefined, override: OverrideInput | null): Promise<void> {
		const app = await this.#apps.forAccessToken(accessToken);

		if (!(await this.#apps.subscribe(app, wabaId, override))) {
			throw unknownObjectError(wabaId);
		}
	}

	/** `GET /{wabaId}/subscribed_apps` — every app that subscribed, never the implicit default. */
	async list(wabaId: string): Promise<SubscribedApp[]> {
		await this.#assertWaba(wabaId);

		const subscriptions = await this.#apps.subscriptions(wabaId);

		return subscriptions
			.filter(subscription => !subscription.isImplicit)
			.map(subscription => {
				return {
					id: subscription.app.id,
					name: subscription.app.name,
					link: this.#publicUrl,
					overrideCallbackUri: subscription.overrideCallbackUri,
				};
			});
	}

	/** `DELETE /{wabaId}/subscribed_apps`, idempotent. */
	async unsubscribe(wabaId: string, accessToken: string | undefined): Promise<void> {
		const app = await this.#apps.forAccessToken(accessToken);

		if (!(await this.#apps.unsubscribe(app, wabaId))) {
			throw unknownObjectError(wabaId);
		}
	}

	/** `POST /{phoneNumberId}` with `webhook_configuration`; an empty URI removes the override. */
	async configurePhoneNumber(
		phoneNumberId: string,
		accessToken: string | undefined,
		configuration: { override_callback_uri?: unknown; verify_token?: unknown },
	): Promise<void> {
		const app = await this.#apps.forAccessToken(accessToken);
		const override =
			configuration.override_callback_uri === ""
				? null
				: parseOverride(configuration.override_callback_uri, configuration.verify_token, "override_callback_uri");

		if (override === null && configuration.override_callback_uri !== "") {
			throw invalidParameterError("webhook_configuration needs override_callback_uri");
		}

		if (!(await this.#apps.setPhoneOverride(app, phoneNumberId, override))) {
			throw unknownObjectError(phoneNumberId);
		}
	}

	/** `webhook_configuration` of a number, as the calling app sees it. */
	async webhookConfiguration(phoneNumberId: string, wabaId: string, accessToken: string | undefined) {
		const app: WebhookApp = await this.#apps.forAccessToken(accessToken);
		const phoneOverride = await this.#apps.phoneOverride(app, phoneNumberId);
		const subscriptions = await this.#apps.subscriptions(wabaId);
		const subscription = subscriptions.find(candidate => candidate.app.key === app.key);
		const configuration: WebhookConfiguration = {};

		if (phoneOverride !== null) {
			configuration.phone_number = phoneOverride.callbackUri;
		}

		const wabaOverride = subscription?.overrideCallbackUri ?? null;

		if (wabaOverride !== null) {
			configuration.whatsapp_business_account = wabaOverride;
		}

		if (app.callbackUrl !== null) {
			configuration.application = app.callbackUrl;
		}

		return configuration;
	}
}
