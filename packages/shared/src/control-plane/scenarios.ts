import { z } from "zod";

/**
 * `/api/scenarios` (SPEC §4, "Scenarios"; §5). The scenario file itself is validated by the
 * server (its schema lives with the runner); what is shared is what comes back.
 */

export const SCENARIO_STEP_STATUSES = ["passed", "failed", "skipped"] as const;

export const scenarioStepFailureSchema = z.object({
	message: z.string(),
	expected: z.unknown().optional(),
	observed: z.unknown().optional(),
});

export type ScenarioStepFailure = z.infer<typeof scenarioStepFailureSchema>;

export const scenarioStepResultSchema = z.object({
	/** 1-based, as a person counts steps. */
	index: z.number().int().positive(),
	name: z.string(),
	/** `send`, `tap`, `advance`, `expect`… */
	action: z.string(),
	status: z.enum(SCENARIO_STEP_STATUSES),
	/** Virtual time once the step finished; `null` with the real clock. */
	at: z.string().nullable(),
	detail: z.record(z.string(), z.unknown()).optional(),
	failure: scenarioStepFailureSchema.optional(),
});

export type ScenarioStepResult = z.infer<typeof scenarioStepResultSchema>;

const worldWabaSchema = z.object({ id: z.string(), name: z.string() });
const worldNumberSchema = z.object({ id: z.string(), wabaId: z.string(), displayPhoneNumber: z.string() });
const worldIdentitySchema = z.object({ waId: z.string(), name: z.string(), role: z.string().nullable() });

export const scenarioResultSchema = z.object({
	scenario: z.string(),
	passed: z.boolean(),
	clock: z.object({
		mode: z.enum(["real", "virtual"]),
		start: z.string().nullable(),
		end: z.string().nullable(),
	}),
	world: z.object({
		wabas: z.array(worldWabaSchema),
		numbers: z.array(worldNumberSchema),
		identities: z.array(worldIdentitySchema),
	}),
	steps: z.array(scenarioStepResultSchema),
	/** The first failed step, repeated for whoever reads only the top of the report. */
	failure: scenarioStepFailureSchema
		.extend({ step: z.number().int().positive(), name: z.string(), action: z.string() })
		.nullable(),
});

export type ScenarioResult = z.infer<typeof scenarioResultSchema>;

/** What the JUnit report is built from: the result plus wall-clock milliseconds per step. */
export interface ScenarioRunResult {
	result: ScenarioResult;
	elapsedMs: number[];
}

/** `POST /api/scenarios/run` (JSON). `200` whether the scenario passed or not: `passed` says. */
export const scenarioRunResponseSchema = z.object({
	data: scenarioResultSchema,
	elapsedMs: z.array(z.number().nonnegative()),
});

export type ScenarioRunResponse = z.infer<typeof scenarioRunResponseSchema>;

/** `POST /api/scenarios/validate` — nothing runs and nothing is reset. */
export const scenarioValidateResponseSchema = z.object({
	data: z.object({ valid: z.literal(true), name: z.string(), steps: z.number().int().nonnegative() }),
});

export type ScenarioValidateResponse = z.infer<typeof scenarioValidateResponseSchema>;
