import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { Database, PhoneNumberWebhookOverrideTable, WebhookSubscriptionTable } from "../schema.ts";

/** One row of `webhook_subscriptions` (SPEC §3, "Apps and routing"). */
export interface WebhookSubscriptionRecord {
	wabaId: string;
	/** A registered app's id, or `default`. */
	appKey: string;
	overrideCallbackUri: string | null;
	overrideVerifyToken: string | null;
	subscribedAt: string;
}

/** Meta's phone-number `webhook_configuration`, for one app. */
export interface PhoneNumberWebhookOverrideRecord {
	phoneNumberId: string;
	appKey: string;
	callbackUri: string;
	verifyToken: string | null;
	updatedAt: string;
}

export interface UpsertWebhookSubscriptionInput {
	wabaId: string;
	appKey: string;
	overrideCallbackUri: string | null;
	overrideVerifyToken: string | null;
	subscribedAt?: string;
}

export interface UpsertPhoneNumberWebhookOverrideInput {
	phoneNumberId: string;
	appKey: string;
	callbackUri: string;
	verifyToken: string | null;
	updatedAt?: string;
}

function toSubscription(row: WebhookSubscriptionTable): WebhookSubscriptionRecord {
	return {
		wabaId: row.waba_id,
		appKey: row.app_key,
		overrideCallbackUri: row.override_callback_uri,
		overrideVerifyToken: row.override_verify_token,
		subscribedAt: row.subscribed_at,
	};
}

function toOverride(row: PhoneNumberWebhookOverrideTable): PhoneNumberWebhookOverrideRecord {
	return {
		phoneNumberId: row.phone_number_id,
		appKey: row.app_key,
		callbackUri: row.callback_uri,
		verifyToken: row.verify_token,
		updatedAt: row.updated_at,
	};
}

/** Who a WABA's webhooks go to, and the overrides that redirect them (SPEC §3). */
export class WebhookSubscriptionRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async upsert(input: UpsertWebhookSubscriptionInput): Promise<WebhookSubscriptionRecord> {
		const values = {
			waba_id: input.wabaId,
			app_key: input.appKey,
			override_callback_uri: input.overrideCallbackUri,
			override_verify_token: input.overrideVerifyToken,
			subscribed_at: input.subscribedAt ?? nowIso(),
		};
		const row = await this.#db
			.insertInto("webhook_subscriptions")
			.values(values)
			.onConflict(conflict => {
				return conflict.columns(["waba_id", "app_key"]).doUpdateSet({
					override_callback_uri: values.override_callback_uri,
					override_verify_token: values.override_verify_token,
					subscribed_at: values.subscribed_at,
				});
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toSubscription(row);
	}

	async find(wabaId: string, appKey: string): Promise<WebhookSubscriptionRecord | null> {
		const row = await this.#db
			.selectFrom("webhook_subscriptions")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.where("app_key", "=", appKey)
			.executeTakeFirst();

		return row === undefined ? null : toSubscription(row);
	}

	async listForWaba(wabaId: string): Promise<WebhookSubscriptionRecord[]> {
		const rows = await this.#db
			.selectFrom("webhook_subscriptions")
			.selectAll()
			.where("waba_id", "=", wabaId)
			.orderBy("subscribed_at")
			.orderBy("app_key")
			.execute();

		return rows.map(row => toSubscription(row));
	}

	async list(): Promise<WebhookSubscriptionRecord[]> {
		const rows = await this.#db
			.selectFrom("webhook_subscriptions")
			.selectAll()
			.orderBy("waba_id")
			.orderBy("subscribed_at")
			.orderBy("app_key")
			.execute();

		return rows.map(row => toSubscription(row));
	}

	async delete(wabaId: string, appKey: string): Promise<boolean> {
		const result = await this.#db
			.deleteFrom("webhook_subscriptions")
			.where("waba_id", "=", wabaId)
			.where("app_key", "=", appKey)
			.executeTakeFirst();

		return result.numDeletedRows > 0n;
	}

	async upsertPhoneOverride(input: UpsertPhoneNumberWebhookOverrideInput): Promise<PhoneNumberWebhookOverrideRecord> {
		const values = {
			phone_number_id: input.phoneNumberId,
			app_key: input.appKey,
			callback_uri: input.callbackUri,
			verify_token: input.verifyToken,
			updated_at: input.updatedAt ?? nowIso(),
		};
		const row = await this.#db
			.insertInto("phone_number_webhook_overrides")
			.values(values)
			.onConflict(conflict => {
				return conflict.columns(["phone_number_id", "app_key"]).doUpdateSet({
					callback_uri: values.callback_uri,
					verify_token: values.verify_token,
					updated_at: values.updated_at,
				});
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toOverride(row);
	}

	async findPhoneOverride(phoneNumberId: string, appKey: string): Promise<PhoneNumberWebhookOverrideRecord | null> {
		const row = await this.#db
			.selectFrom("phone_number_webhook_overrides")
			.selectAll()
			.where("phone_number_id", "=", phoneNumberId)
			.where("app_key", "=", appKey)
			.executeTakeFirst();

		return row === undefined ? null : toOverride(row);
	}

	async listPhoneOverrides(): Promise<PhoneNumberWebhookOverrideRecord[]> {
		const rows = await this.#db
			.selectFrom("phone_number_webhook_overrides")
			.selectAll()
			.orderBy("phone_number_id")
			.orderBy("app_key")
			.execute();

		return rows.map(row => toOverride(row));
	}

	async deletePhoneOverride(phoneNumberId: string, appKey: string): Promise<boolean> {
		const result = await this.#db
			.deleteFrom("phone_number_webhook_overrides")
			.where("phone_number_id", "=", phoneNumberId)
			.where("app_key", "=", appKey)
			.executeTakeFirst();

		return result.numDeletedRows > 0n;
	}

	/** Wipes both tables; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const overrides = await this.#db.deleteFrom("phone_number_webhook_overrides").executeTakeFirst();
		const subscriptions = await this.#db.deleteFrom("webhook_subscriptions").executeTakeFirst();

		return Number(overrides.numDeletedRows) + Number(subscriptions.numDeletedRows);
	}
}
