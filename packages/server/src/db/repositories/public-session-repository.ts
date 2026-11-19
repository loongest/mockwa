import type { Kysely } from "kysely";
import type { ContactTable, Database } from "../schema.ts";
import type { ContactRecord } from "./contact-repository.ts";

/** One anonymous visitor (SPEC §5, "Public demo mode"); see migration 0014. */
export interface PublicSessionRecord {
	id: string;
	csrfToken: string;
	clientIp: string;
	createdAt: string;
	lastSeenAt: string;
}

export interface NewVisitorIdentity {
	waId: string;
	profileName: string;
	role: string;
}

export interface CreatePublicSessionInput {
	id: string;
	csrfToken: string;
	clientIp: string;
	now: string;
	identities: readonly NewVisitorIdentity[];
}

/** What deleting a session took with it; the bytes are the caller's to remove (storage is not SQL). */
export interface DeletedPublicSession {
	waIds: string[];
	mediaStorageKeys: string[];
}

function toContactRecord(row: ContactTable): ContactRecord {
	return {
		waId: row.wa_id,
		profileName: row.profile_name,
		userId: row.user_id,
		role: row.role,
		displayNumber: row.display_number,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/** Thrown when a drawn `wa_id` was handed out before; the caller draws again. */
export class WaIdTakenError extends Error {
	constructor(waId: string, options?: ErrorOptions) {
		super(`wa_id ${waId} was already allocated`, options);
		this.name = "WaIdTakenError";
	}
}

/**
 * Visitor sessions and what they own (SPEC §5, "Public demo mode"). Every write that creates
 * or removes ownership runs in one transaction, so a session is never left owning half its
 * identities and an identity is never left without the rows that say whose it is.
 */
export class PublicSessionRepository {
	readonly #db: Kysely<Database>;

	constructor(db: Kysely<Database>) {
		this.#db = db;
	}

	/**
	 * The session, its numbers, its contacts and the ownership rows, all or nothing. A number
	 * that was ever allocated before (even by a session long gone) fails the whole insert with
	 * {@link WaIdTakenError}.
	 */
	async create(input: CreatePublicSessionInput): Promise<ContactRecord[]> {
		return this.#db.transaction().execute(async trx => {
			for (const identity of input.identities) {
				const allocated = await trx
					.selectFrom("public_wa_ids")
					.select("wa_id")
					.where("wa_id", "=", identity.waId)
					.executeTakeFirst();
				const existing = await trx
					.selectFrom("contacts")
					.select("wa_id")
					.where("wa_id", "=", identity.waId)
					.executeTakeFirst();

				if (allocated !== undefined || existing !== undefined) {
					throw new WaIdTakenError(identity.waId);
				}
			}

			await trx
				.insertInto("public_sessions")
				.values({
					id: input.id,
					csrf_token: input.csrfToken,
					client_ip: input.clientIp,
					created_at: input.now,
					last_seen_at: input.now,
				})
				.execute();

			const contacts: ContactRecord[] = [];

			for (const [position, identity] of input.identities.entries()) {
				await trx.insertInto("public_wa_ids").values({ wa_id: identity.waId, allocated_at: input.now }).execute();

				const row = await trx
					.insertInto("contacts")
					.values({
						wa_id: identity.waId,
						profile_name: identity.profileName,
						user_id: null,
						role: identity.role,
						display_number: null,
						created_at: input.now,
						updated_at: input.now,
					})
					.returningAll()
					.executeTakeFirstOrThrow();

				await trx
					.insertInto("public_session_identities")
					.values({ wa_id: identity.waId, session_id: input.id, position })
					.execute();
				contacts.push(toContactRecord(row));
			}

			return contacts;
		});
	}

	async findById(id: string): Promise<PublicSessionRecord | null> {
		const row = await this.#db.selectFrom("public_sessions").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined
			? null
			: {
					id: row.id,
					csrfToken: row.csrf_token,
					clientIp: row.client_ip,
					createdAt: row.created_at,
					lastSeenAt: row.last_seen_at,
				};
	}

	async touch(id: string, now: string): Promise<void> {
		await this.#db.updateTable("public_sessions").set({ last_seen_at: now }).where("id", "=", id).execute();
	}

	/** The session's identities, in the template's order. */
	async identities(sessionId: string): Promise<ContactRecord[]> {
		const rows = await this.#db
			.selectFrom("public_session_identities")
			.innerJoin("contacts", "contacts.wa_id", "public_session_identities.wa_id")
			.selectAll("contacts")
			.where("public_session_identities.session_id", "=", sessionId)
			.orderBy("public_session_identities.position")
			.execute();

		return rows.map(row => toContactRecord(row));
	}

	async ownerOf(waId: string): Promise<string | null> {
		const row = await this.#db
			.selectFrom("public_session_identities")
			.select("session_id")
			.where("wa_id", "=", waId)
			.executeTakeFirst();

		return row?.session_id ?? null;
	}

	async addMedia(sessionId: string, mediaId: string): Promise<void> {
		await this.#db.insertInto("public_session_media").values({ session_id: sessionId, media_id: mediaId }).execute();
	}

	async ownsMedia(sessionId: string, mediaId: string): Promise<boolean> {
		const row = await this.#db
			.selectFrom("public_session_media")
			.select("media_id")
			.where("session_id", "=", sessionId)
			.where("media_id", "=", mediaId)
			.executeTakeFirst();

		return row !== undefined;
	}

	async countMedia(sessionId: string): Promise<number> {
		const row = await this.#db
			.selectFrom("public_session_media")
			.select(eb => eb.fn.countAll().as("count"))
			.where("session_id", "=", sessionId)
			.executeTakeFirstOrThrow();

		return Number(row.count);
	}

	async count(): Promise<number> {
		const row = await this.#db
			.selectFrom("public_sessions")
			.select(eb => eb.fn.countAll().as("count"))
			.executeTakeFirstOrThrow();

		return Number(row.count);
	}

	async countByIp(clientIp: string): Promise<number> {
		const row = await this.#db
			.selectFrom("public_sessions")
			.select(eb => eb.fn.countAll().as("count"))
			.where("client_ip", "=", clientIp)
			.executeTakeFirstOrThrow();

		return Number(row.count);
	}

	/** Sessions not seen since `cutoff` (an ISO instant, compared as text like every timestamp here). */
	async listIdleSince(cutoff: string): Promise<string[]> {
		const rows = await this.#db
			.selectFrom("public_sessions")
			.select("id")
			.where("last_seen_at", "<=", cutoff)
			.execute();

		return rows.map(row => row.id);
	}

	/**
	 * Removes a session and everything it owned, in one transaction: its uploads' rows, its
	 * identities (their messages go with them through the foreign key), the windows closed by
	 * hand for them, and the session itself. Seeded contacts, other sessions and the business's
	 * own data are never touched: only rows reached through this session's ownership go.
	 */
	async delete(sessionId: string): Promise<DeletedPublicSession> {
		return this.#db.transaction().execute(async trx => {
			const owned = await trx
				.selectFrom("public_session_identities")
				.select("wa_id")
				.where("session_id", "=", sessionId)
				.execute();
			const media = await trx
				.selectFrom("public_session_media")
				.innerJoin("media", "media.id", "public_session_media.media_id")
				.select(["media.id", "media.storage_key"])
				.where("public_session_media.session_id", "=", sessionId)
				.execute();
			const waIds = owned.map(row => row.wa_id);

			if (media.length > 0) {
				await trx
					.deleteFrom("media")
					.where(
						"id",
						"in",
						media.map(row => row.id),
					)
					.execute();
			}

			if (waIds.length > 0) {
				await trx.deleteFrom("service_window_expiries").where("contact_wa_id", "in", waIds).execute();
				await trx.deleteFrom("contacts").where("wa_id", "in", waIds).execute();
			}

			await trx.deleteFrom("public_sessions").where("id", "=", sessionId).execute();

			return { waIds, mediaStorageKeys: media.map(row => row.storage_key) };
		});
	}

	/**
	 * Contacts on a number once handed to a visitor that no live session owns any more: what a
	 * late reply from the app under test, or an import, can bring back after the visitor left.
	 */
	async listOrphanedVisitorContacts(): Promise<string[]> {
		const rows = await this.#db
			.selectFrom("contacts")
			.innerJoin("public_wa_ids", "public_wa_ids.wa_id", "contacts.wa_id")
			.leftJoin("public_session_identities", "public_session_identities.wa_id", "contacts.wa_id")
			.select("contacts.wa_id")
			.where("public_session_identities.session_id", "is", null)
			.execute();

		return rows.map(row => row.wa_id);
	}

	async deleteContacts(waIds: readonly string[]): Promise<void> {
		if (waIds.length === 0) {
			return;
		}

		await this.#db.transaction().execute(async trx => {
			await trx.deleteFrom("service_window_expiries").where("contact_wa_id", "in", waIds).execute();
			await trx.deleteFrom("contacts").where("wa_id", "in", waIds).execute();
		});
	}

	async isAllocated(waId: string): Promise<boolean> {
		const row = await this.#db.selectFrom("public_wa_ids").select("wa_id").where("wa_id", "=", waId).executeTakeFirst();

		return row !== undefined;
	}

	/** Every session ID, for a reset that must end them all. */
	async listIds(): Promise<string[]> {
		const rows = await this.#db.selectFrom("public_sessions").select("id").execute();

		return rows.map(row => row.id);
	}

	/**
	 * Ends every session, keeping `public_wa_ids`: a reset or an import wipes the contacts the
	 * sessions owned, and a number must still never be handed out twice.
	 */
	async deleteAllSessions(): Promise<void> {
		await this.#db.deleteFrom("public_session_media").execute();
		await this.#db.deleteFrom("public_session_identities").execute();
		await this.#db.deleteFrom("public_sessions").execute();
	}
}
