import type { ClockConfig, ClockMode } from "../config/index.ts";
import type { Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import { ControlPlaneError, controlBadRequest } from "./control-plane-error.ts";
import type { EventPublisher } from "./event-bus.ts";
import { deriveStreamKey, INITIAL_STREAM_KEY, type IdStream } from "./id-stream.ts";
import type { Scheduler } from "./scheduler.ts";
import type { AdvanceResult, VirtualClock } from "./virtual-clock.ts";

/**
 * The control plane's handle on time (SPEC §4, "Virtual clock"; §5 `/api/clock`).
 *
 * One clock per instance. With `WASANDBOX_CLOCK=real` this only reports the wall clock and
 * refuses to move it. With `virtual` it owns the {@link VirtualClock} every service was built
 * with, the ID stream that goes with it, and the clock's persisted position:
 *
 * - **boot** resumes a file database's stored position (pending retries are due against it)
 *   and moves the ID stream on; a fresh database starts at `WASANDBOX_CLOCK_START`;
 * - **reset** drops every pending event and puts the clock back at `WASANDBOX_CLOCK_START`, with
 *   the ID stream back at its start — the same world, the same IDs;
 * - **import** leaves the clock where it is (a snapshot carries no clock) and derives a new ID
 *   stream from the snapshot, so nothing minted afterwards collides with what came in;
 * - time never moves backwards except through a reset or a scenario's start.
 */

export interface ClockEventView {
	sequence: number;
	dueAt: string;
	label: string;
}

export interface ClockView {
	mode: ClockMode;
	now: string;
	/** Where a reset puts the virtual clock; `null` for the real clock. */
	start: string | null;
	/** Waiting events, in the order they will run; `null` for the real clock (it does not list its timers). */
	pending: ClockEventView[] | null;
	/** Whether generated IDs come from the seeded stream. */
	deterministicIds: boolean;
}

export interface ClockMoveView {
	from: string;
	to: string;
	fired: (ClockEventView & { error?: string })[];
	clock: ClockView;
}

export interface ClockServiceOptions {
	config: ClockConfig;
	scheduler: Scheduler;
	/** Present exactly when `config.mode` is `virtual`. */
	virtual: VirtualClock | null;
	ids: IdStream;
	repositories: Repositories;
	logger: Logger;
	/** Told about every move of the virtual clock, so open consoles follow it (`clock.changed`). */
	events?: EventPublisher;
}

function toEventView(event: { sequence: number; dueAt: Date; label: string; error?: string }) {
	return {
		sequence: event.sequence,
		dueAt: event.dueAt.toISOString(),
		label: event.label,
		...(event.error !== undefined && { error: event.error }),
	};
}

export function clockNotVirtual(): ControlPlaneError {
	return new ControlPlaneError("the clock is real time; start WaSandbox with WASANDBOX_CLOCK=virtual to move it", {
		status: 409,
		code: "clock_not_virtual",
	});
}

export class ClockService {
	readonly #config: ClockConfig;
	readonly #scheduler: Scheduler;
	readonly #virtual: VirtualClock | null;
	readonly #ids: IdStream;
	readonly #repositories: Repositories;
	readonly #logger: Logger;
	readonly #events: EventPublisher | undefined;

	constructor(options: ClockServiceOptions) {
		this.#config = options.config;
		this.#scheduler = options.scheduler;
		this.#virtual = options.virtual;
		this.#ids = options.ids;
		this.#repositories = options.repositories;
		this.#logger = options.logger;
		this.#events = options.events;
		this.#virtual?.onMove(async now => this.#save(now));
	}

	#requireVirtual(): VirtualClock {
		if (this.#virtual === null) {
			throw clockNotVirtual();
		}

		return this.#virtual;
	}

	async #save(now: Date): Promise<void> {
		await this.#repositories.clockState.save({ now: now.toISOString(), idStream: this.#ids.key ?? INITIAL_STREAM_KEY });
		this.#events?.publish({ type: "clock.changed", payload: { clock: this.view() } });
	}

	#moveView(result: AdvanceResult): ClockMoveView {
		return {
			from: result.from.toISOString(),
			to: result.to.toISOString(),
			fired: result.fired.map(event => toEventView(event)),
			clock: this.view(),
		};
	}

	get mode(): ClockMode {
		return this.#virtual === null ? "real" : "virtual";
	}

	get isVirtual(): boolean {
		return this.#virtual !== null;
	}

	now(): Date {
		return this.#scheduler.now();
	}

	view(): ClockView {
		return {
			mode: this.mode,
			now: this.#scheduler.now().toISOString(),
			start: this.#virtual === null ? null : this.#config.start.toISOString(),
			pending: this.#virtual?.pending().map(event => toEventView(event)) ?? null,
			deterministicIds: this.#ids.isDeterministic,
		};
	}

	/** Runs every event due within the next `delayMs`, then stops exactly there. */
	async advance(delayMs: number): Promise<ClockMoveView> {
		const clock = this.#requireVirtual();

		return this.#moveView(await clock.advanceBy(delayMs));
	}

	/** Moves forward to `at`, like an advance. Earlier than now is refused: time does not go back. */
	async set(at: Date): Promise<ClockMoveView> {
		const clock = this.#requireVirtual();

		if (at.getTime() < clock.now().getTime()) {
			throw controlBadRequest(
				`the virtual clock is at ${clock.now().toISOString()} and cannot move back to ${at.toISOString()}; ` +
					"POST /api/reset returns it to WASANDBOX_CLOCK_START",
				"clock_backwards",
			);
		}

		return this.#moveView(await clock.advanceTo(at));
	}

	/** Moves to the earliest pending event and runs everything due at that instant. */
	async runNext(): Promise<ClockMoveView> {
		const clock = this.#requireVirtual();

		return this.#moveView(await clock.runNext());
	}

	/**
	 * Boot: a stored position is resumed (the clock does not jump back to the start under a
	 * retry queue that was persisted against it), and the ID stream moves on so a restarted
	 * instance never hands out an ID it handed out before.
	 */
	async restore(): Promise<void> {
		if (this.#virtual === null) {
			return;
		}

		const stored = await this.#repositories.clockState.find();

		if (stored === null) {
			this.#ids.reseed(INITIAL_STREAM_KEY);
			await this.#virtual.reset(this.#config.start);
		} else {
			this.#ids.reseed(deriveStreamKey(stored.idStream, "restart"));
			await this.#virtual.reset(new Date(stored.now));
		}

		this.#logger.info({ now: this.#virtual.now().toISOString(), resumed: stored !== null }, "virtual clock ready");
	}

	/**
	 * Reset (and the start of a scenario): pending events are dropped, the clock goes to `at`
	 * (`WASANDBOX_CLOCK_START` by default) and the ID stream starts over. Callers cancel their own
	 * timers first; this also drops anything they missed.
	 */
	async restart(at: Date = this.#config.start): Promise<void> {
		if (this.#virtual === null) {
			return;
		}

		this.#ids.reseed(INITIAL_STREAM_KEY);
		await this.#virtual.reset(at);
	}

	/** After an import: a fresh ID stream derived from the snapshot; the clock stays put. */
	async afterImport(snapshotDigest: string): Promise<void> {
		if (this.#virtual === null) {
			return;
		}

		this.#ids.reseed(deriveStreamKey(this.#ids.key ?? INITIAL_STREAM_KEY, `import:${snapshotDigest}`));
		await this.#save(this.#virtual.now());
	}
}
