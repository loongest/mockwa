import { z } from "zod";

/**
 * The Graph request log (SPEC §5, "Graph request log"): what the app under test sent to the
 * Graph listener and what it got back, for debugging an integration. Secrets are masked and
 * bodies are capped before anything is stored; binary content is described, never stored.
 */

/** How many requests are kept; older ones are dropped as new ones arrive. */
export const GRAPH_REQUEST_LOG_LIMIT = 500;

/** How much of a textual body is kept, in characters; the rest is cut and `truncated` is set. */
export const GRAPH_REQUEST_BODY_LIMIT = 16_384;

export const LOGGED_BODY_KINDS = ["empty", "json", "text", "form", "multipart", "binary", "omitted"] as const;

export const loggedFormFieldSchema = z.object({
	name: z.string(),
	/** A text field's value, masked when its name says it is a secret. */
	value: z.string().optional(),
	/** A file part: described, never stored. */
	file: z
		.object({
			filename: z.string().nullable(),
			contentType: z.string().nullable(),
			size: z.number().int().nonnegative(),
		})
		.optional(),
});

export type LoggedFormField = z.infer<typeof loggedFormFieldSchema>;

export const loggedBodySchema = z.object({
	kind: z.enum(LOGGED_BODY_KINDS),
	contentType: z.string().nullable(),
	/** Bytes on the wire; `null` when the sender did not say and the body was not read. */
	size: z.number().int().nonnegative().nullable(),
	/** `json`, `text` and `form` bodies: the masked text, cut at {@link GRAPH_REQUEST_BODY_LIMIT}. */
	text: z.string().optional(),
	/** `multipart` bodies: the parts, files described by name, type and size. */
	fields: z.array(loggedFormFieldSchema).optional(),
	/**
	 * `omitted` bodies: why nothing was stored. A request body that does not parse (malformed JSON,
	 * free text) cannot be masked, so only its type and size are kept.
	 */
	omittedReason: z.string().optional(),
	truncated: z.boolean(),
});

export type LoggedBody = z.infer<typeof loggedBodySchema>;

export const graphRequestSummarySchema = z.object({
	id: z.number().int().positive(),
	/** Simulator time: the virtual clock's instant when it is virtual. */
	receivedAt: z.iso.datetime(),
	/** Wall-clock time the request took to answer. */
	durationMs: z.number().int().nonnegative(),
	method: z.string(),
	path: z.string(),
	/** The query string with secrets masked; `""` when there was none. */
	query: z.string(),
	status: z.number().int(),
	/** The business number the path addresses, when it is one. */
	phoneNumberId: z.string().nullable(),
	/** The app the bearer token belongs to (`default` when no registered app owns it). */
	appKey: z.string().nullable(),
	/** The bearer token, masked as `/api/tokens` masks it. */
	tokenMasked: z.string().nullable(),
	/** Meta's `error.code` when the answer was an error envelope. */
	errorCode: z.number().int().nullable(),
});

export type GraphRequestSummary = z.infer<typeof graphRequestSummarySchema>;

export const graphRequestSchema = graphRequestSummarySchema.extend({
	/** Lower-cased names; credentials masked. */
	requestHeaders: z.record(z.string(), z.string()),
	requestBody: loggedBodySchema,
	responseBody: loggedBodySchema,
});

export type GraphRequest = z.infer<typeof graphRequestSchema>;

/** `GET /api/graph-requests?limit=&before=&phoneNumberId=` — newest first. */
export const graphRequestListQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(200).default(50),
	/** Only requests with a smaller id: the `paging.before` of the previous page. */
	before: z.coerce.number().int().positive().optional(),
	phoneNumberId: z.string().min(1).optional(),
});

/** What a client sends; the schema coerces the query-string text. */
export interface GraphRequestListQuery {
	limit?: number | undefined;
	before?: number | undefined;
	phoneNumberId?: string | undefined;
}

export const graphRequestListResponseSchema = z.object({
	data: z.array(graphRequestSummarySchema),
	paging: z.object({ before: z.number().int().positive().nullable() }),
});

export type GraphRequestListResponse = z.infer<typeof graphRequestListResponseSchema>;

export const graphRequestResponseSchema = z.object({ data: graphRequestSchema });

export type GraphRequestResponse = z.infer<typeof graphRequestResponseSchema>;

/** `GET /api/graph-requests/export` — every request still kept, in full, oldest first. */
export const graphRequestExportSchema = z.object({
	exportedAt: z.iso.datetime(),
	limit: z.number().int().positive(),
	data: z.array(graphRequestSchema),
});

export type GraphRequestExport = z.infer<typeof graphRequestExportSchema>;
