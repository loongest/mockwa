/**
 * A sliding-window counter per key (SPEC §5, "Public demo mode": per session and per IP).
 *
 * In memory on purpose: one process serves the instance, and a limit that forgets on restart is
 * the right failure for a demo — a visitor who was slowed down is not slowed down twice. Time
 * comes from the injected `now`, so the specs move it instead of waiting.
 */
export interface RateLimiterOptions {
	/** Hits allowed per window. */
	limit: number;
	windowMs: number;
	now: () => Date;
}

export interface RateLimitResult {
	allowed: boolean;
	/** Whole seconds until the oldest hit in the window leaves it; 0 when allowed. */
	retryAfterSeconds: number;
}

export class RateLimiter {
	readonly #limit: number;
	readonly #windowMs: number;
	readonly #now: () => Date;
	readonly #hits = new Map<string, number[]>();

	constructor(options: RateLimiterOptions) {
		this.#limit = options.limit;
		this.#windowMs = options.windowMs;
		this.#now = options.now;
	}

	#recent(key: string, now: number): number[] {
		const hits = (this.#hits.get(key) ?? []).filter(at => now - at < this.#windowMs);

		if (hits.length === 0) {
			this.#hits.delete(key);
		} else {
			this.#hits.set(key, hits);
		}

		return hits;
	}

	/** Whether one more hit fits, without counting it. */
	check(key: string): RateLimitResult {
		const now = this.#now().getTime();
		const hits = this.#recent(key, now);

		if (hits.length < this.#limit) {
			return { allowed: true, retryAfterSeconds: 0 };
		}

		const oldest = hits[0] ?? now;

		return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)) };
	}

	/** Counts a hit when it fits; a refused hit is not counted, so waiting is enough to recover. */
	take(key: string): RateLimitResult {
		const result = this.check(key);

		if (result.allowed) {
			const now = this.#now().getTime();

			this.#hits.set(key, [...(this.#hits.get(key) ?? []), now]);
		}

		return result;
	}

	/**
	 * Drops every key whose hits have all left the window. A key is otherwise only tidied when it
	 * is asked about again, and a visitor or an address that never comes back never is: without
	 * this, the map grows with every key it has ever seen.
	 */
	prune(): void {
		const now = this.#now().getTime();

		for (const key of this.#hits.keys()) {
			this.#recent(key, now);
		}
	}

	/** How many keys are held: what {@link prune} keeps bounded. */
	get size(): number {
		return this.#hits.size;
	}

	forget(key: string): void {
		this.#hits.delete(key);
	}

	clear(): void {
		this.#hits.clear();
	}
}
