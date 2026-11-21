import type { ClockState } from "@wasandbox/shared";
import { createContext, use, useEffect, useState } from "react";

/**
 * Simulator time in the browser (SPEC §4, "Virtual clock").
 *
 * Every "now" the UI shows or compares against — a service window's state, "Today" and
 * "Yesterday", a countdown — is the **server's** clock, never the browser's:
 *
 * - **virtual**: the instant `/api/clock` reported, unchanged until a `clock.changed` frame says
 *   it moved. Frozen time stays frozen on screen; nothing here ticks.
 * - **real**: the server's wall clock, carried forward by the browser's own ticking from the
 *   moment it was read, so a browser whose clock is off by minutes still agrees with the server.
 *
 * Before the clock has been read, the browser's clock stands in (real mode is the default).
 */

export interface ClockSync {
	clock: ClockState;
	/** The browser's `Date.now()` when {@link clock} was received. */
	syncedAt: number;
}

/** Simulator time in epoch milliseconds, given what the browser's own clock says. */
export function simulatorNowMs(sync: ClockSync | null, browserNow: number): number {
	if (sync === null) {
		return browserNow;
	}

	const reported = Date.parse(sync.clock.now);

	return sync.clock.mode === "virtual" ? reported : reported + (browserNow - sync.syncedAt);
}

/** The time zone dates are shown in: the browser's, since nothing on the server has one. */
export function displayTimeZone(): string {
	const formatter = new Intl.DateTimeFormat();

	return formatter.resolvedOptions().timeZone;
}

export const SimClockContext = createContext<ClockSync | null>(null);

export function useClockSync(): ClockSync | null {
	return use(SimClockContext);
}

/**
 * The current simulator time, re-rendering every `tickMs` while the clock is real (and whenever
 * the server reports a move). A virtual clock does not tick: the component waits for the server.
 */
export function useSimulatorNow(tickMs = 30_000): number {
	const sync = useClockSync();
	const [browserNow, setBrowserNow] = useState(() => Date.now());
	const isVirtual = sync?.clock.mode === "virtual";

	useEffect(() => {
		// A fresh reading resets the reference point, so the first frame after it is exact.
		setBrowserNow(Date.now());

		if (isVirtual) {
			return;
		}

		const timer = setInterval(() => {
			setBrowserNow(Date.now());
		}, tickMs);

		return () => {
			clearInterval(timer);
		};
	}, [sync, isVirtual, tickMs]);

	return simulatorNowMs(sync, Math.max(browserNow, sync?.syncedAt ?? 0));
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

/** `1d 2h`, `3h 05m`, `4m 09s`, `12s` — how long until something, at a glance. */
export function formatRemaining(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3600);

	if (days > 0) {
		return `${String(days)}d ${String(hours)}h`;
	}

	const minutes = Math.floor((total % 3600) / 60);

	if (hours > 0) {
		return `${String(hours)}h ${pad(minutes)}m`;
	}

	const seconds = total % 60;

	return minutes > 0 ? `${String(minutes)}m ${pad(seconds)}s` : `${String(seconds)}s`;
}
