import type { Kysely } from "kysely";
import type { Migration, MigrationProvider } from "kysely/migration";

/**
 * The migration list lives in code (SPEC §6): the image ships no migration folder, and the
 * migrator runs them at boot against whatever `WHALOC_DB_PATH` points at.
 *
 * Keys are ordered lexicographically by the migrator, so new migrations get the next number
 * and are never renamed. Migrations only ever move forward here — SQLite cannot roll DDL
 * back inside a transaction, and a dev tool that loses its database is not a disaster.
 */
export const MIGRATIONS: Record<string, Migration> = {
	"0001_initial_schema": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.createTable("wabas")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("name", "text", column => column.notNull())
				.addColumn("created_at", "text", column => column.notNull())
				.execute();

			await db.schema
				.createTable("phone_numbers")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("waba_id", "text", column => column.notNull().references("wabas.id").onDelete("cascade"))
				.addColumn("display_phone_number", "text", column => column.notNull())
				.addColumn("verified_name", "text", column => column.notNull())
				.addColumn("quality_rating", "text", column => column.notNull())
				.addColumn("throughput_level", "text", column => column.notNull())
				.addColumn("created_at", "text", column => column.notNull())
				.execute();

			// One display number per WABA: the natural key seeding matches on (SPEC §7).
			await db.schema
				.createIndex("phone_numbers_waba_id_display_phone_number_unique")
				.on("phone_numbers")
				.columns(["waba_id", "display_phone_number"])
				.unique()
				.execute();

			await db.schema
				.createTable("contacts")
				.addColumn("wa_id", "text", column => column.primaryKey())
				.addColumn("profile_name", "text", column => column.notNull())
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			await db.schema
				.createTable("templates")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("waba_id", "text", column => column.notNull().references("wabas.id").onDelete("cascade"))
				.addColumn("name", "text", column => column.notNull())
				.addColumn("language", "text", column => column.notNull())
				.addColumn("category", "text", column => column.notNull())
				.addColumn("parameter_format", "text", column => column.notNull())
				.addColumn("components", "text", column => column.notNull())
				.addColumn("status", "text", column => column.notNull())
				.addColumn("rejected_reason", "text")
				.addColumn("quality_score", "text")
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			// A template is identified by name + language within a WABA (SPEC §2.7).
			await db.schema
				.createIndex("templates_waba_id_name_language_unique")
				.on("templates")
				.columns(["waba_id", "name", "language"])
				.unique()
				.execute();

			await db.schema
				.createTable("messages")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("direction", "text", column => column.notNull())
				.addColumn("phone_number_id", "text", column =>
					column.notNull().references("phone_numbers.id").onDelete("cascade"),
				)
				.addColumn("contact_wa_id", "text", column => column.notNull().references("contacts.wa_id").onDelete("cascade"))
				.addColumn("type", "text", column => column.notNull())
				.addColumn("payload", "text", column => column.notNull())
				.addColumn("status", "text", column => column.notNull())
				.addColumn("error", "text")
				.addColumn("reply_to", "text")
				.addColumn("timestamp", "text", column => column.notNull())
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			// The conversation view: every message between one phone number and one contact,
			// oldest first (SPEC §5).
			await db.schema
				.createIndex("messages_conversation_index")
				.on("messages")
				.columns(["phone_number_id", "contact_wa_id", "timestamp"])
				.execute();

			await db.schema
				.createTable("media")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("phone_number_id", "text", column =>
					column.notNull().references("phone_numbers.id").onDelete("cascade"),
				)
				.addColumn("mime_type", "text", column => column.notNull())
				.addColumn("sha256", "text", column => column.notNull())
				.addColumn("file_size", "integer", column => column.notNull())
				.addColumn("storage_key", "text", column => column.notNull())
				.addColumn("url_token", "text", column => column.notNull())
				.addColumn("created_at", "text", column => column.notNull())
				.execute();

			// The token is what `/whaloc-media/:token` looks media up by (SPEC §2.12).
			await db.schema.createIndex("media_url_token_unique").on("media").column("url_token").unique().execute();

			await db.schema
				.createTable("webhook_deliveries")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("event_type", "text", column => column.notNull())
				.addColumn("url", "text", column => column.notNull())
				.addColumn("request_body", "text", column => column.notNull())
				.addColumn("request_headers", "text", column => column.notNull())
				.addColumn("response_status", "integer")
				.addColumn("response_body", "text")
				.addColumn("error", "text")
				.addColumn("attempt", "integer", column => column.notNull())
				.addColumn("duration_ms", "integer")
				.addColumn("created_at", "text", column => column.notNull())
				.execute();

			// The delivery log is always read newest first (SPEC §3).
			await db.schema
				.createIndex("webhook_deliveries_created_at_index")
				.on("webhook_deliveries")
				.columns(["created_at", "id"])
				.execute();
		},
	},

	/**
	 * The registration ladder a phone number walks (SPEC §4): where it is (`status`), whether
	 * its code was confirmed, whether its name was approved, and the code `request_code`
	 * generated while a verification is underway.
	 *
	 * **The defaults are the compatibility contract.** A database migrated from `0001` — and
	 * every row seeding inserts, since `WHALOC_SEED` describes numbers that are already
	 * onboarded — comes out `CONNECTED` / `VERIFIED` / `APPROVED`, so the send gate is open and
	 * nothing an existing consumer does changes behavior. Only a number created through
	 * `POST /{wabaId}/phone_numbers` starts unverified and has to climb.
	 */
	"0002_phone_number_lifecycle": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.alterTable("phone_numbers")
				.addColumn("status", "text", column => column.notNull().defaultTo("CONNECTED"))
				.execute();

			await db.schema
				.alterTable("phone_numbers")
				.addColumn("code_verification_status", "text", column => column.notNull().defaultTo("VERIFIED"))
				.execute();

			await db.schema
				.alterTable("phone_numbers")
				.addColumn("name_status", "text", column => column.notNull().defaultTo("APPROVED"))
				.execute();

			await db.schema.alterTable("phone_numbers").addColumn("verification_code", "text").execute();
			await db.schema.alterTable("phone_numbers").addColumn("verification_code_method", "text").execute();
			await db.schema.alterTable("phone_numbers").addColumn("verification_code_language", "text").execute();
		},
	},

	/**
	 * The two things a WhatsApp account owns besides its numbers and templates (SPEC §2.19–§2.20):
	 * the **business profile** a phone number publishes, and whether an app is **subscribed** to
	 * the WABA's webhooks.
	 *
	 * The profile is one JSON column rather than eight: whaloc stores and echoes it, it is never
	 * queried by field, and Meta adds fields to it between versions. It defaults to `{}` — an
	 * empty profile, which is what a phone number that has never had one reports — so a database
	 * migrated from `0002` needs no backfill and `WHALOC_SEED` stays a description of numbers and
	 * templates only.
	 *
	 * `subscribed_at` is null for "no app subscribed", a timestamp for "subscribed then". A
	 * timestamp rather than a flag because the UI has something to show with it, and because
	 * Meta's own `subscribed_apps` listing is about *when* an app was hooked up.
	 */
	"0003_business_profile_and_subscribed_apps": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.alterTable("phone_numbers")
				.addColumn("business_profile", "text", column => column.notNull().defaultTo("{}"))
				.execute();

			await db.schema.alterTable("wabas").addColumn("subscribed_at", "text").execute();
		},
	},

	/**
	 * Error simulation (SPEC §4): the injection rules a dev arms at runtime, and which registered
	 * bearer tokens the control plane has marked expired.
	 *
	 * Both tables start empty and both are wiped by `POST /api/reset`, so a database migrated
	 * from `0003` behaves exactly as it did: with no rules armed nothing is injected, and with
	 * `WHALOC_TOKENS` unset the token table is never consulted.
	 *
	 * `expired_tokens` stores the token's **derived id**, not the token: whaloc's registry is the
	 * environment variable, and a persisted `whaloc.db` has no business holding a credential.
	 */
	"0004_error_simulation": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.createTable("injection_rules")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("target", "text", column => column.notNull())
				.addColumn("trigger_kind", "text", column => column.notNull())
				.addColumn("trigger_count", "integer")
				.addColumn("preset", "text", column => column.notNull())
				.addColumn("retry_after_seconds", "integer")
				.addColumn("regain_access_minutes", "integer")
				.addColumn("custom", "text")
				.addColumn("seen", "integer", column => column.notNull().defaultTo(0))
				.addColumn("matches", "integer", column => column.notNull().defaultTo(0))
				.addColumn("remaining", "integer")
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			// Rules are evaluated in creation order, and the first one that fires wins.
			await db.schema
				.createIndex("injection_rules_created_at_index")
				.on("injection_rules")
				.columns(["created_at", "id"])
				.execute();

			await db.schema
				.createTable("expired_tokens")
				.addColumn("token_id", "text", column => column.primaryKey())
				.addColumn("expired_at", "text", column => column.notNull())
				.execute();
		},
	},

	/**
	 * The business-scoped user id (BSUID) a contact may also be known by (SPEC §1.15): the
	 * identity `contacts[].user_id`, `messages[].from_user_id` and `recipient_user_id` carry, and
	 * the one a send addressed by `recipient` resolves.
	 *
	 * Nullable, with no backfill and nothing seedable: a contact without one behaves exactly as
	 * it did, and `WHALOC_SEED` stays a description of numbers, contacts and templates. The
	 * unique index is what makes `recipient` resolvable to a single contact — SQLite treats NULLs
	 * as distinct, so every contact *without* a BSUID coexists happily under it.
	 */
	"0005_contact_user_id": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema.alterTable("contacts").addColumn("user_id", "text").execute();

			await db.schema.createIndex("contacts_user_id_unique").on("contacts").column("user_id").unique().execute();
		},
	},

	/**
	 * The Resumable Upload API (SPEC §2.21) and the opaque callback data a send may carry
	 * (SPEC §2.5).
	 *
	 * `upload_sessions` is one row per `POST /{appId}/uploads`, holding both halves of the flow:
	 * how many bytes have arrived (`received_bytes`, which is what `GET /upload:<id>` reports) and,
	 * once the last one has, the **handle** and the storage key behind it. Keeping them in one row
	 * is what makes a handle survive a restart with a file database — the association a template's
	 * `example.header_handle` and a `profile_picture_handle` resolve through is state, not a timer.
	 *
	 * `messages.biz_opaque_callback_data` is nullable with no backfill: a message stored before
	 * this migration carried none, and a status webhook leaves the key off exactly as it did.
	 */
	"0006_uploads_and_biz_opaque_callback_data": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema.alterTable("messages").addColumn("biz_opaque_callback_data", "text").execute();

			await db.schema
				.createTable("upload_sessions")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("app_id", "text", column => column.notNull())
				.addColumn("file_name", "text")
				.addColumn("file_type", "text", column => column.notNull())
				.addColumn("file_length", "integer", column => column.notNull())
				.addColumn("received_bytes", "integer", column => column.notNull().defaultTo(0))
				.addColumn("handle", "text")
				.addColumn("storage_key", "text")
				.addColumn("sha256", "text")
				.addColumn("url_token", "text")
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			// The handle is what a template component and a business profile look an upload up by.
			await db.schema
				.createIndex("upload_sessions_handle_unique")
				.on("upload_sessions")
				.column("handle")
				.unique()
				.execute();

			// …and the token is what `/whaloc-upload/:token` serves its bytes by (SPEC §2.22).
			await db.schema
				.createIndex("upload_sessions_url_token_unique")
				.on("upload_sessions")
				.column("url_token")
				.unique()
				.execute();
		},
	},

	/**
	 * The template definition a `template` send was validated against (SPEC §2.5), frozen on
	 * the message so the UI can render what was delivered rather than whatever the template
	 * says today.
	 *
	 * `messages.template_snapshot` is nullable with no backfill: every other type has nothing to
	 * keep, and a template message stored before this migration never kept one — its template
	 * may have changed since, so reconstructing one would be a guess dressed up as a record.
	 */
	"0007_message_template_snapshot": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema.alterTable("messages").addColumn("template_snapshot", "text").execute();
		},
	},

	/**
	 * mockwa: who a virtual phone plays (SPEC §5, "Virtual Phone"). `role` is a free-form label
	 * (`CUSTOMER`, `TECHNICIAN`, …) and `display_number` the friendly way the phone shows the
	 * number. Neither reaches the Graph surface or a webhook.
	 *
	 * Both nullable with no backfill: a contact without them behaves exactly as before, and the
	 * phone falls back to the profile name and `+<wa_id>`.
	 */
	"0008_contact_role_and_display_number": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema.alterTable("contacts").addColumn("role", "text").execute();
			await db.schema.alterTable("contacts").addColumn("display_number", "text").execute();
		},
	},

	/**
	 * mockwa M2: Meta's webhook model (SPEC §3, "Apps and routing").
	 *
	 * - `apps` holds the apps registered at runtime or through `MOCKWA_APPS`. The app configured
	 *   by `MOCKWA_WEBHOOK_URL`/`MOCKWA_APP_SECRET` is not a row: it is the **default app**, read
	 *   from the environment on every boot, and the other two tables name it by the reserved
	 *   key `default` so a changed `MOCKWA_APP_ID` does not orphan its overrides.
	 * - `webhook_subscriptions` is a registered app's subscription to a WABA, and any app's WABA
	 *   override. The default app's subscription itself stays `wabas.subscribed_at`, unchanged.
	 * - `phone_number_webhook_overrides` is Meta's `webhook_configuration` on a number, per app.
	 * - `webhook_deliveries` learns which app an attempt was for, which chain of attempts it
	 *   belongs to, and when the next attempt is due — the persisted retry queue. Existing rows
	 *   keep `NULL` in all three: they were the default app's, each its own chain, never pending.
	 */
	"0009_webhook_apps_and_retries": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.createTable("apps")
				.addColumn("id", "text", column => column.primaryKey())
				.addColumn("name", "text", column => column.notNull())
				.addColumn("app_secret", "text")
				.addColumn("verify_token", "text")
				.addColumn("callback_url", "text")
				.addColumn("access_token", "text")
				.addColumn("created_at", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();

			// The bearer token is how a Graph call says which app it is (SPEC §2.20).
			await db.schema.createIndex("apps_access_token_unique").on("apps").column("access_token").unique().execute();

			await db.schema
				.createTable("webhook_subscriptions")
				.addColumn("waba_id", "text", column => column.notNull().references("wabas.id").onDelete("cascade"))
				.addColumn("app_key", "text", column => column.notNull())
				.addColumn("override_callback_uri", "text")
				.addColumn("override_verify_token", "text")
				.addColumn("subscribed_at", "text", column => column.notNull())
				.addPrimaryKeyConstraint("webhook_subscriptions_pk", ["waba_id", "app_key"])
				.execute();

			await db.schema
				.createTable("phone_number_webhook_overrides")
				.addColumn("phone_number_id", "text", column =>
					column.notNull().references("phone_numbers.id").onDelete("cascade"),
				)
				.addColumn("app_key", "text", column => column.notNull())
				.addColumn("callback_uri", "text", column => column.notNull())
				.addColumn("verify_token", "text")
				.addColumn("updated_at", "text", column => column.notNull())
				.addPrimaryKeyConstraint("phone_number_webhook_overrides_pk", ["phone_number_id", "app_key"])
				.execute();

			await db.schema.alterTable("webhook_deliveries").addColumn("app_key", "text").execute();
			await db.schema.alterTable("webhook_deliveries").addColumn("chain_id", "text").execute();
			await db.schema.alterTable("webhook_deliveries").addColumn("next_attempt_at", "text").execute();

			await db.schema
				.createIndex("webhook_deliveries_next_attempt_at")
				.on("webhook_deliveries")
				.column("next_attempt_at")
				.execute();
		},
	},

	/**
	 * mockwa M3: the messaging rules (SPEC §4, "Messaging rules").
	 *
	 * - `messages.business_initiated` marks an outbound send that went out while the customer
	 *   service window was closed — what Meta's messaging limit counts. Every existing row reads
	 *   `0`: it was sent before anything counted, so it cannot use up a limit set today.
	 * - `injection_rules.error_code` is the `failed` status a `messages.status` rule produces;
	 *   `NULL` on every rule that targets a Graph route, which is all of the existing ones.
	 */
	"0010_messaging_rules": {
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.alterTable("messages")
				.addColumn("business_initiated", "integer", column => column.notNull().defaultTo(0))
				.execute();
			await db.schema.alterTable("injection_rules").addColumn("error_code", "integer").execute();
		},
	},
	"0011_virtual_clock": {
		// One row at most: where the virtual clock stood and which ID stream was in use, so a
		// restart with a file database resumes both instead of jumping back to the start
		// (SPEC §4, "Virtual clock"). Not a snapshot table: the clock belongs to the instance.
		up: async (db: Kysely<never>): Promise<void> => {
			await db.schema
				.createTable("clock_state")
				.addColumn("id", "integer", column => column.primaryKey())
				.addColumn("now", "text", column => column.notNull())
				.addColumn("id_stream", "text", column => column.notNull())
				.addColumn("updated_at", "text", column => column.notNull())
				.execute();
		},
	},
};

/** Serves {@link MIGRATIONS} to Kysely's `Migrator`. */
export function createMigrationProvider(): MigrationProvider {
	return {
		getMigrations: () => Promise.resolve(MIGRATIONS),
	};
}
