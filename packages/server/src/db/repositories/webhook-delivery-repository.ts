import type { Kysely } from "kysely";
import { z } from "zod";
import { nowIso } from "../../timestamps.ts";
import { decodeJsonColumn, encodeJsonColumn } from "../json-column.ts";
import type { Database, WebhookDeliveryTable } from "../schema.ts";

const headersSchema = z.record(z.string(), z.string());

export type WebhookDeliveryHeaders = z.infer<typeof headersSchema>;

export interface WebhookDeliveryRecord {
	id: string;
	eventType: string;
	url: string;
	requestBody: string;
	requestHeaders: WebhookDeliveryHeaders;
	responseStatus: number | null;
	responseBody: string | null;
	error: string | null;
	attempt: number;
	durationMs: number | null;
	createdAt: string;
	/** A registered app's id, `default`, or `null` on rows older than M2 (the default app's). */
	appKey: string | null;
	/** The id of the chain's first attempt; a row older than M2 is its own chain. */
	chainId: string;
	/** When the next retry of this attempt is due, `null` when none is (SPEC §3). */
	nextAttemptAt: string | null;
}

export interface InsertWebhookDeliveryInput {
	id: string;
	eventType: string;
	url: string;
	requestBody: string;
	requestHeaders: WebhookDeliveryHeaders;
	responseStatus?: number | null;
	responseBody?: string | null;
	error?: string | null;
	attempt?: number;
	durationMs?: number | null;
	createdAt?: string;
	appKey?: string | null;
	/** Defaults to the row's own id: a first attempt starts its chain. */
	chainId?: string;
	nextAttemptAt?: string | null;
}

export interface ListWebhookDeliveriesQuery {
	limit?: number;
	/** Exclusive upper bound on `createdAt` — the `before` cursor of the control plane (SPEC §5). */
	before?: string;
}

const DEFAULT_LIST_LIMIT = 50;

function toRecord(row: WebhookDeliveryTable): WebhookDeliveryRecord {
	return {
		id: row.id,
		eventType: row.event_type,
		url: row.url,
		requestBody: row.request_body,
		requestHeaders: decodeJsonColumn(headersSchema, row.request_headers, "webhook_deliveries.request_headers"),
		responseStatus: row.response_status,
		responseBody: row.response_body,
		error: row.error,
		attempt: row.attempt,
		durationMs: row.duration_ms,
		createdAt: row.created_at,
		appKey: row.app_key,
		chainId: row.chain_id ?? row.id,
		nextAttemptAt: row.next_attempt_at,
	};
}

/**
 * The webhook delivery log — every attempt, including retries, is its own row (SPEC §3).
 * An attempt's outcome never changes once inserted; the one mutable column is
 * `next_attempt_at`, which makes the log double as the persisted retry queue: a row with a
 * due time is a retry still owed, and claiming it clears the time before the retry is sent.
 */
export class WebhookDeliveryRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertWebhookDeliveryInput): Promise<WebhookDeliveryRecord> {
		const row = await this.#db
			.insertInto("webhook_deliveries")
			.values({
				id: input.id,
				event_type: input.eventType,
				url: input.url,
				request_body: input.requestBody,
				request_headers: encodeJsonColumn(input.requestHeaders),
				response_status: input.responseStatus ?? null,
				response_body: input.responseBody ?? null,
				error: input.error ?? null,
				attempt: input.attempt ?? 1,
				duration_ms: input.durationMs ?? null,
				created_at: input.createdAt ?? nowIso(),
				app_key: input.appKey ?? null,
				chain_id: input.chainId ?? input.id,
				next_attempt_at: input.nextAttemptAt ?? null,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<WebhookDeliveryRecord | null> {
		const row = await this.#db.selectFrom("webhook_deliveries").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Newest first, the order the delivery log is browsed in. */
	async list(query: ListWebhookDeliveriesQuery = {}): Promise<WebhookDeliveryRecord[]> {
		let builder = this.#db.selectFrom("webhook_deliveries").selectAll();

		if (query.before !== undefined) {
			builder = builder.where("created_at", "<", query.before);
		}

		const rows = await builder
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(query.limit ?? DEFAULT_LIST_LIMIT)
			.execute();

		return rows.map(row => toRecord(row));
	}

	/** Every attempt of one chain, oldest first. */
	async listChain(chainId: string): Promise<WebhookDeliveryRecord[]> {
		const rows = await this.#db
			.selectFrom("webhook_deliveries")
			.selectAll()
			.where(eb => eb.or([eb("chain_id", "=", chainId), eb("id", "=", chainId)]))
			.orderBy("attempt")
			.orderBy("created_at")
			.execute();

		return rows.map(row => toRecord(row));
	}

	/** The earliest pending retry's due time, or `null` when nothing is owed. */
	async nextDueAt(): Promise<string | null> {
		const row = await this.#db
			.selectFrom("webhook_deliveries")
			.select("next_attempt_at")
			.where("next_attempt_at", "is not", null)
			.orderBy("next_attempt_at")
			.limit(1)
			.executeTakeFirst();

		return row?.next_attempt_at ?? null;
	}

	/** Pending retries due at or before `now`, oldest due first. */
	async listDue(now: string, limit = 100): Promise<WebhookDeliveryRecord[]> {
		const rows = await this.#db
			.selectFrom("webhook_deliveries")
			.selectAll()
			.where("next_attempt_at", "is not", null)
			.where("next_attempt_at", "<=", now)
			.orderBy("next_attempt_at")
			.orderBy("id")
			.limit(limit)
			.execute();

		return rows.map(row => toRecord(row));
	}

	/**
	 * Takes a pending retry off the queue. `false` when it was no longer pending — someone else
	 * claimed or cancelled it — so the caller must not send it.
	 */
	async claim(id: string): Promise<boolean> {
		const result = await this.#db
			.updateTable("webhook_deliveries")
			.set({ next_attempt_at: null })
			.where("id", "=", id)
			.where("next_attempt_at", "is not", null)
			.executeTakeFirst();

		return result.numUpdatedRows > 0n;
	}

	/** Cancels every pending retry of an app, or of all apps when `appKey` is omitted. */
	async cancelPending(filter: { appKey?: string; chainId?: string } = {}): Promise<number> {
		let builder = this.#db
			.updateTable("webhook_deliveries")
			.set({ next_attempt_at: null })
			.where("next_attempt_at", "is not", null);

		if (filter.appKey !== undefined) {
			builder = builder.where("app_key", "=", filter.appKey);
		}

		if (filter.chainId !== undefined) {
			const chainId = filter.chainId;

			builder = builder.where(eb => eb.or([eb("chain_id", "=", chainId), eb("id", "=", chainId)]));
		}

		const result = await builder.executeTakeFirst();

		return Number(result.numUpdatedRows);
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("webhook_deliveries").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
