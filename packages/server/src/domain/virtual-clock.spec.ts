import { describe, expect, it } from "vitest";
import { VirtualClock } from "./virtual-clock.ts";

const START = new Date("2026-01-01T00:00:00.000Z");

function at(offsetMs: number): string {
	const instant = new Date(START.getTime() + offsetMs);

	return instant.toISOString();
}

/** Lets the clock's "due now" kick (a `setImmediate`) and what it starts run. */
async function nextTicks(count = 3): Promise<void> {
	for (let index = 0; index < count; index += 1) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}

describe("VirtualClock", () => {
	it("stands still until it is moved", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		clock.schedule(
			1000,
			() => {
				ran.push("later");
			},
			"later",
		);
		await nextTicks();

		expect(clock.now().toISOString()).toBe(START.toISOString());
		expect(ran).toEqual([]);
		expect(clock.pending().map(event => event.label)).toEqual(["later"]);
	});

	it("runs the events due within an advance in time order, each at its own due time", async () => {
		const clock = new VirtualClock(START);
		const ran: { label: string; now: string }[] = [];
		const record = (label: string) => {
			return () => {
				ran.push({ label, now: clock.now().toISOString() });
			};
		};

		clock.schedule(240_000, record("4m"), "4m");
		clock.schedule(60_000, record("1m"), "1m");
		clock.schedule(360_000, record("6m"), "6m");
		clock.schedule(300_000, record("5m exactly"), "5m exactly");

		const result = await clock.advanceBy(300_000);

		expect(ran).toEqual([
			{ label: "1m", now: at(60_000) },
			{ label: "4m", now: at(240_000) },
			{ label: "5m exactly", now: at(300_000) },
		]);
		expect(result.fired.map(event => event.label)).toEqual(["1m", "4m", "5m exactly"]);
		expect(result.to.toISOString()).toBe(at(300_000));
		// Beyond the target: still waiting, with its original due time.
		expect(clock.pending().map(event => [event.label, event.dueAt.toISOString()])).toEqual([["6m", at(360_000)]]);
	});

	it("runs events that share a timestamp in the order they were scheduled", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		for (const label of ["a", "b", "c", "d"]) {
			clock.schedule(
				5000,
				() => {
					ran.push(label);
				},
				label,
			);
		}

		await clock.advanceBy(5000);

		expect(ran).toEqual(["a", "b", "c", "d"]);
	});

	it("never runs a cancelled event, and cancelling twice or after firing is harmless", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];
		const kept = clock.schedule(
			1000,
			() => {
				ran.push("kept");
			},
			"kept",
		);
		const cancelled = clock.schedule(
			1000,
			() => {
				ran.push("cancelled");
			},
			"cancelled",
		);

		cancelled.cancel();
		cancelled.cancel();

		const result = await clock.advanceBy(2000);

		kept.cancel();

		expect(ran).toEqual(["kept"]);
		expect(result.fired.map(event => event.label)).toEqual(["kept"]);
		expect(clock.pending()).toEqual([]);
	});

	it("includes events scheduled by callbacks during the advance, and leaves later ones pending", async () => {
		const clock = new VirtualClock(START);
		const ran: { label: string; now: string }[] = [];
		const record = (label: string) => {
			return () => {
				ran.push({ label, now: clock.now().toISOString() });
			};
		};

		clock.schedule(
			1000,
			() => {
				record("first")();
				// Due at the same instant: runs after it, within this advance.
				clock.schedule(0, record("zero-delay follow-up"), "zero-delay follow-up");
				clock.schedule(2000, record("chained +2s"), "chained +2s");
				clock.schedule(60_000, record("chained +60s"), "chained +60s");
			},
			"first",
		);

		const result = await clock.advanceBy(10_000);

		expect(ran).toEqual([
			{ label: "first", now: at(1000) },
			{ label: "zero-delay follow-up", now: at(1000) },
			{ label: "chained +2s", now: at(3000) },
		]);
		expect(result.fired.map(event => event.label)).toEqual(["first", "zero-delay follow-up", "chained +2s"]);
		expect(clock.pending().map(event => [event.label, event.dueAt.toISOString()])).toEqual([
			["chained +60s", at(61_000)],
		]);
	});

	it("waits for the settler after each event, so an advance returns with the work done", async () => {
		const clock = new VirtualClock(START);
		const log: string[] = [];
		let inFlight: Promise<void> | null = null;

		clock.setSettler(async () => {
			await inFlight;
		});
		clock.schedule(
			1000,
			() => {
				inFlight = (async () => {
					await nextTicks(5);
					log.push("background work of the first event");
					// Work that schedules more work, due inside the same advance.
					clock.schedule(
						500,
						() => {
							log.push("scheduled by background work");
						},
						"nested",
					);
				})();
			},
			"first",
		);

		await clock.advanceBy(2000);

		expect(log).toEqual(["background work of the first event", "scheduled by background work"]);
	});

	it("runs an event that is already due on a later tick, without an advance", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		clock.schedule(
			0,
			() => {
				ran.push("now");
			},
			"now",
		);

		expect(ran).toEqual([]);
		await nextTicks();
		expect(ran).toEqual(["now"]);
		expect(clock.now().toISOString()).toBe(START.toISOString());
	});

	it("runs to the next event, and everything due at that same instant", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		clock.schedule(
			7000,
			() => {
				ran.push("b");
			},
			"b",
		);
		clock.schedule(
			5000,
			() => {
				ran.push("a1");
			},
			"a1",
		);
		clock.schedule(
			5000,
			() => {
				ran.push("a2");
			},
			"a2",
		);

		const first = await clock.runNext();

		expect(ran).toEqual(["a1", "a2"]);
		expect(first.to.toISOString()).toBe(at(5000));

		await clock.runNext();
		expect(ran).toEqual(["a1", "a2", "b"]);

		// Nothing pending: the clock stays where it is.
		const idle = await clock.runNext();

		expect(idle.fired).toEqual([]);
		expect(idle.to.toISOString()).toBe(at(7000));
	});

	it("refuses to move backwards", async () => {
		const clock = new VirtualClock(START);

		await clock.advanceBy(1000);

		await expect(clock.advanceTo(START)).rejects.toThrow(/backwards/);
		await expect(clock.advanceBy(-1)).rejects.toThrow(RangeError);
	});

	it("serializes concurrent advances", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		clock.schedule(
			1000,
			() => {
				ran.push("1s");
			},
			"1s",
		);
		clock.schedule(
			3000,
			() => {
				ran.push("3s");
			},
			"3s",
		);

		const [first, second] = await Promise.all([clock.advanceBy(2000), clock.advanceBy(2000)]);

		expect(first.to.toISOString()).toBe(at(2000));
		expect(second.from.toISOString()).toBe(at(2000));
		expect(second.to.toISOString()).toBe(at(4000));
		expect(ran).toEqual(["1s", "3s"]);
	});

	it("reports a callback that throws and carries on with the rest", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];

		clock.schedule(
			1000,
			() => {
				throw new Error("boom");
			},
			"broken",
		);
		clock.schedule(
			2000,
			() => {
				ran.push("after");
			},
			"after",
		);

		const result = await clock.advanceBy(2000);

		expect(result.fired[0]).toMatchObject({ label: "broken", error: "Error: boom" });
		expect(ran).toEqual(["after"]);
	});

	it("drops everything pending on a reset and starts again at the given time", async () => {
		const clock = new VirtualClock(START);
		const ran: string[] = [];
		const moves: string[] = [];

		clock.onMove(now => {
			moves.push(now.toISOString());

			return Promise.resolve();
		});
		clock.schedule(
			1000,
			() => {
				ran.push("dropped");
			},
			"dropped",
		);
		await clock.advanceBy(500);

		await clock.reset(START);
		await clock.advanceBy(5000);

		expect(ran).toEqual([]);
		expect(clock.pending()).toEqual([]);
		expect(moves).toEqual([at(500), START.toISOString(), at(5000)]);
	});

	it("sleeps in virtual time", async () => {
		const clock = new VirtualClock(START);
		let isAwake = false;
		const sleeping = (async () => {
			await clock.sleep(10_000);
			isAwake = true;
		})();

		await clock.advanceBy(9999);
		expect(isAwake).toBe(false);

		await clock.advanceBy(1);
		await sleeping;
		expect(isAwake).toBe(true);
	});
});
