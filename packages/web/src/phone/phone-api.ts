import {
	clockResponseSchema,
	conversationMessagesResponseSchema,
	inboundMediaResponseSchema,
	inboundResponseSchema,
	mediaResponseSchema,
	phoneChatListResponseSchema,
	phoneConfigResponseSchema,
	phoneIdentityListResponseSchema,
	phoneReadResponseSchema,
	visitorSessionResponseSchema,
	type ClockState,
	type Contact,
	type ConversationMessagesResponse,
	type InboundRequest,
	type MediaDescriptor,
	type Message,
	type PhoneChat,
	type PhoneMode,
	type VisitorSession,
} from "@wasandbox/shared";
import { z, type output, type ZodType } from "zod";
import { ApiError, queryString, request as rawRequest, type RequestOptions } from "../api/client.ts";
import type { Signal } from "../api/endpoints.ts";

/**
 * The virtual phone's slice of the control plane: `/api/phone` (SPEC §5), and in public mode the
 * visitor's session at `/api/public/session`. The session itself rides in an HttpOnly cookie the
 * page never sees; what the page holds is the CSRF token every write sends back.
 */

/** The CSRF token from the last session read; sent on every write from here on. */
const visitor: { csrfToken: string | undefined } = { csrfToken: undefined };

export function setCsrfToken(token: string | undefined): void {
	visitor.csrfToken = token;
}

function writeHeaders(): Record<string, string> {
	return visitor.csrfToken === undefined ? {} : { "x-csrf-token": visitor.csrfToken };
}

function chatPath(waId: string, phoneNumberId: string): string {
	return `/api/phone/identities/${encodeURIComponent(waId)}/chats/${encodeURIComponent(phoneNumberId)}`;
}

/** The phone's own event socket, which only carries this identity's conversations. */
export function phoneWsUrl(waId: string): string {
	const { protocol, host } = globalThis.location;

	return `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api/phone/identities/${encodeURIComponent(waId)}/ws`;
}

const emptySchema = z.unknown();

/** The two codes a visitor route answers when this browser's demo session is gone (SPEC §5). */
const SESSION_LOST_CODES = new Set(["session_required", "session_expired"]);

const sessionLostListeners = new Set<(code: string) => void>();

/** Called whenever a phone request finds the demo session gone; returns the unsubscribe. */
export function onSessionLost(listener: (code: string) => void): () => void {
	sessionLostListeners.add(listener);

	return () => {
		sessionLostListeners.delete(listener);
	};
}

export function isSessionLost(error: unknown): error is ApiError {
	return error instanceof ApiError && error.status === 401 && SESSION_LOST_CODES.has(error.code ?? "");
}

async function request<TSchema extends ZodType>(
	path: string,
	options: RequestOptions<TSchema>,
): Promise<output<TSchema>> {
	try {
		return await rawRequest(path, options);
	} catch (error) {
		if (isSessionLost(error)) {
			for (const listener of sessionLostListeners) {
				listener(error.code ?? "session_expired");
			}
		}

		throw error;
	}
}

export const phoneApi = {
	async config(options: Signal = {}): Promise<PhoneMode> {
		const { data } = await request("/api/phone/config", { schema: phoneConfigResponseSchema, ...options });

		return data.mode;
	},

	/** The visitor's live session; a 401 (`session_required` / `session_expired`) when there is none. */
	async session(options: Signal = {}): Promise<VisitorSession> {
		const { data } = await rawRequest("/api/public/session", { schema: visitorSessionResponseSchema, ...options });

		setCsrfToken(data.csrfToken);

		return data;
	},

	/** Starts a session, or returns the one this browser already has. */
	async startSession(): Promise<VisitorSession> {
		const { data } = await request("/api/public/session", { method: "POST", schema: visitorSessionResponseSchema });

		setCsrfToken(data.csrfToken);

		return data;
	},

	/** Leaves the demo now: the server removes the visitor's identities and messages. */
	async leaveSession(): Promise<void> {
		await request("/api/public/session", { method: "DELETE", headers: writeHeaders(), schema: emptySchema });
		setCsrfToken(undefined);
	},

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
			headers: writeHeaders(),
			schema: inboundResponseSchema,
		});

		return data;
	},

	async markRead(waId: string, phoneNumberId: string): Promise<number> {
		const { data } = await request(`${chatPath(waId, phoneNumberId)}/read`, {
			method: "POST",
			headers: writeHeaders(),
			schema: phoneReadResponseSchema,
		});

		return data.read;
	},

	/** Uploads an attachment as this phone; the ID it answers goes into an `image`/`document` send. */
	async uploadMedia(waId: string, phoneNumberId: string, file: File): Promise<{ id: string; mimeType: string }> {
		const form = new FormData();

		form.set("file", file);

		if (file.type !== "") {
			form.set("type", file.type);
		}

		const { data } = await request(`${chatPath(waId, phoneNumberId)}/media`, {
			method: "POST",
			form,
			headers: writeHeaders(),
			schema: inboundMediaResponseSchema,
		});

		return { id: data.id, mimeType: data.mimeType };
	},

	/** A media object this phone may see, resolved to a URL on the page's own origin. */
	async media(waId: string, mediaId: string, options: Signal = {}): Promise<MediaDescriptor> {
		const { data } = await request(
			`/api/phone/identities/${encodeURIComponent(waId)}/media/${encodeURIComponent(mediaId)}`,
			{ schema: mediaResponseSchema, ...options },
		);

		return data;
	},

	async clock(options: Signal = {}): Promise<ClockState> {
		const { data } = await request("/api/phone/clock", { schema: clockResponseSchema, ...options });

		return data;
	},
};
