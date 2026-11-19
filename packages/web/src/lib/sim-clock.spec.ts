import { describe, expect, it } from "vitest";
import { formatDayLabel, formatListTime } from "./format.ts";
import { formatRemaining, simulatorNowMs, type ClockSync } from "./sim-clock.tsx";

/** Simulator time in the browser (SPEC §4): the server's clock, never the browser's. */

const BROWSER_NOW = Date.parse("2031-01-01T00:00:00.000Z");

function sync(mode: "real" | "virtual", now: string, syncedAt: number): ClockSync {
	return {
		clock: {
			mode,
			now,
			start: mode === "virtual" ? now : null,
			pending: mode === "virtual" ? [] : null,
			deterministicIds: false,
		},
		syncedAt,
	};
}

describe("simulatorNowMs", () => {
	it("is the browser's clock until the server's has been read", () => {
		expect(simulatorNowMs(null, BROWSER_NOW)).toBe(BROWSER_NOW);
	});

	it("stands still under a virtual clock, whatever the browser's says", () => {
		const virtual = sync("virtual", "2026-06-01T08:00:00.000Z", BROWSER_NOW);

		expect(simulatorNowMs(virtual, BROWSER_NOW + 3_600_000)).toBe(Date.parse("2026-06-01T08:00:00.000Z"));
	});

	it("follows the server's real clock, carried forward by the browser's ticking", () => {
		// The browser is an hour fast; the server's reading wins and only the elapsed time is added.
		const real = sync("real", "2030-12-31T23:00:00.000Z", BROWSER_NOW);

		expect(simulatorNowMs(real, BROWSER_NOW + 5000)).toBe(Date.parse("2030-12-31T23:00:05.000Z"));
	});
});

describe("formatRemaining", () => {
	it.each([
		[0, "0s"],
		[1, "0s"],
		[12_000, "12s"],
		[249_000, "4m 09s"],
		[3 * 3_600_000 + 5 * 60_000, "3h 05m"],
		[86_400_000, "1d 0h"],
		[-5000, "0s"],
	])("%i ms is %s", (ms, text) => {
		expect(formatRemaining(ms)).toBe(text);
	});
});

describe("day labels by simulator time", () => {
	it("calls the virtual clock's day today, not the browser's", () => {
		const simulated = new Date("2026-06-01T12:00:00");

		expect(formatDayLabel("2026-06-01T09:00:00", simulated)).toBe("Today");
		expect(formatDayLabel("2026-05-31T09:00:00", simulated)).toBe("Yesterday");
		expect(formatListTime("2026-05-31T09:00:00", simulated)).toBe("Yesterday");
		expect(formatDayLabel("2026-06-01T09:00:00", new Date(BROWSER_NOW))).not.toBe("Today");
	});
});
