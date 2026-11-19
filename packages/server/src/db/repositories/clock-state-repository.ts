import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

/** The virtual clock's persisted position (SPEC §4, "Virtual clock"). */
export interface ClockStateRecord {
	now: string;
	idStream: string;
}

const ROW_ID = 1;

/**
 * One row, rewritten in place. `updated_at` is wall-clock time on purpose: it records when the
 * row was written, which is a fact about the process, not about the simulated world.
 */
export class ClockStateRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async find(): Promise<ClockStateRecord | null> {
		const row = await this.#db.selectFrom("clock_state").selectAll().where("id", "=", ROW_ID).executeTakeFirst();

		return row === undefined ? null : { now: row.now, idStream: row.id_stream };
	}

	async save(state: ClockStateRecord): Promise<void> {
		const realNow = new Date();
		const updatedAt = realNow.toISOString();

		await this.#db
			.insertInto("clock_state")
			.values({ id: ROW_ID, now: state.now, id_stream: state.idStream, updated_at: updatedAt })
			.onConflict(conflict =>
				conflict.column("id").doUpdateSet({ now: state.now, id_stream: state.idStream, updated_at: updatedAt }),
			)
			.execute();
	}
}
