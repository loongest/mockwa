import { conversationId, type PhoneChat } from "@mockwa/shared";
import type { ContactRecord, MessageRecord, Repositories } from "../db/index.ts";
import { controlNotFound } from "./control-plane-error.ts";
import { toMessageDto } from "./control-dto.ts";
import type { StatusLadder } from "./status-ladder.ts";

export interface PhoneServiceOptions {
	repositories: Repositories;
	statusLadder: StatusLadder;
}

export interface PhoneMessagesInput {
	waId: string;
	phoneNumberId: string;
	limit: number;
	/** ISO timestamp to page backwards from, exclusive. */
	before?: string;
}

export interface PhoneMessagesResult {
	/** Oldest first. */
	messages: MessageRecord[];
	before: string | null;
}

/**
 * The virtual phone (SPEC §5): conversations seen from one contact's side. It adds no state of
 * its own — a phone's chats are the message table filtered to its `wa_id`, its sends are
 * ordinary simulated inbound messages, and opening a chat is a manual `read` on the status
 * ladder, so the app under test gets exactly the webhooks a real reader would cause.
 */
export class PhoneService {
	readonly #repositories: Repositories;
	readonly #statusLadder: StatusLadder;

	constructor(options: PhoneServiceOptions) {
		this.#repositories = options.repositories;
		this.#statusLadder = options.statusLadder;
	}

	async #assertPhoneNumber(phoneNumberId: string): Promise<void> {
		if ((await this.#repositories.phoneNumbers.findById(phoneNumberId)) === null) {
			throw controlNotFound(`no phone number with id ${phoneNumberId}`, "unknown_phone_number");
		}
	}

	/** Every contact is an identity a phone can be; the seed's order (by `wa_id`) is kept. */
	async identities(): Promise<ContactRecord[]> {
		return this.#repositories.contacts.list();
	}

	async identity(waId: string): Promise<ContactRecord> {
		const contact = await this.#repositories.contacts.findByWaId(waId);

		if (contact === null) {
			throw controlNotFound(`no contact with wa_id ${waId}`, "unknown_contact");
		}

		return contact;
	}

	/**
	 * One chat per business phone number, the ones with history first (newest activity on top),
	 * then the rest by business name so a fresh identity can still start a conversation.
	 */
	async chats(waId: string): Promise<PhoneChat[]> {
		await this.identity(waId);

		const phoneNumbers = await this.#repositories.phoneNumbers.list();
		const chats: PhoneChat[] = [];

		for (const phoneNumber of phoneNumbers) {
			const [lastMessage] = await this.#repositories.messages.listConversation({
				phoneNumberId: phoneNumber.id,
				contactWaId: waId,
				limit: 1,
			});
			const unread = await this.#repositories.messages.listDeliveredOutbound(phoneNumber.id, waId);

			chats.push({
				id: conversationId(phoneNumber.id, waId),
				phoneNumberId: phoneNumber.id,
				businessName: phoneNumber.verifiedName,
				displayPhoneNumber: phoneNumber.displayPhoneNumber,
				lastMessage: lastMessage === undefined ? null : toMessageDto(lastMessage),
				unreadCount: unread.length,
			});
		}

		return chats.toSorted((a, b) => {
			const byActivity = (b.lastMessage?.timestamp ?? "").localeCompare(a.lastMessage?.timestamp ?? "");

			return byActivity === 0 ? a.businessName.localeCompare(b.businessName) : byActivity;
		});
	}

	async messages(input: PhoneMessagesInput): Promise<PhoneMessagesResult> {
		await this.identity(input.waId);
		await this.#assertPhoneNumber(input.phoneNumberId);

		const messages = await this.#repositories.messages.listConversation({
			phoneNumberId: input.phoneNumberId,
			contactWaId: input.waId,
			limit: input.limit,
			...(input.before !== undefined && { before: input.before }),
		});

		return {
			messages,
			before: messages.length < input.limit ? null : (messages[0]?.timestamp ?? null),
		};
	}

	/**
	 * A message of this conversation, for a reply or a reaction that points at it: one from
	 * another conversation is the same 404 as one that does not exist, so a phone can never
	 * quote or react to a message it cannot see.
	 */
	async conversationMessage(waId: string, phoneNumberId: string, messageId: string): Promise<MessageRecord> {
		const message = await this.#repositories.messages.findById(messageId);

		if (message?.contactWaId !== waId || message.phoneNumberId !== phoneNumberId) {
			throw controlNotFound(`no message with ID ${messageId} in this chat`, "unknown_message");
		}

		return message;
	}

	/**
	 * The identity opened the chat: every delivered business message moves to `read`, each with
	 * its own status webhook, as WhatsApp sends them. A message still on its way (`accepted`,
	 * `sent`) is left alone — it has not reached the phone, so it cannot have been read.
	 */
	async markChatRead(waId: string, phoneNumberId: string): Promise<number> {
		await this.identity(waId);
		await this.#assertPhoneNumber(phoneNumberId);

		const delivered = await this.#repositories.messages.listDeliveredOutbound(phoneNumberId, waId);
		let read = 0;

		for (const message of delivered) {
			if ((await this.#statusLadder.markStatus(message.id, "read")) !== null) {
				read += 1;
			}
		}

		return read;
	}
}
