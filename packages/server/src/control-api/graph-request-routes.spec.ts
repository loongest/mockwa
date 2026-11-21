import {
	GRAPH_REQUEST_BODY_LIMIT,
	graphRequestExportSchema,
	graphRequestListResponseSchema,
	graphRequestResponseSchema,
	type GraphRequest,
	type GraphRequestSummary,
} from "@wasandbox/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "../testing/test-app.ts";

/**
 * The Graph request log (SPEC §5, "Graph request log"): every request the Graph listener
 * answered, accepted or rejected, stored masked and bounded, read through `/api/graph-requests`.
 */

const CONTACT = "5571990000001";
const IMAGE_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);

describe("the Graph request log", () => {
	let fixture: TestApp;
	let logged: GraphRequestSummary[];

	beforeEach(async () => {
		fixture = await createTestApp();
		logged = [];
		fixture.services.domain.events.subscribe(event => {
			if (event.type === "graph_request.logged") {
				logged.push(event.payload.request);
			}
		});
	});

	afterEach(async () => {
		await fixture.close();
	});

	function graph(path: string, init: RequestInit = {}) {
		return fixture.app.request(`/v25.0/${path}`, init);
	}

	function sendJson(body: unknown, headers: Record<string, string> = TEST_AUTH_HEADERS) {
		return graph(`${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function list(query = ""): Promise<GraphRequestSummary[]> {
		const response = await fixture.app.request(`/api/graph-requests${query}`);

		expect(response.status).toBe(200);

		return graphRequestListResponseSchema.parse(await response.json()).data;
	}

	async function detail(id: number): Promise<GraphRequest> {
		const response = await fixture.app.request(`/api/graph-requests/${String(id)}`);

		expect(response.status).toBe(200);

		return graphRequestResponseSchema.parse(await response.json()).data;
	}

	async function exported(): Promise<unknown> {
		const response = await fixture.app.request("/api/graph-requests/export");

		return response.json();
	}

	async function latest(): Promise<GraphRequest> {
		const [newest] = await list("?limit=1");

		expect(newest).toBeDefined();

		return detail(newest!.id);
	}

	it("records an accepted send: who called, what was sent, what came back", async () => {
		const response = await sendJson({ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body: "hi" } });
		const answer = (await response.json()) as { messages: [{ id: string }] };
		const entry = await latest();

		expect(entry).toMatchObject({
			method: "POST",
			path: `/v25.0/${fixture.phoneNumberId}/messages`,
			query: "",
			status: 200,
			phoneNumberId: fixture.phoneNumberId,
			appKey: "default",
			tokenMasked: "••••••oken",
			errorCode: null,
			requestBody: { kind: "json", contentType: "application/json", truncated: false },
			responseBody: { kind: "json", truncated: false },
		});
		expect(JSON.parse(entry.requestBody.text!)).toEqual({
			messaging_product: "whatsapp",
			to: CONTACT,
			type: "text",
			text: { body: "hi" },
		});
		expect(JSON.parse(entry.responseBody.text!)).toEqual(answer);
		// The bearer token is masked; nothing else in the headers says what it was.
		expect(entry.requestHeaders["authorization"]).toBe("Bearer ••••••oken");
		expect(JSON.stringify(entry)).not.toContain("test-token");
		expect(logged.map(summary => summary.id)).toEqual([entry.id]);
	});

	it("records rejected requests with Meta's error code: auth, validation, injected failures", async () => {
		await sendJson({ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body: "hi" } }, {});
		await sendJson({
			messaging_product: "whatsapp",
			to: CONTACT,
			type: "template",
			template: { name: "no_such_template", language: { code: "en" } },
		});
		await fixture.app.request("/api/injection-rules", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				target: "messages.send",
				trigger: { kind: "next", count: 1 },
				preset: "server_error_500",
			}),
		});
		await sendJson({ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body: "hi" } });

		const [injected, template, unauthenticated] = await list();

		expect(unauthenticated).toMatchObject({ status: 401, errorCode: 190, tokenMasked: null, appKey: null });
		expect(template).toMatchObject({ status: 400, errorCode: 132_001 });
		expect(injected).toMatchObject({ status: 500 });
		expect(injected?.errorCode).not.toBeNull();
	});

	it("masks secrets in the query string, in JSON keys and in headers", async () => {
		await graph(`${fixture.phoneNumberId}?access_token=EAAG-secret-value&fields=id`, {
			headers: { "x-api-key": "k-123" },
		});
		await graph(`${fixture.phoneNumberId}/register`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({ messaging_product: "whatsapp", pin: "123456" }),
		});

		const [register, read] = await list();
		const registered = await detail(register!.id);
		const queried = await detail(read!.id);

		expect(queried.query).toBe("access_token=%5Bmasked%5D&fields=id");
		expect(queried.requestHeaders["x-api-key"]).toBe("[masked]");
		expect(JSON.parse(registered.requestBody.text!)).toEqual({ messaging_product: "whatsapp", pin: "[masked]" });

		const everything = JSON.stringify(await exported());

		expect(everything).not.toContain("EAAG-secret-value");
		expect(everything).not.toContain("123456");
		expect(everything).not.toContain("k-123");
	});

	it("never stores a request body it cannot mask: malformed JSON and free text are described, not kept", async () => {
		const secret = "m5-review-dummy-secret";
		const malformed = await graph(`${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: `{"password":"${secret}"`,
		});
		const freeText = await graph(`${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "text/plain" },
			body: `password=${secret}-text`,
		});

		// What the app gets back is unchanged by the logging.
		expect(malformed.status).toBe(400);
		expect(freeText.status).toBeGreaterThanOrEqual(400);

		const bareString = await graph(`${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify(`{"password":"${secret}-string"`),
		});

		expect(bareString.status).toBe(400);

		const [stringEntry, textEntry, jsonEntry] = await list();
		const string = await detail(stringEntry!.id);

		expect(string.requestBody.kind).toBe("omitted");
		expect(string.requestBody.omittedReason).toMatch(/^JSON that is not an object or array/);

		const json = await detail(jsonEntry!.id);
		const text = await detail(textEntry!.id);

		expect(json.requestBody).toEqual({
			kind: "omitted",
			contentType: "application/json",
			size: Buffer.byteLength(`{"password":"${secret}"`),
			omittedReason: expect.stringMatching(/^malformed JSON: not stored/) as string,
			truncated: false,
		});
		expect(text.requestBody.kind).toBe("omitted");
		expect(text.requestBody.omittedReason).toMatch(/^not JSON or a form/);
		expect(text.requestBody.text).toBeUndefined();
		// The diagnosis is still there: status and Meta's error code.
		expect(json.status).toBe(400);
		expect(json.errorCode).not.toBeNull();

		const stored = JSON.stringify([json, text, string, await list(), await exported(), logged]);

		expect(stored).not.toContain(secret);
	});

	it("describes media uploads and downloads without storing their bytes", async () => {
		const form = new FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new File([IMAGE_BYTES], "photo.jpg", { type: "image/jpeg" }));
		form.set("type", "image/jpeg");

		const uploaded = await graph(`${fixture.phoneNumberId}/media`, {
			method: "POST",
			headers: TEST_AUTH_HEADERS,
			body: form,
		});
		const { id } = (await uploaded.json()) as { id: string };
		const resolved = await graph(id, { headers: TEST_AUTH_HEADERS });
		const { url } = (await resolved.json()) as { url: string };
		const mediaUrl = new URL(url);
		// Media URLs point at the Graph listener (WASANDBOX_PUBLIC_URL), which is what logs them.
		const download = await fixture.graphApp.request(mediaUrl.pathname, { headers: TEST_AUTH_HEADERS });

		expect(download.status).toBe(200);

		const [downloaded, , upload] = await list();
		const uploadEntry = await detail(upload!.id);
		const downloadEntry = await detail(downloaded!.id);

		expect(uploadEntry.requestBody).toMatchObject({
			kind: "multipart",
			fields: [
				{ name: "messaging_product", value: "whatsapp" },
				{ name: "file", file: { filename: "photo.jpg", contentType: "image/jpeg", size: IMAGE_BYTES.length } },
				{ name: "type", value: "image/jpeg" },
			],
		});
		expect(downloadEntry.responseBody).toEqual({
			kind: "binary",
			contentType: "image/jpeg",
			size: IMAGE_BYTES.length,
			truncated: false,
		});
		// The media URL's token is its credential: masked in the path like a bearer token.
		expect(downloadEntry.path).toMatch(/^\/whaloc-media\/•+[\w-]{4}$/);
		expect(downloadEntry.path).not.toBe(mediaUrl.pathname);
	});

	it("cuts long textual bodies and says so", async () => {
		const text = "x".repeat(GRAPH_REQUEST_BODY_LIMIT + 100);

		await sendJson({ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body: text } });

		const entry = await latest();

		expect(entry.requestBody.truncated).toBe(true);
		expect(entry.requestBody.text).toHaveLength(GRAPH_REQUEST_BODY_LIMIT);
		expect(entry.requestBody.size).toBeGreaterThan(GRAPH_REQUEST_BODY_LIMIT);
	});

	it("names the registered app whose access token was used", async () => {
		const created = await fixture.app.request("/api/apps", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Billing", accessToken: "billing-access-token" }),
		});
		const { data: app } = (await created.json()) as { data: { key: string } };

		await sendJson(
			{ messaging_product: "whatsapp", to: CONTACT, type: "text", text: { body: "hi" } },
			{ authorization: "Bearer billing-access-token" },
		);

		expect(await list()).toMatchObject([{ appKey: app.key, tokenMasked: "••••••••••••oken" }]);
	});

	it("pages newest first, keeps only the newest entries, and is emptied by a reset or on request", async () => {
		for (let index = 0; index < 3; index += 1) {
			await graph(fixture.phoneNumberId, { headers: TEST_AUTH_HEADERS });
		}

		const all = await list();
		const firstPage = await fixture.app.request("/api/graph-requests?limit=2");
		const page = graphRequestListResponseSchema.parse(await firstPage.json());

		expect(page.data.map(entry => entry.id)).toEqual(all.slice(0, 2).map(entry => entry.id));
		expect(await list(`?before=${String(page.paging.before)}`)).toEqual(all.slice(2));

		await fixture.services.repositories.graphRequests.prune(1);

		expect(await list()).toEqual(all.slice(0, 1));

		const download = graphRequestExportSchema.parse(await exported());

		expect(download.data.map(entry => entry.id)).toEqual([all[0]!.id]);
		expect(download.limit).toBe(fixture.services.domain.graphRequests.limit);

		await fixture.app.request("/api/reset", { method: "POST" });

		expect(await list()).toEqual([]);

		await graph(fixture.phoneNumberId, { headers: TEST_AUTH_HEADERS });
		await fixture.app.request("/api/graph-requests", { method: "DELETE" });

		expect(await list()).toEqual([]);

		const missing = await fixture.app.request("/api/graph-requests/999");

		expect(missing.status).toBe(404);
	});

	it("is not part of a state export, and logs only what reached the Graph port", async () => {
		await graph(fixture.phoneNumberId, { headers: TEST_AUTH_HEADERS });

		const exportResponse = await fixture.app.request("/api/export");
		const snapshot = (await exportResponse.json()) as { tables: Record<string, unknown> };

		expect(Object.keys(snapshot.tables)).not.toContain("graph_requests");

		// A console path asked of the Graph port is a 404 there, and the log says so; the
		// console's own calls (the export above, these reads) never appear.
		const onGraph = await fixture.graphApp.request("/api/graph-requests");

		expect(onGraph.status).toBe(404);

		const entries = await list();

		expect(entries.map(entry => [entry.path, entry.status])).toEqual([
			["/api/graph-requests", 404],
			[`/v25.0/${fixture.phoneNumberId}`, 200],
		]);
	});
});
