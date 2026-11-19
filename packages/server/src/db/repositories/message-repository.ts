import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { TEMPLATE_PARAMETER_FORMATS } from "../../config/index.ts";
import {
	decodeJsonColumn,
	decodeNullableJsonColumn,
	encodeJsonColumn,
	jsonObjectArraySchema,
	jsonObjectSchema,
	type JsonObject,
} from "../json-column.ts";
import { nowIso, systemClock, type Clock } from "../../timestamps.ts";
import type { TemplateRecord } from "./template-repository.ts";
import type { Database, MessageDirection, MessageStatus, MessageTable, MessageType } from "../schema.ts";

/** The template a `template` send was validated against, as it stood at send time (SPEC §2.5). */
export type TemplateSnapshotRecord = Pick<TemplateRecord, "parameterFormat" | "components">;

/** The column spells its keys the way the `templates` table does. */
const templateSnapshotColumnSchema = z.object({
	parameter_format: z.enum(TEMPLATE_PARAMETER_FORMATS),
	components: jsonObjectArraySchema,
});

function decodeTemplateSnapshot(raw: string | null): TemplateSnapshotRecord | null {
	const column = decodeNullableJsonColumn(templateSnapshotColumnSchema, raw, "messages.template_snapshot");

	return column === null ? null : { parameterFormat: column.parameter_format, components: column.components };
}

function encodeTemplateSnapshot(snapshot: TemplateSnapshotRecord): string {
	return encodeJsonColumn({ parameter_format: snapshot.parameterFormat, components: snapshot.components });
}

export interface MessageRecord {
	id: string;
	direction: MessageDirection;
	phoneNumberId: string;
	contactWaId: string;
	type: MessageType;
	payload: JsonObject;
	status: MessageStatus;
	error: JsonObject | null;
	replyTo: string | null;
	/** The `biz_opaque_callback_data` of the send, echoed on its status webhooks (SPEC §2.5). */
	bizOpaqueCallbackData: string | null;
	/** What a `template` send was validated against; `null` for anything else (SPEC §2.5). */
	templateSnapshot: TemplateSnapshotRecord | null;
	/** Sent while the customer service window was closed; what the messaging limit counts (SPEC §4). */
	isBusinessInitiated: boolean;
	timestamp: string;
	createdAt: string;
	updatedAt: string;
}

export interface InsertMessageInput {
	id: string;
	direction: MessageDirection;
	phoneNumberId: string;
	contactWaId: string;
	type: MessageType;
	payload: JsonObject;
	status?: MessageStatus;
	replyTo?: string | null;
	bizOpaqueCallbackData?: string | null;
	templateSnapshot?: TemplateSnapshotRecord | null;
	isBusinessInitiated?: boolean;
	/** When the message was sent or received; defaults to now. */
	timestamp?: string;
	createdAt?: string;
}

export interface UpdateMessageStatusInput {
	status: MessageStatus;
	/** Meta's error node for a `failed` status; `null` clears it. */
	error?: JsonObject | null;
	updatedAt?: string;
}

/** One (phone number, contact) pair, aggregated from the messages between them. */
export interface ConversationSummary {
	phoneNumberId: string;
	contactWaId: string;
	messageCount: number;
	lastMessageAt: string;
}

export interface ListConversationQuery {
	phoneNumberId: string;
	contactWaId: string;
	limit?: number;
	/** Exclusive upper bound on `timestamp`, for paging backwards through history. */
	before?: string;
}

const DEFAULT_LIST_LIMIT = 50;

function toRecord(row: MessageTable): MessageRecord {
	return {
		id: row.id,
		direction: row.direction,
		phoneNumberId: row.phone_number_id,
		contactWaId: row.contact_wa_id,
		type: row.type,
		payload: decodeJsonColumn(jsonObjectSchema, row.payload, "messages.payload"),
		status: row.status,
		error: decodeNullableJsonColumn(jsonObjectSchema, row.error, "messages.error"),
		replyTo: row.reply_to,
		bizOpaqueCallbackData: row.biz_opaque_callback_data,
		templateSnapshot: decodeTemplateSnapshot(row.template_snapshot),
		isBusinessInitiated: row.business_initiated === 1,
		timestamp: row.timestamp,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Messages in both directions, the conversation the UI renders (SPEC §5). */
export class MessageRepository {
	readonly #db: Kysely<Database>;
	readonly #clock: Clock;

	constructor(db: Kysely<Database>, clock: Clock = systemClock) {
		this.#db = db;
		this.#clock = clock;
	}

	async insert(input: InsertMessageInput): Promise<MessageRecord> {
		const now = nowIso(this.#clock);
		const createdAt = input.createdAt ?? now;
		const row = await this.#db
			.insertInto("messages")
			.values({
				id: input.id,
				direction: input.direction,
				phone_number_id: input.phoneNumberId,
				contact_wa_id: input.contactWaId,
				type: input.type,
				payload: encodeJsonColumn(input.payload),
				status: input.status ?? "accepted",
				error: null,
				reply_to: input.replyTo ?? null,
				biz_opaque_callback_data: input.bizOpaqueCallbackData ?? null,
				template_snapshot: input.templateSnapshot ? encodeTemplateSnapshot(input.templateSnapshot) : null,
				business_initiated: input.isBusinessInitiated === true ? 1 : 0,
				timestamp: input.timestamp ?? createdAt,
				created_at: createdAt,
				updated_at: createdAt,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<MessageRecord | null> {
		const row = await this.#db.selectFrom("messages").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** One conversation, newest last (SPEC §5). */
	async listConversation(query: ListConversationQuery): Promise<MessageRecord[]> {
		let builder = this.#db
			.selectFrom("messages")
			.selectAll()
			.where("phone_number_id", "=", query.phoneNumberId)
			.where("contact_wa_id", "=", query.contactWaId);

		if (query.before !== undefined) {
			builder = builder.where("timestamp", "<", query.before);
		}

		// Take the newest page, then hand it back oldest first. The tie-break is SQLite's
		// implicit `rowid`, i.e. insertion order: two messages stored in the same millisecond
		// keep the order they arrived in, where the (random) wamid would shuffle them.
		const rows = await builder
			.orderBy("timestamp", "desc")
			.orderBy(sql`rowid`, "desc")
			.limit(query.limit ?? DEFAULT_LIST_LIMIT)
			.execute();

		return rows.toReversed().map(row => toRecord(row));
	}

	/**
	 * The business messages in one conversation that reached the contact's phone and wait to be
	 * read (status `delivered`), oldest first: what the virtual phone counts as unread and marks
	 * read when the chat is open (SPEC §5).
	 */
	async listDeliveredOutbound(phoneNumberId: string, contactWaId: string): Promise<MessageRecord[]> {
		const rows = await this.#db
			.selectFrom("messages")
			.selectAll()
			.where("phone_number_id", "=", phoneNumberId)
			.where("contact_wa_id", "=", contactWaId)
			.where("direction", "=", "outbound")
			.where("status", "=", "delivered")
			.orderBy("timestamp", "asc")
			.orderBy(sql`rowid`, "asc")
			.execute();

		return rows.map(row => toRecord(row));
	}

	/**
	 * The conversation list the UI opens on (SPEC §5): one row per (phone number, contact)
	 * pair that has ever exchanged a message, newest activity first. whaloc stores no
	 * conversation entity — this grouping *is* the conversation.
	 */
	async listConversations(phoneNumberId?: string): Promise<ConversationSummary[]> {
		let builder = this.#db.selectFrom("messages");

		if (phoneNumberId !== undefined) {
			builder = builder.where("phone_number_id", "=", phoneNumberId);
		}

		const rows = await builder
			.select(eb => {
				return [
					"phone_number_id",
					"contact_wa_id",
					eb.fn.countAll().as("message_count"),
					eb.fn.max("timestamp").as("last_message_at"),
				];
			})
			.groupBy(["phone_number_id", "contact_wa_id"])
			.orderBy("last_message_at", "desc")
			.execute();

		return rows.map(row => {
			return {
				phoneNumberId: row.phone_number_id,
				contactWaId: row.contact_wa_id,
				messageCount: Number(row.message_count),
				lastMessageAt: row.last_message_at,
			};
		});
	}

	/**
	 * When the contact last wrote to this number, or `null` if they never have: what opens and
	 * refreshes the customer service window (SPEC §4). Compared as instants rather than as text,
	 * because an inbound may carry a caller-supplied timestamp written with or without
	 * milliseconds.
	 */
	async lastInboundAt(phoneNumberId: string, contactWaId: string): Promise<Date | null> {
		const rows = await this.#db
			.selectFrom("messages")
			.select("timestamp")
			.where("phone_number_id", "=", phoneNumberId)
			.where("contact_wa_id", "=", contactWaId)
			.where("direction", "=", "inbound")
			.execute();
		let latest: number | null = null;

		for (const row of rows) {
			const at = Date.parse(row.timestamp);

			if (Number.isFinite(at) && (latest === null || at > latest)) {
				latest = at;
			}
		}

		return latest === null ? null : new Date(latest);
	}

	/**
	 * The contacts that business-initiated sends from these numbers have reached after `since`
	 * — Meta's messaging limit counts unique users, not messages (SPEC §4). A `failed` send
	 * reached nobody, so it does not count, and one exactly `since` old has left the period.
	 */
	async listBusinessInitiatedRecipients(phoneNumberIds: readonly string[], since: Date): Promise<string[]> {
		if (phoneNumberIds.length === 0) {
			return [];
		}

		const rows = await this.#db
			.selectFrom("messages")
			.select("contact_wa_id")
			.distinct()
			.where("phone_number_id", "in", phoneNumberIds)
			.where("direction", "=", "outbound")
			.where("business_initiated", "=", 1)
			.where("status", "!=", "failed")
			.where("created_at", ">", since.toISOString())
			.execute();

		return rows.map(row => row.contact_wa_id);
	}

	/** Advances a message along the status ladder (SPEC §4). */
	async updateStatus(id: string, input: UpdateMessageStatusInput): Promise<MessageRecord | null> {
		const row = await this.#db
			.updateTable("messages")
			.set({
				status: input.status,
				...(input.error !== undefined && { error: input.error === null ? null : encodeJsonColumn(input.error) }),
				updated_at: input.updatedAt ?? nowIso(this.#clock),
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("messages").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
