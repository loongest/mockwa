import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limiter.ts";

describe("RateLimiter", () => {
	function limiter(limit = 2): { limiter: RateLimiter; advance: (ms: number) => void } {
		let now = Date.parse("2026-01-01T00:00:00Z");

		return {
			limiter: new RateLimiter({ limit, windowMs: 60_000, now: () => new Date(now) }),
			advance: ms => {
				now += ms;
			},
		};
	}

	it("allows up to the limit in a window and says when to retry", () => {
		const { limiter: rate, advance } = limiter();

		expect(rate.take("a").allowed).toBe(true);
		advance(10_000);
		expect(rate.take("a").allowed).toBe(true);
		expect(rate.take("a")).toEqual({ allowed: false, retryAfterSeconds: 50 });
		advance(50_000);
		expect(rate.take("a").allowed).toBe(true);
	});

	it("does not count a refused hit", () => {
		const { limiter: rate, advance } = limiter(1);

		rate.take("a");

		for (let attempt = 0; attempt < 5; attempt += 1) {
			expect(rate.take("a").allowed).toBe(false);
		}

		advance(60_000);
		expect(rate.take("a").allowed).toBe(true);
	});

	it("prunes keys that will never be asked about again", () => {
		const { limiter: rate, advance } = limiter();

		for (let key = 0; key < 100; key += 1) {
			rate.take(`visitor-${String(key)}`);
		}

		expect(rate.size).toBe(100);
		advance(30_000);
		rate.prune();
		expect(rate.size).toBe(100);
		advance(30_000);
		rate.prune();
		expect(rate.size).toBe(0);
	});
});
