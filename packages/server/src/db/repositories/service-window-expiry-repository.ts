import type { Kysely } from "kysely";
import type { Database } from "../schema.ts";

/** A window closed by hand (SPEC §4, "Messaging rules"): see migration 0012. */
export interface ServiceWindowExpiryRecord {
	phoneNumberId: string;
	contactWaId: string;
	inboundCount: number;
	expiredAt: string;
}

export class ServiceWindowExpiryRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	async find(phoneNumberId: string, contactWaId: string): Promise<ServiceWindowExpiryRecord | null> {
		const row = await this.#db
			.selectFrom("service_window_expiries")
			.selectAll()
			.where("phone_number_id", "=", phoneNumberId)
			.where("contact_wa_id", "=", contactWaId)
			.executeTakeFirst();

		return row === undefined
			? null
			: {
					phoneNumberId: row.phone_number_id,
					contactWaId: row.contact_wa_id,
					inboundCount: row.inbound_count,
					expiredAt: row.expired_at,
				};
	}

	async save(record: ServiceWindowExpiryRecord): Promise<void> {
		await this.#db
			.insertInto("service_window_expiries")
			.values({
				phone_number_id: record.phoneNumberId,
				contact_wa_id: record.contactWaId,
				inbound_count: record.inboundCount,
				expired_at: record.expiredAt,
			})
			.onConflict(conflict => {
				const update = { inbound_count: record.inboundCount, expired_at: record.expiredAt };

				return conflict.columns(["phone_number_id", "contact_wa_id"]).doUpdateSet(update);
			})
			.execute();
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}, an import directly. */
	async deleteAll(): Promise<void> {
		await this.#db.deleteFrom("service_window_expiries").execute();
	}
}
