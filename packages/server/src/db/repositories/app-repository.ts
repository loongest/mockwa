import type { Kysely } from "kysely";
import { nowIso } from "../../timestamps.ts";
import type { AppTable, Database } from "../schema.ts";

/** A registered app (SPEC §3, "Apps and routing"). */
export interface AppRecord {
	id: string;
	name: string;
	appSecret: string | null;
	verifyToken: string | null;
	callbackUrl: string | null;
	accessToken: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface InsertAppInput {
	id: string;
	name: string;
	appSecret?: string | null;
	verifyToken?: string | null;
	callbackUrl?: string | null;
	accessToken?: string | null;
	createdAt?: string;
}

/** `null` clears a field; an absent key leaves it as it is. */
export interface UpdateAppInput {
	name?: string;
	appSecret?: string | null;
	verifyToken?: string | null;
	callbackUrl?: string | null;
	accessToken?: string | null;
	updatedAt?: string;
}

function toRecord(row: AppTable): AppRecord {
	return {
		id: row.id,
		name: row.name,
		appSecret: row.app_secret,
		verifyToken: row.verify_token,
		callbackUrl: row.callback_url,
		accessToken: row.access_token,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class AppRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async insert(input: InsertAppInput): Promise<AppRecord> {
		const createdAt = input.createdAt ?? nowIso();
		const row = await this.#db
			.insertInto("apps")
			.values({
				id: input.id,
				name: input.name,
				app_secret: input.appSecret ?? null,
				verify_token: input.verifyToken ?? null,
				callback_url: input.callbackUrl ?? null,
				access_token: input.accessToken ?? null,
				created_at: createdAt,
				updated_at: createdAt,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<AppRecord | null> {
		const row = await this.#db.selectFrom("apps").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async findByAccessToken(token: string): Promise<AppRecord | null> {
		const row = await this.#db.selectFrom("apps").selectAll().where("access_token", "=", token).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async list(): Promise<AppRecord[]> {
		const rows = await this.#db.selectFrom("apps").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	async update(id: string, input: UpdateAppInput): Promise<AppRecord | null> {
		const row = await this.#db
			.updateTable("apps")
			.set({
				...(input.name !== undefined && { name: input.name }),
				...(input.appSecret !== undefined && { app_secret: input.appSecret }),
				...(input.verifyToken !== undefined && { verify_token: input.verifyToken }),
				...(input.callbackUrl !== undefined && { callback_url: input.callbackUrl }),
				...(input.accessToken !== undefined && { access_token: input.accessToken }),
				updated_at: input.updatedAt ?? nowIso(),
			})
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Removes the app with its subscriptions and overrides, which name it without a foreign key. */
	async delete(id: string): Promise<boolean> {
		return this.#db.transaction().execute(async trx => {
			await trx.deleteFrom("webhook_subscriptions").where("app_key", "=", id).execute();
			await trx.deleteFrom("phone_number_webhook_overrides").where("app_key", "=", id).execute();
			const result = await trx.deleteFrom("apps").where("id", "=", id).executeTakeFirst();

			return result.numDeletedRows > 0n;
		});
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("apps").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
