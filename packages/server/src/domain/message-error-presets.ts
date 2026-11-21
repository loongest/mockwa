import { MESSAGE_ERROR_CODES, type MessageErrorCode } from "@wasandbox/shared";
import type { JsonObject } from "../db/index.ts";

/**
 * The failures a `failed` status can carry (SPEC §4). Nothing fails on its own in whaloc —
 * a user picks one of these from the UI or the control plane, and the webhook goes out with
 * Meta's `errors[]` node shaped exactly like the `status-failed` fixture.
 *
 * Titles and details are Meta's own wording for these codes; the `href` is the one Meta puts
 * on every messaging error.
 */

/** Same documentation link Meta attaches to messaging errors. */
export const ERROR_DOCS_HREF = "/documentation/business-messaging/whatsapp/support/error-codes";

export interface MessageErrorPreset {
	code: MessageErrorCode;
	title: string;
	message: string;
	details: string;
}

export const MESSAGE_ERROR_PRESETS: Record<MessageErrorCode, MessageErrorPreset> = {
	131_049: {
		code: 131_049,
		title: "This message was not delivered to maintain healthy ecosystem engagement.",
		message: "This message was not delivered to maintain healthy ecosystem engagement.",
		details: "In order to maintain a healthy ecosystem engagement, the message failed to be delivered.",
	},
	131_026: {
		code: 131_026,
		title: "Message undeliverable",
		message: "Message undeliverable",
		details:
			"Unable to deliver message. Reasons can include: the recipient phone number is not a WhatsApp phone number, the recipient has not accepted our new Terms of Service and Privacy Policy, or the recipient is using an old WhatsApp version.",
	},
	131_047: {
		code: 131_047,
		title: "Re-engagement message",
		message: "Re-engagement message",
		details: "More than 24 hours have passed since the recipient last replied to the sender number.",
	},
	130_472: {
		code: 130_472,
		title: "User's number is part of an experiment",
		message: "User's number is part of an experiment",
		details:
			"Message failed to send because this user's phone number is part of an experiment. Learn more in the documentation.",
	},
	// 131048 and 131000: Meta's error-code reference gives these a description only, so the
	// description is the title as well, the way the 131049 fixture repeats its own.
	131_048: {
		code: 131_048,
		title:
			"Message failed to send because there are restrictions on how many messages can be sent from this phone number.",
		message:
			"Message failed to send because there are restrictions on how many messages can be sent from this phone number.",
		details:
			"Message failed to send because there are restrictions on how many messages can be sent from this phone number.",
	},
	131_000: {
		code: 131_000,
		title: "Message failed to send due to an unknown error.",
		message: "Message failed to send due to an unknown error.",
		details: "Message failed to send due to an unknown error.",
	},
};

/** The preset a manual `failed` transition uses when the caller does not pick one. */
export const DEFAULT_MESSAGE_ERROR_CODE: MessageErrorCode = 131_049;

export function messageErrorPreset(code: MessageErrorCode = DEFAULT_MESSAGE_ERROR_CODE): MessageErrorPreset {
	return MESSAGE_ERROR_PRESETS[code];
}

/** The `errors[]` node of a `failed` status, and what is stored in `messages.error`. */
export function messageErrorNode(preset: MessageErrorPreset): JsonObject {
	return {
		code: preset.code,
		title: preset.title,
		message: preset.message,
		error_data: { details: preset.details },
		href: ERROR_DOCS_HREF,
	};
}

/**
 * WaSandbox's own code for a send over the messaging limit (SPEC §4, "Messaging rules"). Meta
 * documents the limit but no error code for exceeding it, so this one is deliberately outside
 * Meta's numbering and says in its own text that WaSandbox made it up: an app must never learn to
 * key behavior on it as if Meta sent it.
 */
export const SIMULATED_MESSAGING_LIMIT_CODE = 990_001;

/** Why an accepted send ends `failed`: one of Meta's codes, or WaSandbox's messaging-limit one. */
export type SendFailure = MessageErrorCode | typeof SIMULATED_MESSAGING_LIMIT_CODE;

const SIMULATED_MESSAGING_LIMIT_DETAILS =
	"Simulated by WaSandbox: this business has reached its messaging limit of unique users in a moving 24 hours. " +
	"Meta documents the limit but no error code for exceeding it, so this code is WaSandbox's own.";

/** The `errors[]` node a {@link SendFailure} puts on its `failed` status. */
export function sendFailureNode(failure: SendFailure): JsonObject {
	if (failure !== SIMULATED_MESSAGING_LIMIT_CODE) {
		return messageErrorNode(messageErrorPreset(failure));
	}

	return {
		code: SIMULATED_MESSAGING_LIMIT_CODE,
		title: "[WaSandbox] Messaging limit reached (simulated)",
		message: "[WaSandbox] Messaging limit reached (simulated)",
		error_data: { details: SIMULATED_MESSAGING_LIMIT_DETAILS },
		href: "/documentation/business-messaging/whatsapp/messaging-limits",
	};
}

/** Every preset, for the UI's error picker. */
export function listMessageErrorPresets(): MessageErrorPreset[] {
	return MESSAGE_ERROR_CODES.map(code => MESSAGE_ERROR_PRESETS[code]);
}
