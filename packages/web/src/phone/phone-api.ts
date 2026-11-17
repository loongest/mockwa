import {
	conversationMessagesResponseSchema,
	inboundResponseSchema,
	phoneChatListResponseSchema,
	phoneIdentityListResponseSchema,
	phoneReadResponseSchema,
	type Contact,
	type ConversationMessagesResponse,
	type InboundRequest,
	type Message,
	type PhoneChat,
} from "@mockwa/shared";
import { queryString, request } from "../api/client.ts";
import type { Signal } from "../api/endpoints.ts";

/** The virtual phone's slice of the control plane: `/api/phone` (SPEC §5). */

function chatPath(waId: string, phoneNumberId: string): string {
	return `/api/phone/identities/${encodeURIComponent(waId)}/chats/${encodeURIComponent(phoneNumberId)}`;
}

/** The phone's own event socket, which only carries this identity's conversations. */
export function phoneWsUrl(waId: string): string {
	const { protocol, host } = globalThis.location;

	return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/phone/identities/${encodeURIComponent(waId)}/ws`;
}

export const phoneApi = {
	async identities(options: Signal = {}): Promise<Contact[]> {
		const { data } = await request("/api/phone/identities", { schema: phoneIdentityListResponseSchema, ...options });

		return data;
	},

	async chats(waId: string, options: Signal = {}): Promise<PhoneChat[]> {
		const { data } = await request(`/api/phone/identities/${encodeURIComponent(waId)}/chats`, {
			schema: phoneChatListResponseSchema,
			...options,
		});

		return data;
	},

	messages: async (
		waId: string,
		phoneNumberId: string,
		page: { limit?: number; before?: string } = {},
		options: Signal = {},
	): Promise<ConversationMessagesResponse> => {
		return request(`${chatPath(waId, phoneNumberId)}/messages${queryString({ ...page })}`, {
			schema: conversationMessagesResponseSchema,
			...options,
		});
	},

	/** The path names the sender and the business; the same fields in the body are ignored. */
	async send(waId: string, body: InboundRequest): Promise<Message> {
		const { data } = await request(`${chatPath(waId, body.phoneNumberId)}/messages`, {
			method: "POST",
			body,
			schema: inboundResponseSchema,
		});

		return data;
	},

	async markRead(waId: string, phoneNumberId: string): Promise<number> {
		const { data } = await request(`${chatPath(waId, phoneNumberId)}/read`, {
			method: "POST",
			schema: phoneReadResponseSchema,
		});

		return data.read;
	},
};
