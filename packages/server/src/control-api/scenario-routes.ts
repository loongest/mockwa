import { scenarioRunResponseSchema, scenarioValidateResponseSchema } from "@mockwa/shared";
import { Hono } from "hono";
import { describeScenarioIssues, scenarioSchema, type Scenario } from "../config/index.ts";
import { controlBadRequest, toJUnitXml, type ScenarioRunner } from "../domain/index.ts";
import { readJsonBody, type ControlEnv } from "./control-env.ts";

export interface ScenarioRoutesOptions {
	scenarios: ScenarioRunner;
}

function parseScenario(body: unknown): Scenario {
	const parsed = scenarioSchema.safeParse(body);

	if (!parsed.success) {
		throw controlBadRequest(
			`the scenario is invalid:\n${describeScenarioIssues(parsed.error)
				.map(issue => `  - ${issue}`)
				.join("\n")}`,
			"invalid_scenario",
		);
	}

	return parsed.data;
}

/**
 * `/api/scenarios` (SPEC §5): validate a scenario, or run it. A run **resets the instance** into
 * the scenario's world first, exactly like `POST /api/reset`, and answers once every step has
 * finished — `200` whether it passed or failed, because the run itself worked; `passed` says how
 * it went. `?format=junit` answers with the JUnit XML report instead of JSON.
 */
export function createScenarioRoutes(options: ScenarioRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const { scenarios } = options;

	routes.post("/scenarios/validate", async c => {
		const scenario = parseScenario(await readJsonBody(c));

		scenarios.plan(scenario);

		return c.json(
			scenarioValidateResponseSchema.parse({
				data: { valid: true, name: scenario.name, steps: scenario.steps.length },
			}),
		);
	});

	routes.post("/scenarios/run", async c => {
		const scenario = parseScenario(await readJsonBody(c));
		const run = await scenarios.run(scenario);

		if (c.req.query("format") === "junit") {
			return c.body(toJUnitXml([run]), 200, { "content-type": "application/xml; charset=utf-8" });
		}

		return c.json(scenarioRunResponseSchema.parse({ data: run.result, elapsedMs: run.elapsedMs }));
	});

	return routes;
}
