import { z } from "zod";

/**
 * `/api/clock` (SPEC §4, "Virtual clock"; §5). With `WASANDBOX_CLOCK=virtual` the instance's one
 * clock stands still until one of these moves it; with the default real clock they only report.
 */

const DURATION_PATTERN = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `500ms`, `30s`, `5m`, `24h`, `7d` → milliseconds; `undefined` when it does not parse. */
export function parseDurationMs(value: string): number | undefined {
	const match = DURATION_PATTERN.exec(value.trim());

	return match === null ? undefined : Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** A duration as a string with a unit (`"5m"`) or a whole number of milliseconds. */
export const durationSchema = z.union([
	z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	z.string().transform((value, ctx) => {
		const ms = parseDurationMs(value);

		if (ms === undefined) {
			ctx.addIssue({ code: "custom", message: 'must be a duration such as "500ms", "30s", "5m", "24h" or "7d"' });

			return z.NEVER;
		}

		return ms;
	}),
]);

/** An instant with an explicit offset, so no host time zone sneaks in. */
export const instantSchema = z.iso.datetime({
	offset: true,
	error: "must be an ISO 8601 date-time with a time zone, such as 2026-01-01T09:00:00Z",
});

export const CLOCK_MODES = ["real", "virtual"] as const;

export const clockEventSchema = z.object({
	/** Scheduling order; events due at the same instant run in this order. */
	sequence: z.number().int().nonnegative(),
	dueAt: z.string(),
	/** What the event is: `status delivered <wamid>`, `webhook retry`, `template auto-approve <id>`… */
	label: z.string(),
});

export type ClockEvent = z.infer<typeof clockEventSchema>;

export const clockSchema = z.object({
	mode: z.enum(CLOCK_MODES),
	now: z.string(),
	/** Where a reset puts the virtual clock; `null` for the real clock. */
	start: z.string().nullable(),
	/** Waiting events in the order they will run; `null` for the real clock. */
	pending: z.array(clockEventSchema).nullable(),
	/** Whether generated IDs come from the seeded stream (virtual clock only). */
	deterministicIds: z.boolean(),
});

export type ClockState = z.infer<typeof clockSchema>;

export const clockResponseSchema = z.object({ data: clockSchema });

export type ClockResponse = z.infer<typeof clockResponseSchema>;

/** `POST /api/clock/advance` — `{"by":"5m"}` or `{"by":300000}`. */
export const clockAdvanceRequestSchema = z.object({ by: durationSchema });

export type ClockAdvanceRequest = z.input<typeof clockAdvanceRequestSchema>;

/** `POST /api/clock/set` — forward only; the past is reached through `POST /api/reset`. */
export const clockSetRequestSchema = z.object({ to: instantSchema });

export type ClockSetRequest = z.infer<typeof clockSetRequestSchema>;

export const firedClockEventSchema = clockEventSchema.extend({
	/** The event's callback threw; the advance carried on. */
	error: z.string().optional(),
});

/** What a move did: where it started and ended, and every event it ran, in order. */
export const clockMoveSchema = z.object({
	from: z.string(),
	to: z.string(),
	fired: z.array(firedClockEventSchema),
	clock: clockSchema,
});

export type ClockMove = z.infer<typeof clockMoveSchema>;

export const clockMoveResponseSchema = z.object({ data: clockMoveSchema });

export type ClockMoveResponse = z.infer<typeof clockMoveResponseSchema>;
