import type { Message, WsEvent } from "@wasandbox/shared";
import { describe, expect, it } from "vitest";
import { isPhoneEvent } from "./phone-events.ts";

const ANA = "5571990000001";
const BRUNO = "5571990000002";

function messageFor(contactWaId: string): Message {
	return { contactWaId } as Message;
}

describe("isPhoneEvent", () => {
	it("keeps a phone to its own messages and typing", () => {
		const created: WsEvent = { type: "message.created", payload: { message: messageFor(ANA) } };
		const status: WsEvent = {
			type: "message.status_changed",
			payload: { message: messageFor(BRUNO), previousStatus: "sent" },
		};
		const typing: WsEvent = {
			type: "typing.changed",
			payload: { typing: { phoneNumberId: "1", contactWaId: ANA, expiresAt: null } },
		};

		expect(isPhoneEvent(created, ANA)).toBe(true);
		expect(isPhoneEvent(created, BRUNO)).toBe(false);
		expect(isPhoneEvent(status, ANA)).toBe(false);
		expect(isPhoneEvent(status, BRUNO)).toBe(true);
		expect(isPhoneEvent(typing, ANA)).toBe(true);
		expect(isPhoneEvent(typing, BRUNO)).toBe(false);
	});

	it("follows a contact that moved to a new number", () => {
		const moved = {
			type: "contact.changed",
			payload: { contact: { waId: BRUNO }, previousWaId: ANA },
		} as WsEvent;

		expect(isPhoneEvent(moved, ANA)).toBe(true);
		expect(isPhoneEvent(moved, BRUNO)).toBe(true);
		expect(isPhoneEvent(moved, "15550000000")).toBe(false);
	});

	it("passes the world-wide changes and drops the developer streams", () => {
		const of = (type: WsEvent["type"]) => ({ type, payload: {} }) as WsEvent;

		for (const type of [
			"template.changed",
			"waba.changed",
			"phone_number.changed",
			"state.reset",
			"state.imported",
		] as const) {
			expect(isPhoneEvent(of(type), ANA)).toBe(true);
		}

		for (const type of ["webhook.delivery", "injection.changed", "token.changed"] as const) {
			expect(isPhoneEvent(of(type), ANA)).toBe(false);
		}
	});
});
