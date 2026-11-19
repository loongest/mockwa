import type { ScheduledTask, Scheduler } from "./scheduler.ts";

/**
 * The virtual clock (SPEC §4, "Virtual clock"): a {@link Scheduler} whose time stands still
 * until the control plane moves it.
 *
 * - **Order.** Events run by due time; events due at the same instant run in the order they
 *   were scheduled. Nothing else decides, so two runs of the same steps fire the same events
 *   in the same order.
 * - **"Now" while an event runs is the event's own due time**, so everything it stamps — a
 *   status webhook's `timestamp`, a retry's next due time — reads the instant it was due at,
 *   not the instant the advance was asked for.
 * - **Events scheduled during an advance** are part of it when they fall due before its
 *   target; a zero delay runs after the events already due at that instant.
 * - **Events already due run without an advance.** A zero delay (the `sent` rung) still runs
 *   on a later tick, as with the real clock — only the future waits for the clock to move.
 * - **An advance starts by settling** the work already in flight, at the current time, and
 *   **is complete** when every event due up to the target has run *and* the work each one
 *   started has settled ({@link VirtualClock.setSettler}: the background tasks and the
 *   webhook retry pass), so a caller can assert on the state as soon as the call returns.
 *
 * Clock operations run one at a time; a second advance waits for the first.
 */

export interface VirtualClockEvent {
	/** Scheduling order; breaks ties between events due at the same instant. */
	sequence: number;
	dueAt: Date;
	label: string;
}

export interface FiredClockEvent extends VirtualClockEvent {
	/** Set when the event's callback threw; the advance carries on regardless. */
	error?: string;
}

export interface AdvanceResult {
	from: Date;
	to: Date;
	/** Every event that ran, in the order it ran. */
	fired: FiredClockEvent[];
}

interface Entry {
	sequence: number;
	dueAt: number;
	label: string;
	task: () => void;
}

/** What an event is called when whoever scheduled it gave no label. */
const DEFAULT_LABEL = "timer";

function describe(error: unknown): string {
	return Error.isError(error) ? `${error.name}: ${error.message}` : String(error);
}

function toEvent(entry: Entry): VirtualClockEvent {
	return { sequence: entry.sequence, dueAt: new Date(entry.dueAt), label: entry.label };
}

/** Index at which an entry keeps the queue sorted by due time, then by sequence. */
function insertionIndex(queue: readonly Entry[], entry: Entry): number {
	let low = 0;
	let high = queue.length;

	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		const other = queue[middle]!;
		const isBefore = other.dueAt < entry.dueAt || (other.dueAt === entry.dueAt && other.sequence < entry.sequence);

		if (isBefore) {
			low = middle + 1;
		} else {
			high = middle;
		}
	}

	return low;
}

export class VirtualClock implements Scheduler {
	#now: number;
	#sequence = 0;
	readonly #queue: Entry[] = [];
	#settle: () => Promise<void> = async () => {};
	#tail: Promise<unknown> = Promise.resolve();
	#isKickPending = false;
	#onMove: ((now: Date) => Promise<void>) | null = null;

	constructor(start: Date) {
		this.#now = start.getTime();
	}

	async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const previous = this.#tail;
		const result = (async () => {
			await previous;

			return operation();
		})();

		this.#tail = (async () => {
			try {
				await result;
			} catch {
				// The caller of this operation gets the error; the next one only waits its turn.
			}
		})();

		return result;
	}

	/** Due events that need no advance (a zero delay) run on a later tick, in order. */
	#kick(): void {
		if (this.#isKickPending) {
			return;
		}

		this.#isKickPending = true;
		setImmediate(() => {
			this.#isKickPending = false;
			void this.#exclusive(async () => this.#runUntil(this.#now));
		});
	}

	async #runUntil(targetMs: number): Promise<AdvanceResult> {
		const from = this.now();
		const fired: FiredClockEvent[] = [];

		// Work already in flight (a webhook a send just started) finishes at the time it began,
		// before the clock moves past it.
		await this.#settle();

		for (;;) {
			const next = this.#queue[0];

			if (next !== undefined && next.dueAt <= targetMs) {
				// The queue is sorted, so the next event is always at the front.
				// eslint-disable-next-line unicorn/no-array-front-mutation
				this.#queue.shift();
				this.#now = Math.max(this.#now, next.dueAt);
				fired.push(this.#fire(next));
				await this.#settle();
				continue;
			}

			if (this.#now >= targetMs) {
				break;
			}

			// Nothing else is due before the target: arrive there, and let anything that arrival
			// sets off (nothing, usually) settle before looking again.
			this.#now = targetMs;
			await this.#settle();
		}

		if (this.#now !== from.getTime()) {
			await this.#onMove?.(this.now());
		}

		return { from, to: this.now(), fired };
	}

	#fire(entry: Entry): FiredClockEvent {
		const event: FiredClockEvent = toEvent(entry);

		try {
			entry.task();
		} catch (error) {
			event.error = describe(error);
		}

		return event;
	}

	schedule(delayMs: number, task: () => void, label: string = DEFAULT_LABEL): ScheduledTask {
		const entry: Entry = {
			sequence: this.#sequence,
			dueAt: this.#now + Math.max(0, delayMs),
			label,
			task,
		};

		this.#sequence += 1;
		this.#queue.splice(insertionIndex(this.#queue, entry), 0, entry);

		if (entry.dueAt <= this.#now) {
			this.#kick();
		}

		return {
			cancel: () => {
				const index = this.#queue.indexOf(entry);

				if (index !== -1) {
					this.#queue.splice(index, 1);
				}
			},
		};
	}

	async sleep(delayMs: number): Promise<void> {
		await new Promise<void>(resolve => {
			this.schedule(delayMs, resolve, "sleep");
		});
	}

	now(): Date {
		return new Date(this.#now);
	}

	/** The events still waiting, in the order they will run. */
	pending(): VirtualClockEvent[] {
		return this.#queue.map(entry => toEvent(entry));
	}

	/** What an advance waits for after each event (the background work it started). */
	setSettler(settle: () => Promise<void>): void {
		this.#settle = settle;
	}

	/** Called with the new time whenever the clock moves; how the position is persisted. */
	onMove(listener: (now: Date) => Promise<void>): void {
		this.#onMove = listener;
	}

	/** Moves to `target`, running every event due up to and including it. Never backwards. */
	async advanceTo(target: Date): Promise<AdvanceResult> {
		return this.#exclusive(async () => {
			const targetMs = target.getTime();

			if (Number.isNaN(targetMs) || targetMs < this.#now) {
				throw new RangeError("the virtual clock cannot move backwards");
			}

			return this.#runUntil(targetMs);
		});
	}

	async advanceBy(delayMs: number): Promise<AdvanceResult> {
		if (!Number.isFinite(delayMs) || delayMs < 0) {
			throw new RangeError("an advance must be zero or more milliseconds");
		}

		return this.#exclusive(async () => this.#runUntil(this.#now + delayMs));
	}

	/**
	 * Moves to the earliest pending event and runs everything due at that instant (and what
	 * those schedule for the same instant). With nothing pending, the clock stays put.
	 */
	async runNext(): Promise<AdvanceResult> {
		return this.#exclusive(async () => {
			const next = this.#queue[0];

			return this.#runUntil(next === undefined ? this.#now : Math.max(next.dueAt, this.#now));
		});
	}

	/**
	 * Drops every pending event and puts the clock at `start` — a reset. Waits for a clock
	 * operation in progress to finish first, so a reset never cuts an advance in half.
	 */
	async reset(start: Date): Promise<void> {
		await this.#exclusive(async () => {
			this.#queue.length = 0;
			this.#now = start.getTime();
			await this.#onMove?.(this.now());
		});
	}
}
