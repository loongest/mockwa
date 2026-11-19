import {
	clockAdvanceRequestSchema,
	clockMoveResponseSchema,
	clockResponseSchema,
	clockSetRequestSchema,
} from "@mockwa/shared";
import { Hono } from "hono";
import type { ClockService } from "../domain/index.ts";
import { readBody, type ControlEnv } from "./control-env.ts";

export interface ClockRoutesOptions {
	clock: ClockService;
}

/**
 * `/api/clock` (SPEC §5): inspect the instance's clock, and — with `MOCKWA_CLOCK=virtual` — move
 * it. Every move answers once the events it ran have settled (SPEC §4, "Virtual clock"), so
 * the state it left behind can be asserted on straight away. A real clock answers 409
 * `clock_not_virtual` to every move.
 */
export function createClockRoutes(options: ClockRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const { clock } = options;

	routes.get("/clock", c => c.json(clockResponseSchema.parse({ data: clock.view() })));

	routes.post("/clock/advance", async c => {
		const request = await readBody(c, clockAdvanceRequestSchema);

		return c.json(clockMoveResponseSchema.parse({ data: await clock.advance(request.by) }));
	});

	routes.post("/clock/set", async c => {
		const request = await readBody(c, clockSetRequestSchema);

		const moved = await clock.set(new Date(request.to));

		return c.json(clockMoveResponseSchema.parse({ data: moved }));
	});

	routes.post("/clock/run-next", async c => {
		const moved = await clock.runNext();

		return c.json(clockMoveResponseSchema.parse({ data: moved }));
	});

	return routes;
}
