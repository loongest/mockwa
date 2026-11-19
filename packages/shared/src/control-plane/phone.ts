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

/**
 * `GET /api/phone/config` (SPEC §5): which phone the page has to be. `dev` is the identity
 * picker; `public` is a visitor's own identities behind a session cookie.
 */
export const phoneModeSchema = z.enum(["dev", "public"]);

export type PhoneMode = z.infer<typeof phoneModeSchema>;

export const phoneConfigResponseSchema = z.object({ data: z.object({ mode: phoneModeSchema }) });

export type PhoneConfigResponse = z.infer<typeof phoneConfigResponseSchema>;

/** The limits a visitor works within, so the phone can say them before they bite. */
export const visitorLimitsSchema = z.object({
	sessionTtlSeconds: z.number().int().positive(),
	messagesPerMinute: z.number().int().positive(),
	mediaMaxBytes: z.number().int().positive(),
	mediaPerSession: z.number().int().positive(),
	mediaTypes: z.array(z.string()),
});

export type VisitorLimits = z.infer<typeof visitorLimitsSchema>;

/**
 * `GET`/`POST /api/public/session` (SPEC §5, "Public demo mode"): the visitor's own identities,
 * the CSRF token every write sends back in `X-CSRF-Token`, and when the session ends if it is
 * not used again. The session itself rides in an HttpOnly cookie the page never sees.
 */
export const visitorSessionSchema = z.object({
	identities: z.array(contactSchema),
	csrfToken: z.string().min(1),
	expiresAt: z.iso.datetime(),
	limits: visitorLimitsSchema,
});

export type VisitorSession = z.infer<typeof visitorSessionSchema>;

export const visitorSessionResponseSchema = z.object({ data: visitorSessionSchema });

export type VisitorSessionResponse = z.infer<typeof visitorSessionResponseSchema>;
