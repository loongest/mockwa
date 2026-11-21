import type { LoggedFormField } from "@wasandbox/shared";
import type { HonoRequest, MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.ts";
import type { CapturedBody, GraphRequestLog } from "../domain/index.ts";

/**
 * Feeds the Graph request log (SPEC §5, "Graph request log") from the Graph listener: every
 * request but `/health`, after its answer is known — rejected ones included, since the error
 * envelope is usually what an integration needs to see.
 *
 * This only reads the wire. Textual bodies are read from a clone (the route reads the original);
 * a binary body is never read at all, so a media upload or download costs nothing extra and is
 * described by its declared type and length. Masking and capping happen in the domain.
 */

/** A multipart body bigger than this is described by its size only, not parsed. */
const MULTIPART_PARSE_LIMIT = 8 * 1024 * 1024;

const BEARER_PATTERN = /^Bearer[ \t]+(\S.*)$/i;

function declaredLength(headers: Headers): number | null {
	const value = headers.get("content-length");
	const length = value === null ? NaN : Number(value);

	return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function isTextual(contentType: string | null): boolean {
	if (contentType === null) {
		return false;
	}

	const type = contentType.toLowerCase();

	return /[/+]json\b/.test(type) || type.startsWith("text/") || type.startsWith("application/x-www-form-urlencoded");
}

/** Through Hono's request, which caches the parsed form for the route that reads it next. */
async function multipartFields(request: HonoRequest): Promise<LoggedFormField[]> {
	const form = await request.formData();
	const fields: LoggedFormField[] = [];

	for (const [name, value] of form) {
		fields.push(
			typeof value === "string"
				? { name, value }
				: {
						name,
						file: {
							filename: value.name === "" ? null : value.name,
							contentType: value.type || null,
							size: value.size,
						},
					},
		);
	}

	return fields;
}

async function multipartFieldsOrNull(request: HonoRequest): Promise<LoggedFormField[] | null> {
	try {
		return await multipartFields(request);
	} catch {
		return null;
	}
}

async function captureRequest(honoRequest: HonoRequest): Promise<CapturedBody> {
	const request = honoRequest.raw;
	const contentType = request.headers.get("content-type");
	const size = declaredLength(request.headers);

	if (size === 0 || request.body === null) {
		return { kind: "empty", contentType };
	}

	if (isTextual(contentType)) {
		const text = await request.clone().text();

		return { kind: "text", contentType, text, size: Buffer.byteLength(text) };
	}

	const isMultipart = contentType?.toLowerCase().startsWith("multipart/form-data") ?? false;

	if (isMultipart && (size === null || size <= MULTIPART_PARSE_LIMIT)) {
		const fields = await multipartFieldsOrNull(honoRequest);

		// A malformed body is the route's to answer; the log describes it as bytes.
		if (fields !== null) {
			return { kind: "multipart", contentType, size, fields };
		}
	}

	return { kind: "binary", contentType, size };
}

async function captureResponse(response: Response): Promise<CapturedBody> {
	const contentType = response.headers.get("content-type");
	const size = declaredLength(response.headers);

	if (size === 0 || response.body === null) {
		return { kind: "empty", contentType };
	}

	if (isTextual(contentType)) {
		const text = await response.clone().text();

		return { kind: "text", contentType, text, size: Buffer.byteLength(text) };
	}

	return { kind: "binary", contentType, size };
}

export function createGraphRequestLogger(log: GraphRequestLog): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		if (c.req.path === "/health") {
			await next();

			return;
		}

		const receivedAt = log.now();
		const started = performance.now();
		const request = c.req.raw;
		let requestBody: CapturedBody;

		try {
			requestBody = await captureRequest(c.req);
		} catch {
			requestBody = {
				kind: "binary",
				contentType: request.headers.get("content-type"),
				size: declaredLength(request.headers),
			};
		}

		await next();

		const url = new URL(request.url);
		const bearer = BEARER_PATTERN.exec(request.headers.get("authorization")?.trim() ?? "");

		await log.record({
			receivedAt,
			durationMs: performance.now() - started,
			method: request.method,
			path: url.pathname,
			query: url.searchParams,
			headers: request.headers,
			status: c.res.status,
			accessToken: bearer?.[1]?.trim(),
			requestBody,
			responseBody: await captureResponse(c.res),
		});
	};
}
