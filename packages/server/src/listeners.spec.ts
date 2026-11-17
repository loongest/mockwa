import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, TEST_AUTH_HEADERS, type TestApp } from "./testing/test-app.ts";

/** A seeded contact (`DEFAULT_SEED`), so the send needs no setup. */
const SEEDED_CONTACT = "5571990000001";

/**
 * The two listeners (SPEC §8): port 8888 is the Graph API and nothing else a browser uses;
 * port 8025 is the console and nothing the app under test calls. Each app is driven on its
 * own here, exactly as `main.ts` binds it to its port.
 */
describe("the Graph API and console listeners", () => {
	let fixture: TestApp;
	let webDir: string;

	beforeEach(async () => {
		// A real (if tiny) UI bundle, so a 404 on the console is a refusal and not a missing build.
		webDir = await mkdtemp(path.join(tmpdir(), "mockwa-test-web-"));
		await mkdir(path.join(webDir, "assets"));
		await writeFile(path.join(webDir, "index.html"), '<!doctype html><title>mockwa</title><div id="root"></div>');
		fixture = await createTestApp({ MOCKWA_WEB_DIR: webDir });
	});

	afterEach(async () => {
		await fixture.close();
		await rm(webDir, { recursive: true, force: true });
	});

	function sendText(app: TestApp["graphApp"]) {
		return app.request(`/v25.0/${fixture.phoneNumberId}/messages`, {
			method: "POST",
			headers: { ...TEST_AUTH_HEADERS, "content-type": "application/json" },
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: SEEDED_CONTACT,
				type: "text",
				text: { body: "hi" },
			}),
		});
	}

	it.each(["graphApp", "consoleApp"] as const)("answers /health on the %s", async which => {
		const response = await fixture[which].request("/health");

		expect(response.status).toBe(200);
	});

	describe("port 8888 (Graph API)", () => {
		it("accepts a send and returns a wamid", async () => {
			const response = await sendText(fixture.graphApp);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				messaging_product: "whatsapp",
				messages: [{ id: expect.stringMatching(/^wamid\./) as unknown }],
			});
		});

		it("reads a Graph object", async () => {
			const response = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}`, {
				headers: TEST_AUTH_HEADERS,
			});

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ id: fixture.phoneNumberId });
		});

		it.each(["/", "/api", "/api/health", "/api/state", "/api/ws", "/phone", "/settings", "/webhooks", "/index.html"])(
			"does not serve the console path %s",
			async pathname => {
				const response = await fixture.graphApp.request(pathname);

				expect(response.status).toBe(404);
			},
		);

		it("does not accept control-plane writes", async () => {
			const response = await fixture.graphApp.request("/api/reset", { method: "POST" });

			expect(response.status).toBe(404);
		});
	});

	describe("port 8025 (console)", () => {
		it("serves the control plane", async () => {
			const response = await fixture.consoleApp.request("/api/state");

			expect(response.status).toBe(200);
			expect(JSON.stringify(await response.json())).toContain(fixture.phoneNumberId);
		});

		it("serves the web UI, deep links included", async () => {
			for (const pathname of ["/", "/settings"]) {
				const response = await fixture.consoleApp.request(pathname);

				expect(response.status).toBe(200);
				expect(response.headers.get("content-type")).toMatch(/^text\/html/);
			}
		});

		it.each(["/v25.0", "/v25.0/me", `/v25.0/${"1".repeat(15)}`, "/v19.0/whatever/messages"])(
			"does not serve the Graph path %s, not even through the UI fallback",
			async pathname => {
				const response = await fixture.consoleApp.request(pathname, { headers: TEST_AUTH_HEADERS });

				expect(response.status).toBe(404);
			},
		);

		it("does not accept a Graph send", async () => {
			const response = await sendText(fixture.consoleApp);

			expect(response.status).toBe(404);
		});
	});

	it("shares one engine: a message sent on 8888 is visible on 8025", async () => {
		const sendResponse = await sendText(fixture.graphApp);
		const sent = (await sendResponse.json()) as { messages: [{ id: string }] };
		const response = await fixture.consoleApp.request(
			`/api/conversations/${fixture.phoneNumberId}:${SEEDED_CONTACT}/messages`,
		);

		expect(response.status).toBe(200);
		expect(JSON.stringify(await response.json())).toContain(sent.messages[0].id);
	});

	it("serves media bytes on both ports, so the console can preview what the Graph API stored", async () => {
		const form = new FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", { type: "image/jpeg" }));
		form.set("type", "image/jpeg");

		const uploadResponse = await fixture.graphApp.request(`/v25.0/${fixture.phoneNumberId}/media`, {
			method: "POST",
			headers: TEST_AUTH_HEADERS,
			body: form,
		});
		const uploaded = (await uploadResponse.json()) as { id: string };
		const descriptorResponse = await fixture.consoleApp.request(`/api/media/${uploaded.id}`);
		const descriptor = (await descriptorResponse.json()) as { data: { url: string } };
		const bytesUrl = new URL(descriptor.data.url);
		const bytesPath = bytesUrl.pathname;

		for (const app of [fixture.graphApp, fixture.consoleApp]) {
			const response = await app.request(bytesPath, { headers: TEST_AUTH_HEADERS });

			expect(response.status).toBe(200);
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff]));
		}
	});
});
