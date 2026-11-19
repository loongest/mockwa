/** Where "now" comes from: the injected scheduler's clock in the running server (SPEC §4, "Virtual clock"). */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

/**
 * Every timestamp whaloc stores is an ISO 8601 string in UTC (see the `Database` interface):
 * sortable as text, readable in a SQLite shell, and ready to serve over the control-plane
 * API. Webhook payloads convert to the Unix seconds Meta uses at emission time (SPEC §1.14).
 * Repositories pass their own clock, so a row stamped while the virtual clock is on carries
 * virtual time.
 */
export function nowIso(clock: Clock = systemClock): string {
	return clock().toISOString();
}
