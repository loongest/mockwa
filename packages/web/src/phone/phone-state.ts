import type { Contact, Message } from "@mockwa/shared";
import { readString } from "../lib/json.ts";

/**
 * Where a phone tab is: who it is signed in as and which chat is open. It lives in the query
 * string (`/phone?as=<waId>&chat=<phoneNumberId>`), so each tab is its own phone and a reload
 * or a shared link lands in the same place.
 */
export interface PhoneLocation {
	waId?: string | undefined;
	phoneNumberId?: string | undefined;
}

export function readPhoneLocation(search: string): PhoneLocation {
	const params = new URLSearchParams(search);
	const waId = params.get("as") ?? undefined;

	return waId === undefined ? {} : { waId, phoneNumberId: params.get("chat") ?? undefined };
}

export function phoneSearch(location: PhoneLocation): string {
	const params = new URLSearchParams();

	if (location.waId !== undefined) {
		params.set("as", location.waId);

		if (location.phoneNumberId !== undefined) {
			params.set("chat", location.phoneNumberId);
		}
	}

	const rendered = params.toString();

	return rendered === "" ? "" : `?${rendered}`;
}

/** The number a phone shows for itself: the friendly one when set, else `+<wa_id>`. */
export function displayNumberOf(contact: Contact): string {
	return contact.displayNumber ?? `+${contact.waId}`;
}

/**
 * Folds a pushed message into a thread: replaced in place when it is a status move of one we
 * hold, appended otherwise, and kept oldest first (the server's order).
 */
export function upsertMessage(messages: readonly Message[], message: Message): Message[] {
	const index = messages.findIndex(existing => existing.id === message.id);

	if (index !== -1) {
		return messages.with(index, message);
	}

	return [...messages, message].toSorted((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Whether an open chat has business messages on the phone that nobody has read yet. */
export function hasUnreadBusinessMessages(messages: readonly Message[]): boolean {
	return messages.some(message => message.direction === "outbound" && message.status === "delivered");
}

/** The message a reaction points at, so it renders under its target the way WhatsApp does. */
export function reactionTargetOf(message: Message): string | undefined {
	return message.type === "reaction" ? (readString(message.payload, "reaction", "message_id") ?? undefined) : undefined;
}
