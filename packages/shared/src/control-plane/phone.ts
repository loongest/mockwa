import { z } from "zod";
import { contactSchema } from "./contacts.ts";
import { messageSchema } from "./messages.ts";

/**
 * The virtual phone (SPEC §5, "Virtual phone"): the same conversations the console shows, seen
 * from one contact's side. An **identity** is a contact; a **chat** is that contact's
 * conversation with one business phone number.
 */
export const phoneIdentityListResponseSchema = z.object({ data: z.array(contactSchema) });

export type PhoneIdentityListResponse = z.infer<typeof phoneIdentityListResponseSchema>;

/**
 * Every business phone number is listed, with or without history, so an identity can start a
 * chat the way a customer opens a business's WhatsApp link.
 */
export const phoneChatSchema = z.object({
	/** The conversation ID, `<phoneNumberId>:<waId>`. */
	id: z.string(),
	phoneNumberId: z.string(),
	businessName: z.string(),
	displayPhoneNumber: z.string(),
	lastMessage: messageSchema.nullable(),
	/** Business messages this identity has not read yet (`sent` or `delivered`). */
	unreadCount: z.number().int().nonnegative(),
});

export type PhoneChat = z.infer<typeof phoneChatSchema>;

export const phoneChatListResponseSchema = z.object({ data: z.array(phoneChatSchema) });

export type PhoneChatListResponse = z.infer<typeof phoneChatListResponseSchema>;

/** `POST …/read`: how many business messages moved to `read`. */
export const phoneReadResponseSchema = z.object({ data: z.object({ read: z.number().int().nonnegative() }) });

export type PhoneReadResponse = z.infer<typeof phoneReadResponseSchema>;
