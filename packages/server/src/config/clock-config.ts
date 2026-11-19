import { z } from "zod";

/**
 * The clock settings (SPEC §4, "Virtual clock"; §7). `real` is the default and changes
 * nothing; `virtual` puts every timer and timestamp on a clock the control plane moves.
 */
export const CLOCK_MODES = ["real", "virtual"] as const;

export type ClockMode = (typeof CLOCK_MODES)[number];

/**
 * Where a virtual clock starts when nothing says otherwise. A fixed instant rather than the
 * wall clock, so a fresh instance is the same instance every time.
 */
export const DEFAULT_CLOCK_START = "2026-01-01T00:00:00.000Z";

export interface ClockConfig {
	mode: ClockMode;
	/** Where the virtual clock starts, and where a reset puts it back. Unused by the real clock. */
	start: Date;
}

export const clockModeSchema = z.enum(CLOCK_MODES).default("real");

/** An ISO 8601 instant with an explicit offset (`Z` or `+08:00`), so no host time zone sneaks in. */
export const isoInstantSchema = z.iso
	.datetime({ offset: true, error: "must be an ISO 8601 date-time with a time zone, such as 2026-01-01T00:00:00Z" })
	.transform(value => new Date(value));

export const clockStartSchema = isoInstantSchema.default(new Date(DEFAULT_CLOCK_START));
