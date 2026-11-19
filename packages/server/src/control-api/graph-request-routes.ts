import {
	graphRequestExportSchema,
	graphRequestListQuerySchema,
	graphRequestListResponseSchema,
	graphRequestResponseSchema,
} from "@mockwa/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { GraphRequestLog } from "../domain/index.ts";
import { parseOrThrow, type ControlEnv } from "./control-env.ts";

export interface GraphRequestRoutesOptions {
	graphRequests: GraphRequestLog;
}

const idSchema = z.coerce.number().int().positive();

/**
 * `/api/graph-requests` (SPEC §5, "Graph request log"): the newest requests first, one in full,
 * all of them as a download, and a way to start over. Nothing here touches the Graph surface.
 */
export function createGraphRequestRoutes(options: GraphRequestRoutesOptions): Hono<ControlEnv> {
	const routes = new Hono<ControlEnv>();
	const log = options.graphRequests;

	routes.get("/graph-requests", async c => {
		const query = parseOrThrow(graphRequestListQuerySchema, c.req.query());

		return c.json(graphRequestListResponseSchema.parse(await log.list(query)));
	});

	// Registered before `/:id`, which would otherwise claim it.
	routes.get("/graph-requests/export", async c => {
		const body = graphRequestExportSchema.parse({
			exportedAt: log.now().toISOString(),
			limit: log.limit,
			data: await log.export(),
		});

		c.header("content-disposition", 'attachment; filename="mockwa-graph-requests.json"');

		return c.json(body);
	});

	routes.get("/graph-requests/:id", async c => {
		const id = parseOrThrow(idSchema, c.req.param("id"));

		return c.json(graphRequestResponseSchema.parse({ data: await log.get(id) }));
	});

	routes.delete("/graph-requests", async c => {
		await log.clear();

		return c.body(null, 204);
	});

	return routes;
}
