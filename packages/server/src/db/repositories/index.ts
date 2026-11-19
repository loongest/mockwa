import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";
import { systemClock, type Clock } from "../../timestamps.ts";
import { AppRepository } from "./app-repository.ts";
import { ClockStateRepository } from "./clock-state-repository.ts";
import { ContactRepository } from "./contact-repository.ts";
import { ExpiredTokenRepository } from "./expired-token-repository.ts";
import { InjectionRuleRepository } from "./injection-rule-repository.ts";
import { MediaRepository } from "./media-repository.ts";
import { MessageRepository } from "./message-repository.ts";
import { PhoneNumberRepository } from "./phone-number-repository.ts";
import { SnapshotRepository } from "./snapshot-repository.ts";
import { TemplateRepository } from "./template-repository.ts";
import { UploadSessionRepository } from "./upload-session-repository.ts";
import { WabaRepository } from "./waba-repository.ts";
import { WebhookDeliveryRepository } from "./webhook-delivery-repository.ts";
import { WebhookSubscriptionRepository } from "./webhook-subscription-repository.ts";

export { AppRepository, type AppRecord, type InsertAppInput, type UpdateAppInput } from "./app-repository.ts";
export {
	ContactRepository,
	type ContactRecord,
	type InsertContactInput,
	type UpdateContactInput,
} from "./contact-repository.ts";
export { ClockStateRepository, type ClockStateRecord } from "./clock-state-repository.ts";
export { ExpiredTokenRepository } from "./expired-token-repository.ts";
export {
	InjectionRuleRepository,
	type InjectionRuleRecord,
	type InsertInjectionRuleInput,
	type UpdateInjectionCountersInput,
} from "./injection-rule-repository.ts";
export { MediaRepository, type InsertMediaInput, type MediaRecord } from "./media-repository.ts";
export {
	MessageRepository,
	type ConversationSummary,
	type InsertMessageInput,
	type ListConversationQuery,
	type MessageRecord,
	type TemplateSnapshotRecord,
	type UpdateMessageStatusInput,
} from "./message-repository.ts";
export {
	PhoneNumberRepository,
	type InsertPhoneNumberInput,
	type PendingVerificationRecord,
	type PhoneNumberRecord,
	type UpdatePhoneNumberInput,
} from "./phone-number-repository.ts";
export {
	SnapshotRepository,
	SNAPSHOT_TABLES,
	type SnapshotTableName,
	type SnapshotTables,
} from "./snapshot-repository.ts";
export {
	TemplateRepository,
	type InsertTemplateInput,
	type ListAllTemplatesQuery,
	type ListTemplatesQuery,
	type TemplateFilters,
	type TemplateRecord,
	type UpdateTemplateInput,
} from "./template-repository.ts";
export {
	UploadSessionRepository,
	type InsertUploadSessionInput,
	type UpdateUploadSessionInput,
	type UploadSessionRecord,
} from "./upload-session-repository.ts";
export { WabaRepository, type InsertWabaInput, type UpdateWabaInput, type WabaRecord } from "./waba-repository.ts";
export {
	WebhookDeliveryRepository,
	type InsertWebhookDeliveryInput,
	type ListWebhookDeliveriesQuery,
	type WebhookDeliveryHeaders,
	type WebhookDeliveryRecord,
} from "./webhook-delivery-repository.ts";
export {
	WebhookSubscriptionRepository,
	type PhoneNumberWebhookOverrideRecord,
	type UpsertPhoneNumberWebhookOverrideInput,
	type UpsertWebhookSubscriptionInput,
	type WebhookSubscriptionRecord,
} from "./webhook-subscription-repository.ts";

/** Every repository, injected as one bundle into the domain services (SPEC §8). */
export interface Repositories {
	wabas: WabaRepository;
	phoneNumbers: PhoneNumberRepository;
	contacts: ContactRepository;
	templates: TemplateRepository;
	messages: MessageRepository;
	media: MediaRepository;
	/** Resumable Upload API sessions and the handles they mint (SPEC §2.21). */
	uploadSessions: UploadSessionRepository;
	webhookDeliveries: WebhookDeliveryRepository;
	/** Registered apps (SPEC §3, "Apps and routing"); the default app lives in the config. */
	apps: AppRepository;
	/** WABA subscriptions and the WABA- and number-level webhook overrides. */
	webhookSubscriptions: WebhookSubscriptionRepository;
	/** Error simulation (SPEC §4): armed injection rules, and the tokens marked expired. */
	injectionRules: InjectionRuleRepository;
	expiredTokens: ExpiredTokenRepository;
	/** Whole-database reads and writes, for state export/import (SPEC §5). */
	snapshots: SnapshotRepository;
	/** Where the virtual clock stood (SPEC §4, "Virtual clock"); untouched by a reset and by a snapshot. */
	clockState: ClockStateRepository;
}

/**
 * Empties every table, in an order the foreign keys allow (children first). This is what
 * `POST /api/reset` wipes before the seed is applied again (SPEC §5); the order lives here so
 * that adding a table means updating one list.
 */
export async function deleteAllRows(repositories: Repositories): Promise<void> {
	// Neither of these references anything else, so they go first and the order below is
	// unchanged: a reset disarms every injection rule and revives every expired token (SPEC §4).
	await repositories.injectionRules.deleteAll();
	await repositories.expiredTokens.deleteAll();
	await repositories.webhookDeliveries.deleteAll();
	// Subscriptions and overrides reference WABAs and numbers; apps are referenced by nothing.
	await repositories.webhookSubscriptions.deleteAll();
	await repositories.apps.deleteAll();
	// Nothing references an upload session either: it is reached by handle, from a template's
	// components or a business profile, both of which are about to go too (SPEC §2.21).
	await repositories.uploadSessions.deleteAll();
	await repositories.messages.deleteAll();
	await repositories.media.deleteAll();
	await repositories.templates.deleteAll();
	await repositories.contacts.deleteAll();
	await repositories.phoneNumbers.deleteAll();
	await repositories.wabas.deleteAll();
}

export function createRepositories(db: Kysely<Database>, clock: Clock = systemClock): Repositories {
	return {
		wabas: new WabaRepository(db, clock),
		phoneNumbers: new PhoneNumberRepository(db, clock),
		contacts: new ContactRepository(db, clock),
		templates: new TemplateRepository(db, clock),
		messages: new MessageRepository(db, clock),
		media: new MediaRepository(db, clock),
		uploadSessions: new UploadSessionRepository(db, clock),
		webhookDeliveries: new WebhookDeliveryRepository(db, clock),
		apps: new AppRepository(db, clock),
		webhookSubscriptions: new WebhookSubscriptionRepository(db, clock),
		injectionRules: new InjectionRuleRepository(db, clock),
		expiredTokens: new ExpiredTokenRepository(db, clock),
		snapshots: new SnapshotRepository(db),
		clockState: new ClockStateRepository(db),
	};
}
