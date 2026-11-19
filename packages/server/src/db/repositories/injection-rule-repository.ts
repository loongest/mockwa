import {
	injectionCustomResponseSchema,
	messageErrorCodeSchema,
	type InjectionCustomResponse,
	type MessageErrorCode,
	type InjectionPreset,
	type InjectionTarget,
	type InjectionTrigger,
} from "@mockwa/shared";
import type { Kysely } from "kysely";
import { nowIso, systemClock, type Clock } from "../../timestamps.ts";
import { decodeNullableJsonColumn, encodeJsonColumn } from "../json-column.ts";
import type { Database, InjectionRuleTable } from "../schema.ts";

export interface InjectionRuleRecord {
	id: string;
	target: InjectionTarget;
	trigger: InjectionTrigger;
	preset: InjectionPreset;
	retryAfterSeconds: number | null;
	regainAccessMinutes: number | null;
	custom: InjectionCustomResponse | null;
	/** The `failed` status of a `messages.status` rule; `null` for every other target. */
	errorCode: MessageErrorCode | null;
	seen: number;
	matches: number;
	remaining: number | null;
	createdAt: string;
	updatedAt: string;
}

export interface InsertInjectionRuleInput {
	id: string;
	target: InjectionTarget;
	trigger: InjectionTrigger;
	preset: InjectionPreset;
	retryAfterSeconds?: number | undefined;
	regainAccessMinutes?: number | undefined;
	custom?: InjectionCustomResponse | undefined;
	errorCode?: MessageErrorCode | undefined;
	createdAt?: string;
}

/** What one evaluated request writes back: the counters, never the rule's definition. */
export interface UpdateInjectionCountersInput {
	seen: number;
	matches: number;
	remaining: number | null;
}

/** The trigger is three columns on the way in and one discriminated union on the way out. */
function toTrigger(row: InjectionRuleTable): InjectionTrigger {
	switch (row.trigger_kind) {
		case "next": {
			return { kind: "next", count: row.trigger_count ?? 1 };
		}

		case "every": {
			return { kind: "every", nth: row.trigger_count ?? 1 };
		}

		default: {
			return { kind: "always" };
		}
	}
}

function triggerCount(trigger: InjectionTrigger): number | null {
	switch (trigger.kind) {
		case "next": {
			return trigger.count;
		}

		case "every": {
			return trigger.nth;
		}

		default: {
			return null;
		}
	}
}

/** A code the presets no longer list reads as no code, rather than failing the whole listing. */
function toErrorCode(raw: number | null): MessageErrorCode | null {
	const parsed = messageErrorCodeSchema.safeParse(raw);

	return parsed.success ? parsed.data : null;
}

function toRecord(row: InjectionRuleTable): InjectionRuleRecord {
	return {
		id: row.id,
		target: row.target,
		trigger: toTrigger(row),
		preset: row.preset,
		retryAfterSeconds: row.retry_after_seconds,
		regainAccessMinutes: row.regain_access_minutes,
		custom: decodeNullableJsonColumn(injectionCustomResponseSchema, row.custom, "injection_rules.custom"),
		errorCode: toErrorCode(row.error_code),
		seen: row.seen,
		matches: row.matches,
		remaining: row.remaining,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * The error-injection rules (SPEC §4). Rows carry their own counters, which is what makes a
 * `next 3` countdown and an `every 3rd` cadence survive a restart on a file database.
 */
export class InjectionRuleRepository {
	readonly #db: Kysely<Database>;
	readonly #clock: Clock;

	constructor(db: Kysely<Database>, clock: Clock = systemClock) {
		this.#db = db;
		this.#clock = clock;
	}

	async insert(input: InsertInjectionRuleInput): Promise<InjectionRuleRecord> {
		const now = input.createdAt ?? nowIso(this.#clock);
		const row = await this.#db
			.insertInto("injection_rules")
			.values({
				id: input.id,
				target: input.target,
				trigger_kind: input.trigger.kind,
				trigger_count: triggerCount(input.trigger),
				preset: input.preset,
				retry_after_seconds: input.retryAfterSeconds ?? null,
				regain_access_minutes: input.regainAccessMinutes ?? null,
				custom: input.custom === undefined ? null : encodeJsonColumn(input.custom),
				error_code: input.errorCode ?? null,
				seen: 0,
				matches: 0,
				// A `next` rule starts fully armed; the other triggers have nothing to count down.
				remaining: input.trigger.kind === "next" ? input.trigger.count : null,
				created_at: now,
				updated_at: now,
			})
			.returningAll()
			.executeTakeFirstOrThrow();

		return toRecord(row);
	}

	async findById(id: string): Promise<InjectionRuleRecord | null> {
		const row = await this.#db.selectFrom("injection_rules").selectAll().where("id", "=", id).executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	/** Creation order — which is also evaluation order: the first rule that fires wins. */
	async list(): Promise<InjectionRuleRecord[]> {
		const rows = await this.#db.selectFrom("injection_rules").selectAll().orderBy("created_at").orderBy("id").execute();

		return rows.map(row => toRecord(row));
	}

	async updateCounters(id: string, input: UpdateInjectionCountersInput): Promise<InjectionRuleRecord | null> {
		const row = await this.#db
			.updateTable("injection_rules")
			.set({ seen: input.seen, matches: input.matches, remaining: input.remaining, updated_at: nowIso(this.#clock) })
			.where("id", "=", id)
			.returningAll()
			.executeTakeFirst();

		return row === undefined ? null : toRecord(row);
	}

	async deleteById(id: string): Promise<boolean> {
		const result = await this.#db.deleteFrom("injection_rules").where("id", "=", id).executeTakeFirst();

		return Number(result.numDeletedRows) > 0;
	}

	/** Wipes the table; `POST /api/reset` calls it through {@link deleteAllRows}. */
	async deleteAll(): Promise<number> {
		const result = await this.#db.deleteFrom("injection_rules").executeTakeFirst();

		return Number(result.numDeletedRows);
	}
}
