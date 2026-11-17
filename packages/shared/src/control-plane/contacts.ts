import { z } from "zod";
import { metaIdSchema, userIdSchema, waIdSchema } from "./common.ts";

/** The people on the user side of a conversation (`GET/POST/PATCH /api/contacts`, SPEC §5). */
/** mockwa: a role is a label, not a permission — whatever the scenario calls its people. */
export const contactRoleSchema = z.string().trim().min(1).max(40);
/** mockwa: shown as-is on the virtual phone; digits, spaces, `+`, `-` and parentheses. */
export const contactDisplayNumberSchema = z
	.string()
	.trim()
	.regex(/^\+?[\d\s()-]{1,32}$/, "must be a phone number: digits, spaces, +, - and parentheses");

export const contactSchema = z.object({
	waId: z.string(),
	profileName: z.string(),
	/** The contact's business-scoped user id (SPEC §1.15), `null` when it has none. */
	userId: z.string().nullable(),
	/** mockwa: free-form label the virtual phone shows (`CUSTOMER`, `TECHNICIAN`, …), `null` when unset. */
	role: z.string().nullable(),
	/** mockwa: friendly number the virtual phone shows, `null` = `+<waId>`. */
	displayNumber: z.string().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});

export type Contact = z.infer<typeof contactSchema>;

export const contactListResponseSchema = z.object({ data: z.array(contactSchema) });
export const contactResponseSchema = z.object({ data: contactSchema });

export type ContactListResponse = z.infer<typeof contactListResponseSchema>;
export type ContactResponse = z.infer<typeof contactResponseSchema>;

export const contactCreateRequestSchema = z.object({
	waId: waIdSchema,
	profileName: z.string().min(1),
	/** Optional BSUID: a contact carrying one is what identity traffic is simulated with (the default seed ships one per contact). */
	userId: userIdSchema.optional(),
	role: contactRoleSchema.optional(),
	displayNumber: contactDisplayNumberSchema.optional(),
});

/**
 * `PATCH /api/contacts/:waId` — the profile name and the BSUID are what a user can edit; the
 * `wa_id` is the contact's identity and moves only through the number-change action below.
 * `userId: null` clears the BSUID.
 */
export const contactUpdateRequestSchema = z
	.object({
		profileName: z.string().min(1).optional(),
		userId: userIdSchema.nullable().optional(),
		role: contactRoleSchema.nullable().optional(),
		displayNumber: contactDisplayNumberSchema.nullable().optional(),
	})
	.refine(
		body => [body.profileName, body.userId, body.role, body.displayNumber].some(value => value !== undefined),
		"pass at least one of profileName, userId, role or displayNumber",
	);

/**
 * `POST /api/contacts/:waId/change-number` — the person moved to a new number (SPEC §5).
 *
 * The contact's `wa_id` changes in place, its history follows, and Meta's `user_changed_number`
 * system webhook goes out. Without `phoneNumberId` it goes out for **every** business number that
 * has a conversation with the contact; with one, only for that number.
 */
export const contactNumberChangeRequestSchema = z.object({
	waId: waIdSchema,
	phoneNumberId: metaIdSchema.optional(),
});

export type ContactCreateRequest = z.infer<typeof contactCreateRequestSchema>;
export type ContactUpdateRequest = z.infer<typeof contactUpdateRequestSchema>;
export type ContactNumberChangeRequest = z.infer<typeof contactNumberChangeRequestSchema>;
