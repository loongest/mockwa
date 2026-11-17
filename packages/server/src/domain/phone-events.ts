import type { WsEvent } from "@mockwa/shared";

/**
 * Whether a control-plane event belongs on the socket of the phone signed in as `waId`
 * (SPEC §5). A phone sees its own conversations, its own contact row, and the world-wide
 * changes it needs to stay correct (a reset, a business renamed); it never sees another
 * contact's messages, nor the developer-only streams (webhook log, injection rules, tokens).
 */
export function isPhoneEvent(event: WsEvent, waId: string): boolean {
	switch (event.type) {
		case "message.created":
		case "message.status_changed": {
			return event.payload.message.contactWaId === waId;
		}

		case "typing.changed": {
			return event.payload.typing.contactWaId === waId;
		}

		case "contact.changed": {
			return event.payload.contact.waId === waId || event.payload.previousWaId === waId;
		}

		case "template.changed":
		case "waba.changed":
		case "phone_number.changed":
		case "state.reset":
		case "state.imported": {
			return true;
		}

		case "webhook.delivery":
		case "injection.changed":
		case "token.changed": {
			return false;
		}
	}
}
