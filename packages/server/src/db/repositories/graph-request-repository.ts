import type { Kysely, Selectable } from "kysely";
import type { Database, GraphRequestTable } from "../schema.ts";

/** A Graph request as stored: bodies and headers are already masked JSON text. */
export interface GraphRequestRecord {
	id: number;
	receivedAt: string;
	durationMs: number;
	method: string;
	path: string;
	query: string;
	status: number;
	phoneNumberId: string | null;
	appKey: string | null;
	tokenMasked: string | null;
	errorCode: number | null;
	requestHeaders: string;
	requestBody: string;
	responseBody: string;
}

export type InsertGraphRequestInput = Omit<GraphRequestRecord, "id">;

function fromRow(row: Selectable<GraphRequestTable>): GraphRequestRecord {
	return {
		id: row.id,
		receivedAt: row.received_at,
		durationMs: row.duration_ms,
		method: row.method,
		path: row.path,
		query: row.query,
		status: row.status,
		phoneNumberId: row.phone_number_id,
		appKey: row.app_key,
		tokenMasked: row.token_masked,
		errorCode: row.error_code,
		requestHeaders: row.request_headers,
		requestBody: row.request_body,
		responseBody: row.response_body,
	};
}

/** The Graph request log (SPEC §5, "Graph request log"); bounded by {@link prune}. */
export class GraphRequestRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertGraphRequestInput): Promise<GraphRequestRecord> {
		const row = await this.#db
			.insertInto("graph_requests")
			.values({
				received_at: input.receivedAt,
				duration_ms: input.durationMs,
				method: input.method,
				path: input.path,
				query: input.query,
				status: input.status,
				phone_number_id: input.phoneNumberId,
				app_key: input.appKey,
				token_masked: input.tokenMasked,
				error_code: input.errorCode,
				request_headers: input.requestHeaders,
				request_body: input.requestBody,
				response_body: input.responseBody,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return fromRow(row);
	}

	/** Keeps the newest `keep` rows. Ids only grow, so "newest" is "largest id". */
	async prune(keep: number): Promise<void> {
		const cutoff = await this.#db
			.selectFrom("graph_requests")
			.select("id")
			.orderBy("id", "desc")
			.offset(keep)
			.limit(1)
			.executeTakeFirst();

		if (cutoff !== undefined) {
			await this.#db.deleteFrom("graph_requests").where("id", "<=", cutoff.id).execute();
		}
	}

	/** Newest first; `before` pages backwards by id. */
	async list(query: { limit: number; before?: number | undefined; phoneNumberId?: string | undefined }) {
		let select = this.#db.selectFrom("graph_requests").selectAll().orderBy("id", "desc").limit(query.limit);

		if (query.before !== undefined) {
			select = select.where("id", "<", query.before);
		}

		if (query.phoneNumberId !== undefined) {
			select = select.where("phone_number_id", "=", query.phoneNumberId);
		}

		const rows = await select.execute();

		return rows.map(row => fromRow(row));
	}

	/** Oldest first, for an export. */
	async listAll(): Promise<GraphRequestRecord[]> {
		const rows = await this.#db.selectFrom("graph_requests").selectAll().orderBy("id", "asc").execute();

		return rows.map(row => fromRow(row));
	}

	async findById(id: number): Promise<GraphRequestRecord | null> {
		const row = await this.#db.selectFrom("graph_requests").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : fromRow(row);
	}

	/** Wipes the log; `POST /api/reset` calls it through {@link deleteAllRows}, the console directly. */
	async deleteAll(): Promise<void> {
		await this.#db.deleteFrom("graph_requests").execute();
	}
}
