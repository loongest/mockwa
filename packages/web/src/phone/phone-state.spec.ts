import { describe, expect, it } from "vitest";
import { makeContact, makeMessage } from "../test/factories.ts";
import {
	displayNumberOf,
	hasUnreadBusinessMessages,
	phoneSearch,
	reactionTargetOf,
	readPhoneLocation,
	upsertMessage,
} from "./phone-state.ts";

describe("the phone's location", () => {
	it("round-trips the identity and the open chat through the query string", () => {
		expect(readPhoneLocation("?as=5571990000001&chat=42")).toEqual({ waId: "5571990000001", phoneNumberId: "42" });
		expect(phoneSearch({ waId: "5571990000001", phoneNumberId: "42" })).toBe("?as=5571990000001&chat=42");
		expect(phoneSearch({ waId: "5571990000001" })).toBe("?as=5571990000001");
	});

	it("has no chat without an identity", () => {
		expect(readPhoneLocation("?chat=42")).toEqual({});
		expect(readPhoneLocation("")).toEqual({});
		expect(phoneSearch({ phoneNumberId: "42" })).toBe("");
	});
});

describe("the phone's thread", () => {
	it("replaces a message it holds and appends a new one in time order", () => {
		const first = makeMessage({ id: "wamid.a", timestamp: "2026-08-31T12:00:00.000Z", status: "sent" });
		const second = makeMessage({ id: "wamid.b", timestamp: "2026-08-31T12:00:05.000Z" });
		const early = makeMessage({ id: "wamid.c", timestamp: "2026-08-31T11:59:00.000Z" });

		const delivered = upsertMessage([first, second], { ...first, status: "delivered" });

		expect(delivered.map(message => [message.id, message.status])).toEqual([
			["wamid.a", "delivered"],
			["wamid.b", "accepted"],
		]);
		expect(upsertMessage([first, second], early).map(message => message.id)).toEqual(["wamid.c", "wamid.a", "wamid.b"]);
	});

	it("only counts a delivered business message as waiting to be read", () => {
		expect(hasUnreadBusinessMessages([makeMessage({ status: "sent" })])).toBe(false);
		expect(hasUnreadBusinessMessages([makeMessage({ status: "read" })])).toBe(false);
		expect(hasUnreadBusinessMessages([makeMessage({ direction: "inbound", status: "delivered" })])).toBe(false);
		expect(hasUnreadBusinessMessages([makeMessage({ status: "delivered" })])).toBe(true);
	});

	it("finds the target of a reaction", () => {
		const reaction = makeMessage({ type: "reaction", payload: { reaction: { message_id: "wamid.x", emoji: "👍" } } });

		expect(reactionTargetOf(reaction)).toBe("wamid.x");
		expect(reactionTargetOf(makeMessage())).toBeUndefined();
	});

	it("shows the friendly number, or the wa_id with a plus", () => {
		expect(displayNumberOf(makeContact({ waId: "5571990000001" }))).toBe("+5571990000001");
		expect(displayNumberOf(makeContact({ displayNumber: "+55 71 99000-0001" }))).toBe("+55 71 99000-0001");
	});
});
