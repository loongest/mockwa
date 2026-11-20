import { describe, expect, it } from "vitest";
import {
	ADMIN_FAILURE_WINDOW_MS,
	ADMIN_FAILURES_PER_WINDOW,
	ADMIN_PRUNE_INTERVAL_MS,
	ADMIN_SESSION_TTL_MS,
	AdminSessions,
} from "./access.ts";

/**
 * The admin side's in-memory state (SPEC §5, "Hardening (M7)"): failure windows and cookie
 * sessions are reclaimed in ordinary operation, without the address or browser that left them
 * ever coming back and without anyone signing in.
 */

const TOKEN = "admin-token-0123456789";

function adminsAt(): { admins: AdminSessions; advance: (ms: number) => void } {
	let now = Date.parse("2026-11-20T00:00:00.000Z");
	const admins = new AdminSessions({ token: TOKEN, now: () => new Date(now) });

	return {
		admins,
		advance: ms => {
			now += ms;
		},
	};
}

describe("AdminSessions state", () => {
	it("reclaims the failure records of many addresses once their window passes, without a sign-in", () => {
		const { admins, advance } = adminsAt();

		for (let index = 1; index <= 25; index += 1) {
			admins.recordFailure(`203.0.113.${String(index)}`);
		}

		expect(admins.stateSize.failureAddresses).toBe(25);

		advance(ADMIN_FAILURE_WINDOW_MS + 60_000);

		// Any other check will do: here a different address asking whether it is locked out.
		expect(admins.lockedOutFor("198.51.100.1")).toBe(0);
		expect(admins.stateSize.failureAddresses).toBe(0);

		// And it carries on as before: a new address is counted and locked out as usual.
		for (let index = 0; index < ADMIN_FAILURES_PER_WINDOW; index += 1) {
			admins.recordFailure("198.51.100.2");
		}

		expect(admins.lockedOutFor("198.51.100.2")).toBeGreaterThan(0);
		expect(admins.lockedOutFor("198.51.100.3")).toBe(0);
		expect(admins.stateSize.failureAddresses).toBe(1);
	});

	it("keeps a lockout for the whole window, however many checks run in between", () => {
		const { admins, advance } = adminsAt();

		for (let index = 0; index < ADMIN_FAILURES_PER_WINDOW; index += 1) {
			admins.recordFailure("203.0.113.50");
		}

		for (let minute = 1; minute < ADMIN_FAILURE_WINDOW_MS / 60_000; minute += 1) {
			advance(60_000);
			expect(admins.lockedOutFor("203.0.113.50")).toBeGreaterThan(0);
		}

		advance(60_000);
		expect(admins.lockedOutFor("203.0.113.50")).toBe(0);
	});

	it("reclaims expired cookie sessions without anyone signing in again", () => {
		const { admins, advance } = adminsAt();

		for (let index = 0; index < 5; index += 1) {
			expect(admins.signIn(TOKEN)).not.toBeNull();
		}

		expect(admins.stateSize.sessions).toBe(5);

		advance(ADMIN_SESSION_TTL_MS + 1);
		admins.recordFailure("203.0.113.60");

		expect(admins.stateSize.sessions).toBe(0);
	});

	it("walks its maps at most once per interval", () => {
		const { admins, advance } = adminsAt();

		admins.recordFailure("203.0.113.70");
		advance(ADMIN_FAILURE_WINDOW_MS);

		// The first check after the window reclaims it; one moments later has nothing to do.
		admins.lockedOutFor("203.0.113.71");
		expect(admins.stateSize.failureAddresses).toBe(0);

		admins.recordFailure("203.0.113.72");
		advance(ADMIN_PRUNE_INTERVAL_MS - 1);
		admins.lockedOutFor("203.0.113.73");
		expect(admins.stateSize.failureAddresses).toBe(1);
	});
});
