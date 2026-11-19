import {
	contactDisplayNumberSchema,
	contactRoleSchema,
	durationSchema,
	injectionRuleCreateRequestSchema,
	instantSchema,
	userIdSchema,
} from "@mockwa/shared";
import { z } from "zod";
import { seedWabaSchema } from "./seed.ts";
import { seedAppSchema } from "./webhook-config.ts";

/**
 * The scenario file (SPEC §4, "Scenarios"): a seed with people, apps, failure rules and a clock
 * in it, plus the steps a repeatable simulator test takes. `POST /api/scenarios/run` and
 * `mockwa scenario run` both validate against this one schema.
 *
 * Everything is referred to the way a person writes a test: an identity by its `waId` or its
 * name, a business number by its ID, its display number or its verified name, a WABA by its ID
 * or its name, an app by its ID or its name.
 */

/** How long an `expect` waits for what it describes, in real time, unless it says otherwise. */
export const DEFAULT_EXPECT_WITHIN_MS = 5000;
/** The longest wait an `expect` may ask for: a scenario must not hang a CI job. */
export const MAX_EXPECT_WITHIN_MS = 60_000;

const refSchema = z.string().trim().min(1);

const identitySchema = z.object({
	waId: z.string().regex(/^\d{1,20}$/, "must be a string of 1-20 digits"),
	name: z.string().min(1),
	/** `CUSTOMER`, `TECHNICIAN`…: shown by the virtual phone, never sent to the app. */
	role: contactRoleSchema.optional(),
	userId: userIdSchema.optional(),
	displayNumber: contactDisplayNumberSchema.optional(),
});

export type ScenarioIdentity = z.infer<typeof identitySchema>;

const overrideSchema = z.object({
	callbackUrl: z.url({ protocol: /^https?$/, error: "must be an http(s) URL" }),
	verifyToken: z.string().min(1).optional(),
});

/**
 * `MOCKWA_APPS`' entry, with WABAs named by reference and the two override levels of Meta's
 * routing (SPEC §3): per WABA and per business number.
 */
const scenarioAppSchema = seedAppSchema.omit({ wabas: true }).extend({
	wabas: z.array(refSchema).default([]),
	wabaOverrides: z.array(overrideSchema.extend({ waba: refSchema })).default([]),
	phoneOverrides: z.array(overrideSchema.extend({ number: refSchema })).default([]),
});

export type ScenarioApp = z.infer<typeof scenarioAppSchema>;

const withinSchema = durationSchema.pipe(
	z.number().max(MAX_EXPECT_WITHIN_MS, `must be at most ${String(MAX_EXPECT_WITHIN_MS / 1000)}s`),
);

/** The identity speaking, and the business number it speaks to (optional with just one). */
const conversationShape = { as: refSchema, to: refSchema.optional() };

const sendSchema = z
	.object({
		...conversationShape,
		/** Shorthand for `message: {type: "text", text: {body}}`. */
		text: z.string().min(1).optional(),
		/** Any `POST /api/inbound` body, without `phoneNumberId` and `from` (they come from `as`/`to`). */
		message: z.record(z.string(), z.unknown()).optional(),
	})
	.strict()
	.refine(value => (value.text === undefined) !== (value.message === undefined), {
		error: "give either text or message",
		path: ["text"],
	});

const tapSchema = z
	.object({
		...conversationShape,
		/** A reply button's or list row's title or ID, or a template quick reply's text or payload. */
		option: z.string().min(1),
	})
	.strict();

const advanceSchema = z.union([
	z.literal("next"),
	durationSchema,
	z.object({ to: instantSchema }).strict(),
	z.object({ by: durationSchema }).strict(),
]);

const MESSAGE_STATUSES = ["accepted", "sent", "delivered", "read", "failed"] as const;
const DELIVERY_OUTCOMES = ["delivered", "retrying", "failed", "skipped"] as const;

const expectMessageSchema = z
	.object({
		/** The identity the business wrote to. */
		to: refSchema,
		/** The business number it came from. */
		from: refSchema.optional(),
		type: z.string().min(1).optional(),
		/** The whole text body (`text` messages) or the interactive body text. */
		text: z.string().optional(),
		contains: z.string().min(1).optional(),
		/** A template send, by template name. */
		template: z.string().min(1).optional(),
		status: z.enum(MESSAGE_STATUSES).optional(),
		/** For a `failed` message: the error code it failed with. */
		errorCode: z.number().int().optional(),
	})
	.strict();

const expectWebhookSchema = z
	.object({
		/** `messages`, `message_template_status_update`… */
		field: z.string().min(1).optional(),
		/** For `messages`: an inbound message, or a status. */
		kind: z.enum(["message", "status"]).optional(),
		/** For a status: which one. */
		status: z.enum(["sent", "delivered", "read", "failed"]).optional(),
		/** The identity the change is about. */
		about: refSchema.optional(),
		/** The app the copy went to. */
		app: refSchema.optional(),
		/** The chain's latest outcome. */
		outcome: z.enum(DELIVERY_OUTCOMES).optional(),
		/** Exactly this many matching webhooks; at least one when omitted. */
		count: z.number().int().nonnegative().optional(),
	})
	.strict();

const expectWindowSchema = z.object({ ...conversationShape, open: z.boolean() }).strict();

const expectClockSchema = z
	.object({
		now: instantSchema.optional(),
		/** How many virtual events are still waiting. */
		pending: z.number().int().nonnegative().optional(),
	})
	.strict();

const EXPECT_KINDS = ["message", "webhook", "window", "clock"] as const;

const expectSchema = z
	.object({
		message: expectMessageSchema.optional(),
		webhook: expectWebhookSchema.optional(),
		window: expectWindowSchema.optional(),
		clock: expectClockSchema.optional(),
		/** How long to wait, in real time, for it to become true: `"5s"` by default, `"0s"` to check once. */
		within: withinSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const kinds = EXPECT_KINDS.filter(kind => value[kind] !== undefined);

		if (kinds.length !== 1) {
			ctx.addIssue({
				code: "custom",
				message: `an expect names exactly one of ${EXPECT_KINDS.join(", ")}${kinds.length > 1 ? `, got ${kinds.join(" and ")}` : ""}`,
			});
		}
	});

export const STEP_ACTIONS = ["send", "tap", "expect", "advance"] as const;

export type StepAction = (typeof STEP_ACTIONS)[number];

const stepSchema = z
	.object({
		/** Shown in the results and in the JUnit report; defaults to a description of the step. */
		name: z.string().min(1).optional(),
		send: sendSchema.optional(),
		tap: tapSchema.optional(),
		expect: expectSchema.optional(),
		advance: advanceSchema.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		const actions = STEP_ACTIONS.filter(action => value[action] !== undefined);

		if (actions.length !== 1) {
			ctx.addIssue({
				code: "custom",
				message: `a step has exactly one action (${STEP_ACTIONS.join(", ")})${actions.length > 1 ? `, got ${actions.join(" and ")}` : ""}`,
			});
		}
	});

export type ScenarioStep = z.infer<typeof stepSchema>;
export type ExpectStep = z.infer<typeof expectSchema>;
export type ExpectMessage = z.infer<typeof expectMessageSchema>;
export type ExpectWebhook = z.infer<typeof expectWebhookSchema>;
export type AdvanceStep = z.infer<typeof advanceSchema>;
export type SendStep = z.infer<typeof sendSchema>;
export type TapStep = z.infer<typeof tapSchema>;

export const scenarioSchema = z
	.object({
		name: z.string().trim().min(1).max(200),
		description: z.string().optional(),
		/**
		 * The virtual clock's start for this run (requires `MOCKWA_CLOCK=virtual`); without it a
		 * virtual clock starts at `MOCKWA_CLOCK_START`.
		 */
		clock: z.object({ start: instantSchema }).strict().optional(),
		/** Business accounts and numbers, in `MOCKWA_SEED`'s format; `MOCKWA_SEED` itself when omitted. */
		wabas: z.array(seedWabaSchema).min(1).optional(),
		/** The people in the test. They become contacts of the first WABA. */
		identities: z.array(identitySchema).default([]),
		/** Apps and their routing; replace `MOCKWA_APPS` for the run when given. */
		apps: z.array(scenarioAppSchema).optional(),
		/** Error-injection rules armed before the first step (`POST /api/injection-rules` bodies). */
		failureRules: z.array(injectionRuleCreateRequestSchema).default([]),
		steps: z.array(stepSchema).min(1),
	})
	.strict();

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;

/** Issues as `steps[2].expect.message.to: Required`, one per line: what a person fixes a file with. */
export function describeScenarioIssues(error: z.ZodError): string[] {
	return error.issues.map(issue => {
		const location = issue.path
			.map((segment, index) => {
				if (typeof segment === "number") {
					return `[${String(segment)}]`;
				}

				return index === 0 ? String(segment) : `.${String(segment)}`;
			})
			.join("");

		return `${location === "" ? "(scenario)" : location}: ${issue.message}`;
	});
}
