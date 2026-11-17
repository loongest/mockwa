import type { Context } from "hono";
import { Hono } from "hono";
import { invalidParameterError, parseOverride, type SubscribedAppService } from "../domain/index.ts";
import type { GraphEnv } from "./graph-env.ts";

export interface SubscribedAppRoutesOptions {
	subscribedApps: SubscribedAppService;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The parameters of a call that may come as a JSON body, a form body or the query string, or
 * not at all — Meta's own SDKs use all four, and a bare `curl -X POST` has to keep working.
 */
async function readParameters(c: Context<GraphEnv>): Promise<Record<string, unknown>> {
	const query: Record<string, unknown> = { ...c.req.query() };
	const contentType = c.req.header("content-type") ?? "";
	const text = await c.req.text();

	if (text.trim() === "") {
		return query;
	}

	if (contentType.includes("application/x-www-form-urlencoded")) {
		return { ...query, ...Object.fromEntries(new URLSearchParams(text)) };
	}

	let body: unknown;

	try {
		body = JSON.parse(text);
	} catch (error) {
		throw invalidParameterError("Invalid JSON in request body", { cause: error });
	}

	if (!isRecord(body)) {
		throw invalidParameterError("The request body must be a JSON object");
	}

	return { ...query, ...body };
}

/** A form or query parameter carries the object as a JSON string. */
function asObject(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "string") {
		let parsed: unknown;

		try {
			parsed = JSON.parse(value);
		} catch {
			return undefined;
		}

		return isRecord(parsed) ? parsed : undefined;
	}

	return isRecord(value) ? value : undefined;
}

/**
 * `GET|POST|DELETE /{wabaId}/subscribed_apps` (SPEC §2.20) and `POST /{phoneNumberId}` with
 * `webhook_configuration` (SPEC §3) — how an app registers for a WABA's webhooks and points
 * them somewhere else.
 *
 * The listing is Meta's nested shape, `{data:[{whatsapp_business_api_data:{id, name, link}}]}`,
 * with `override_callback_uri` beside it when the app set one.
 *
 * `POST /{id}` is shared with the template edit: this handler takes it only when the body
 * carries `webhook_configuration`, and otherwise hands the request on.
 */
export function createSubscribedAppRoutes(options: SubscribedAppRoutesOptions): Hono<GraphEnv> {
	const routes = new Hono<GraphEnv>();

	routes.post("/:id/subscribed_apps", async c => {
		const parameters = await readParameters(c);
		const override = parseOverride(
			parameters["override_callback_uri"],
			parameters["verify_token"],
			"override_callback_uri",
		);

		await options.subscribedApps.subscribe(c.req.param("id"), c.get("accessToken"), override);

		return c.json({ success: true });
	});

	routes.get("/:id/subscribed_apps", async c => {
		const apps = await options.subscribedApps.list(c.req.param("id"));

		return c.json({
			data: apps.map(app => {
				return {
					whatsapp_business_api_data: { id: app.id, name: app.name, link: app.link },
					...(app.overrideCallbackUri !== null && { override_callback_uri: app.overrideCallbackUri }),
				};
			}),
		});
	});

	routes.delete("/:id/subscribed_apps", async c => {
		await options.subscribedApps.unsubscribe(c.req.param("id"), c.get("accessToken"));

		return c.json({ success: true });
	});

	routes.post("/:id", async (c, next) => {
		const parameters = await readParameters(c);
		const configuration = asObject(parameters["webhook_configuration"]);

		if (parameters["webhook_configuration"] === undefined) {
			await next();

			return;
		}

		if (configuration === undefined) {
			throw invalidParameterError("webhook_configuration must be an object");
		}

		await options.subscribedApps.configurePhoneNumber(c.req.param("id"), c.get("accessToken"), configuration);

		return c.json({ success: true });
	});

	return routes;
}
