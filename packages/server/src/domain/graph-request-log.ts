import {
	GRAPH_REQUEST_BODY_LIMIT,
	GRAPH_REQUEST_LOG_LIMIT,
	loggedBodySchema,
	type GraphRequest,
	type GraphRequestSummary,
	type LoggedBody,
	type LoggedFormField,
} from "@wasandbox/shared";
import type { DepartedNumbers } from "./departed-numbers.ts";
import { z } from "zod";
import type { GraphRequestRecord, Repositories } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import { controlNotFound } from "./control-plane-error.ts";
import type { EventPublisher } from "./event-bus.ts";
import { MEDIA_DOWNLOAD_PATH } from "./media-service.ts";
import { createSystemScheduler, type Scheduler } from "./scheduler.ts";
import { maskToken } from "./token-registry.ts";
import { UPLOAD_DOWNLOAD_PATH } from "./upload-service.ts";

/**
 * The Graph request log (SPEC §5, "Graph request log"): every request the Graph listener
 * answered, with what came back, so an integration can be debugged from the console.
 *
 * What is stored is decided here, not by the transport:
 *
 * - credentials never reach the table — the bearer token is masked as `/api/tokens` masks it,
 *   and every header, query parameter, JSON key or form field whose name says token, secret,
 *   password or PIN is replaced by {@link MASK};
 * - textual bodies are cut at {@link GRAPH_REQUEST_BODY_LIMIT} characters, binary ones are
 *   described (type and size) and never stored;
 * - only the newest {@link GRAPH_REQUEST_LOG_LIMIT} requests are kept.
 */

export const MASK = "[masked]";

const SECRET_NAME = /token|secret|password|passwd|^pin$|signature|api[-_]?key|appsecret|^cookie$/i;

/** What the transport read off the wire, before anything is masked or cut. */
export type CapturedBody =
	| { kind: "empty"; contentType: string | null }
	| { kind: "text"; contentType: string | null; text: string; size: number }
	| { kind: "multipart"; contentType: string | null; size: number | null; fields: LoggedFormField[] }
	| { kind: "binary"; contentType: string | null; size: number | null };

export interface GraphRequestInput {
	receivedAt: Date;
	durationMs: number;
	method: string;
	/** The path as requested, without the query string. */
	path: string;
	query: URLSearchParams;
	headers: Headers;
	status: number;
	/** The bearer token the request carried, if any (the raw value; it is masked here). */
	accessToken: string | undefined;
	requestBody: CapturedBody;
	responseBody: CapturedBody;
}

export interface GraphRequestLogOptions {
	repositories: Repositories;
	/** The app a token belongs to (the default app's key when no registered app owns it). */
	appKeyFor: (token: string) => Promise<string>;
	events?: EventPublisher;
	scheduler?: Scheduler;
	logger: Logger;
	limit?: number;
	/** Public mode: a request naming a visitor who already left is not logged (SPEC §5). */
	departed?: DepartedNumbers;
}

function isSecretName(name: string): boolean {
	return SECRET_NAME.test(name);
}

function maskJson(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => maskJson(item));
	}

	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, isSecretName(key) ? MASK : maskJson(item)]),
		);
	}

	return value;
}

function maskParams(params: URLSearchParams): string {
	const masked = new URLSearchParams();

	for (const [key, value] of params) {
		masked.append(key, isSecretName(key) ? MASK : value);
	}

	return masked.toString();
}

function maskAuthorization(value: string): string {
	const space = value.indexOf(" ");

	return space === -1 ? MASK : `${value.slice(0, space)} ${maskToken(value.slice(space + 1).trim())}`;
}

export function maskHeaders(headers: Headers): Record<string, string> {
	const masked: Record<string, string> = {};

	for (const [name, value] of headers) {
		if (name === "authorization") {
			masked[name] = maskAuthorization(value);
		} else {
			masked[name] = isSecretName(name) ? MASK : value;
		}
	}

	return masked;
}

function cut(text: string): { text: string; truncated: boolean } {
	return text.length > GRAPH_REQUEST_BODY_LIMIT
		? { text: text.slice(0, GRAPH_REQUEST_BODY_LIMIT), truncated: true }
		: { text, truncated: false };
}

function isJsonType(contentType: string | null): boolean {
	return contentType !== null && /[/+]json\b/i.test(contentType);
}

function isFormType(contentType: string | null): boolean {
	return contentType?.toLowerCase().startsWith("application/x-www-form-urlencoded") ?? false;
}

function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/** Why a request body was not stored: said in the entry instead of the body. */
export const OMITTED_MALFORMED_JSON =
	"malformed JSON: not stored, because secrets in text that does not parse cannot be found and masked";
export const OMITTED_BARE_JSON_VALUE =
	"JSON that is not an object or array: not stored, because a bare string can hold a secret no key names";
export const OMITTED_UNSTRUCTURED_TEXT =
	"not JSON or a form: not stored, because secrets in free text cannot be found and masked";

type MaskedText = { kind: "json" | "text" | "form"; text: string } | { kind: "omitted"; reason: string };

/**
 * A body becomes text in the log only once it has been parsed and masked. A request body that
 * does not parse — a JSON body cut short, free text — could carry a credential anywhere, so it is
 * described (type, size, why) and never stored. Response bodies are WaSandbox's own words and are
 * kept as sent.
 */
function maskText(contentType: string | null, text: string, origin: BodyOrigin): MaskedText {
	if (isFormType(contentType)) {
		return { kind: "form", text: maskParams(new URLSearchParams(text)) };
	}

	const isLooksLikeJson = isJsonType(contentType) || /^\s*[[{]/.test(text);
	const json = isLooksLikeJson ? parseJsonOrUndefined(text) : undefined;

	if (origin === "response") {
		return json === undefined ? { kind: "text", text } : { kind: "json", text: JSON.stringify(maskJson(json)) };
	}

	// Masking works by key, so only a body made of keys can be kept: `"password=…"` sent as a
	// bare JSON string parses, and would otherwise be stored verbatim.
	if (typeof json === "object" && json !== null) {
		return { kind: "json", text: JSON.stringify(maskJson(json)) };
	}

	if (json !== undefined) {
		return { kind: "omitted", reason: OMITTED_BARE_JSON_VALUE };
	}

	return { kind: "omitted", reason: isLooksLikeJson ? OMITTED_MALFORMED_JSON : OMITTED_UNSTRUCTURED_TEXT };
}

/** Where a body was captured: what the app sent, or what WaSandbox answered. */
export type BodyOrigin = "request" | "response";

/** Masks and caps what the transport captured: the only form a body is ever stored in. */
export function toLoggedBody(body: CapturedBody, origin: BodyOrigin = "request"): LoggedBody {
	switch (body.kind) {
		case "empty": {
			return { kind: "empty", contentType: body.contentType, size: 0, truncated: false };
		}

		case "text": {
			const masked = maskText(body.contentType, body.text, origin);

			if (masked.kind === "omitted") {
				return {
					kind: "omitted",
					contentType: body.contentType,
					size: body.size,
					omittedReason: masked.reason,
					truncated: false,
				};
			}

			const capped = cut(masked.text);

			return { kind: masked.kind, contentType: body.contentType, size: body.size, ...capped };
		}

		case "multipart": {
			const fields = body.fields.map(field =>
				field.value !== undefined && isSecretName(field.name) ? { ...field, value: MASK } : field,
			);

			return { kind: "multipart", contentType: body.contentType, size: body.size, fields, truncated: false };
		}

		case "binary": {
			return { kind: "binary", contentType: body.contentType, size: body.size, truncated: false };
		}
	}
}

const errorEnvelopeSchema = z.object({ error: z.object({ code: z.number().int() }) });

function errorCodeOf(body: LoggedBody): number | null {
	if (body.truncated || body.kind !== "json" || body.text === undefined) {
		return null;
	}

	const parsed = errorEnvelopeSchema.safeParse(parseJsonOrUndefined(body.text));

	return parsed.success ? parsed.data.error.code : null;
}

/** The first segment after `/v<major>.<minor>/`: a phone number id when the path addresses one. */
function objectIdOf(path: string): string | null {
	const match = /^\/v\d+\.\d+\/([^/]+)/.exec(path);

	return match?.[1] ?? null;
}

/** Media byte URLs carry their credential in the path (SPEC §2.8): masked like a token. */
export function maskPath(path: string): string {
	for (const prefix of [MEDIA_DOWNLOAD_PATH, UPLOAD_DOWNLOAD_PATH]) {
		if (path.startsWith(`${prefix}/`)) {
			return `${prefix}/${maskToken(decodeURIComponent(path.slice(prefix.length + 1)))}`;
		}
	}

	return path;
}

const headerMapSchema = z.record(z.string(), z.string());

export function toGraphRequestSummary(record: GraphRequestRecord): GraphRequestSummary {
	return {
		id: record.id,
		receivedAt: record.receivedAt,
		durationMs: record.durationMs,
		method: record.method,
		path: record.path,
		query: record.query,
		status: record.status,
		phoneNumberId: record.phoneNumberId,
		appKey: record.appKey,
		tokenMasked: record.tokenMasked,
		errorCode: record.errorCode,
	};
}

export function toGraphRequest(record: GraphRequestRecord): GraphRequest {
	return {
		...toGraphRequestSummary(record),
		requestHeaders: headerMapSchema.parse(JSON.parse(record.requestHeaders)),
		requestBody: loggedBodySchema.parse(JSON.parse(record.requestBody)),
		responseBody: loggedBodySchema.parse(JSON.parse(record.responseBody)),
	};
}

export class GraphRequestLog {
	readonly #repositories: Repositories;
	readonly #appKeyFor: (token: string) => Promise<string>;
	readonly #events: EventPublisher | undefined;
	readonly #scheduler: Scheduler;
	readonly #logger: Logger;
	readonly #departed: DepartedNumbers | undefined;
	readonly limit: number;

	constructor(options: GraphRequestLogOptions) {
		this.#repositories = options.repositories;
		this.#appKeyFor = options.appKeyFor;
		this.#events = options.events;
		this.#scheduler = options.scheduler ?? createSystemScheduler();
		this.#logger = options.logger;
		this.limit = options.limit ?? GRAPH_REQUEST_LOG_LIMIT;
		this.#departed = options.departed;
	}

	async #isForDeparted(texts: readonly string[]): Promise<boolean> {
		return this.#departed === undefined ? false : this.#departed.isMentionedIn(texts.join("\n"));
	}

	async #phoneNumberIdOf(path: string): Promise<string | null> {
		const objectId = objectIdOf(path);

		if (objectId === null) {
			return null;
		}

		return (await this.#repositories.phoneNumbers.findById(objectId)) === null ? null : objectId;
	}

	async #store(input: GraphRequestInput): Promise<void> {
		const requestBody = toLoggedBody(input.requestBody);
		const responseBody = toLoggedBody(input.responseBody, "response");
		const token = input.accessToken;
		const row = {
			receivedAt: input.receivedAt.toISOString(),
			durationMs: Math.max(0, Math.round(input.durationMs)),
			method: input.method,
			path: maskPath(input.path),
			query: maskParams(input.query),
			status: input.status,
			phoneNumberId: await this.#phoneNumberIdOf(input.path),
			appKey: token === undefined ? null : await this.#appKeyFor(token),
			tokenMasked: token === undefined ? null : maskToken(token),
			errorCode: errorCodeOf(responseBody),
			requestHeaders: JSON.stringify(maskHeaders(input.headers)),
			requestBody: JSON.stringify(requestBody),
			responseBody: JSON.stringify(responseBody),
		};
		const texts = [row.path, row.query, row.requestBody, row.responseBody];

		if (await this.#isForDeparted(texts)) {
			return;
		}

		const record = await this.#repositories.graphRequests.insert(row);

		// Again after the insert: a cleanup between the two checks has already run its delete.
		if (await this.#isForDeparted(texts)) {
			await this.#repositories.graphRequests.deleteById(record.id);

			return;
		}

		await this.#repositories.graphRequests.prune(this.limit);
		this.#events?.publish({ type: "graph_request.logged", payload: { request: toGraphRequestSummary(record) } });
	}

	/** Simulator time, which is what a request is stamped with. */
	now(): Date {
		return this.#scheduler.now();
	}

	/**
	 * Stores one request. Never throws: the log is a diagnostic, and a failure to write it must
	 * not change what the app under test was answered.
	 */
	async record(input: GraphRequestInput): Promise<void> {
		try {
			await this.#store(input);
		} catch (error) {
			this.#logger.warn({ err: error, path: maskPath(input.path) }, "could not log a Graph request");
		}
	}

	async list(query: { limit: number; before?: number | undefined; phoneNumberId?: string | undefined }) {
		const records = await this.#repositories.graphRequests.list(query);
		const last = records.at(-1);

		return {
			data: records.map(record => toGraphRequestSummary(record)),
			paging: { before: last !== undefined && records.length === query.limit ? last.id : null },
		};
	}

	async get(id: number): Promise<GraphRequest> {
		const record = await this.#repositories.graphRequests.findById(id);

		if (record === null) {
			throw controlNotFound(`no logged Graph request with id ${String(id)}`, "unknown_graph_request");
		}

		return toGraphRequest(record);
	}

	async export(): Promise<GraphRequest[]> {
		const records = await this.#repositories.graphRequests.listAll();

		return records.map(record => toGraphRequest(record));
	}

	async clear(): Promise<void> {
		await this.#repositories.graphRequests.deleteAll();
	}
}
