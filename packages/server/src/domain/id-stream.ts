import { createHash } from "node:crypto";
import { defaultRandomBytes, type RandomBytes } from "./ids.ts";

/**
 * Where generated IDs get their bytes (SPEC §4, "Virtual clock").
 *
 * With the real clock this is `crypto.randomBytes`, as it always was. With the virtual clock
 * it is a **seeded stream**: SHA-256 over the stream key and a block counter, read off in
 * order. Two runs that start from the same key and make the same calls in the same order get
 * the same wamids, media IDs and delivery IDs — which is what lets a scenario run be compared
 * byte for byte with the one before it.
 *
 * The key changes on purpose at three moments, and is recorded in the database so a restart
 * can follow it:
 *
 * - **reset** goes back to the {@link INITIAL_STREAM_KEY}: the same world, the same IDs;
 * - **restart** derives the next key from the stored one, so a resumed instance never replays
 *   IDs it already handed out;
 * - **import** derives one from the snapshot's bytes, so IDs minted afterwards cannot collide
 *   with the imported ones.
 *
 * The stream is shared by every service, so its output depends on the order of the calls. A
 * scenario that waits for each reply before its next step makes the same calls in the same
 * order; traffic that races (an app answering while the clock moves) can interleave
 * differently, and is excluded from the determinism promise.
 */
export interface IdStream {
	/** Pass this to services as their `random`; it always reads the current stream. */
	readonly random: RandomBytes;
	/** The time-ordered IDs' tie-breaker, restarting with the stream (see `createOrderedId`). */
	readonly nextSequence: () => number;
	readonly isDeterministic: boolean;
	/** `null` for the real-random stream. */
	readonly key: string | null;
	/** Starts the stream over from `key`. Ignored by the real-random stream. */
	reseed: (key: string) => void;
}

/** The stream a fresh or reset instance starts from. */
export const INITIAL_STREAM_KEY = "mockwa:ids:0";

const BLOCK_BYTES = 32;
const SEQUENCE_MODULO = 0x1_00_00;

/** A new key derived from an old one and a reason (`restart`, `import:<digest>`). */
export function deriveStreamKey(previous: string, reason: string): string {
	return `mockwa:ids:${createHash("sha256").update(`${previous}\n${reason}`).digest("hex").slice(0, 32)}`;
}

/** `crypto.randomBytes` and a process-wide sequence: the real clock's behavior, unchanged. */
export function createRandomIdStream(): IdStream {
	let sequence = 0;

	return {
		random: defaultRandomBytes,
		nextSequence: () => {
			const current = sequence;

			sequence = (sequence + 1) % SEQUENCE_MODULO;

			return current;
		},
		isDeterministic: false,
		key: null,
		reseed: () => {},
	};
}

class SeededIdStream implements IdStream {
	#key: string;
	#block = 0;
	#buffer = Buffer.alloc(0);
	#sequence = 0;
	readonly isDeterministic = true;

	readonly random: RandomBytes = size => {
		while (this.#buffer.length < size) {
			const block = createHash("sha256")
				.update(`${this.#key}\n${String(this.#block)}`)
				.digest();

			this.#block += 1;
			this.#buffer = Buffer.concat([this.#buffer, block.subarray(0, BLOCK_BYTES)]);
		}

		const bytes = this.#buffer.subarray(0, size);

		this.#buffer = this.#buffer.subarray(size);

		return new Uint8Array(bytes);
	};

	readonly nextSequence = (): number => {
		const current = this.#sequence;

		this.#sequence = (this.#sequence + 1) % SEQUENCE_MODULO;

		return current;
	};

	constructor(key: string) {
		this.#key = key;
	}

	get key(): string {
		return this.#key;
	}

	reseed(key: string): void {
		this.#key = key;
		this.#block = 0;
		this.#buffer = Buffer.alloc(0);
		this.#sequence = 0;
	}
}

export function createSeededIdStream(key: string = INITIAL_STREAM_KEY): IdStream {
	return new SeededIdStream(key);
}
