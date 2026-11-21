import { stateResponseSchema } from "@wasandbox/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { META_ID_PATTERN } from "../domain/index.ts";
import { readJson, stringMatching } from "../testing/expectations.ts";
import { createTestApp, TEST_AUTH_HEADERS, TEST_PUBLIC_URL, type TestApp } from "../testing/test-app.ts";

/**
 * `subscribed_apps` on a WABA (SPEC §2.20).
 *
 * whaloc plays exactly one app — itself — so the surface is a per-WABA on/off fact. What these
 * tests pin is the round trip a consumer performs at startup, Meta's nested listing shape, and
 * the documented divergences: an idempotent `DELETE`, and deliveries that keep going out
 * whatever the subscription says.
 */
interface SubscribedAppsPage {
	data: { whatsapp_business_api_data: { id: string; name: string; link: string } }[];
}

describe("subscribed apps (SPEC §2.20)", () => {
	let fixture: TestApp;

	beforeEach(async () => {
		fixture = await createTestApp();
	});

	afterEach(async () => {
		await fixture.close();
	});

	function call(method: string, wabaId = fixture.wabaId) {
		return fixture.app.request(`/v25.0/${wabaId}/subscribed_apps`, { method, headers: TEST_AUTH_HEADERS });
	}

	async function listed(): Promise<SubscribedAppsPage["data"]> {
		const page = await readJson<SubscribedAppsPage>(await call("GET"));

		return page.data;
	}

	it("lists nothing until an app subscribes", async () => {
		const response = await call("GET");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ data: [] });
	});

	it("subscribes, then reports the app in Meta's nested shape", async () => {
		const response = await call("POST");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(await listed()).toEqual([
			{
				whatsapp_business_api_data: {
					id: stringMatching(META_ID_PATTERN),
					name: "whaloc",
					link: TEST_PUBLIC_URL,
				},
			},
		]);
	});

	it("records when it happened, on the WABA", async () => {
		await call("POST");

		expect(await fixture.services.repositories.wabas.findById(fixture.wabaId)).toMatchObject({
			subscribedAt: stringMatching(/^\d{4}-\d{2}-\d{2}T/),
		});
	});

	it("announces the WABA so the UI can show the subscription", async () => {
		const events: string[] = [];

		fixture.services.domain.events.subscribe(event => {
			events.push(event.type);
		});

		await call("POST");

		// The routing view changes with it: the console's Apps settings listen for that one.
		expect(events).toEqual(["waba.changed", "webhook_routing.changed", "graph_request.logged"]);
	});

	it("unsubscribes, and stays a success when there was nothing to remove", async () => {
		await call("POST");

		const first = await call("DELETE");

		expect(first.status).toBe(200);
		expect(await first.json()).toEqual({ success: true });
		expect(await listed()).toEqual([]);

		const second = await call("DELETE");

		expect(second.status).toBe(200);
		expect(await second.json()).toEqual({ success: true });
	});

	it("derives a stable app id, and takes WASANDBOX_APP_ID when it is set", async () => {
		await call("POST");

		const [derived] = await listed();

		await fixture.close();
		fixture = await createTestApp();
		await call("POST");

		const [again] = await listed();

		expect(again?.whatsapp_business_api_data.id).toBe(derived?.whatsapp_business_api_data.id);

		await fixture.close();
		fixture = await createTestApp({ WASANDBOX_APP_ID: "1234567890" });
		await call("POST");

		const [configured] = await listed();

		expect(configured?.whatsapp_business_api_data.id).toBe("1234567890");
	});

	it("names the app in GET /api/state, subscription included", async () => {
		await call("POST");

		const response = await fixture.app.request("/api/state");
		const state = stateResponseSchema.parse(await response.json());

		expect(state.app).toEqual({ id: stringMatching(META_ID_PATTERN), name: "whaloc" });
		expect(state.wabas[0]?.subscribedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it.each(["GET", "POST", "DELETE"])("reports an unknown WABA as a missing object on %s", async method => {
		const response = await call(method, "888888888888888");

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
	});

	/**
	 * The divergence worth being explicit about: `WASANDBOX_WEBHOOK_URL` decides where webhooks go,
	 * so a `DELETE` here does not silence them. A dev tool that quietly stopped delivering would
	 * be a support question, not a feature.
	 */
	it("keeps delivering webhooks while nothing is subscribed", async () => {
		await call("DELETE");
		await fixture.app.request("/api/inbound", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				phoneNumberId: fixture.phoneNumberId,
				from: "5571990000001",
				type: "text",
				text: { body: "still delivered" },
			}),
		});
		await fixture.services.domain.tasks.whenIdle();

		expect(await fixture.services.repositories.webhookDeliveries.list()).not.toEqual([]);
	});

	describe("overrides and apps (SPEC §2.20, §3)", () => {
		const BILLING_TOKEN = "billing-token";
		let multi: TestApp;

		beforeEach(async () => {
			multi = await createTestApp({
				WASANDBOX_WEBHOOK_URL: "http://127.0.0.1:9/default",
				WASANDBOX_APPS: JSON.stringify([
					{
						id: "200000000000002",
						name: "Billing",
						accessToken: BILLING_TOKEN,
						callbackUrl: "http://127.0.0.1:9/billing",
					},
				]),
			});
		});

		afterEach(async () => {
			await multi.close();
		});

		function asBilling(path: string, init: { method?: string; body?: unknown } = {}) {
			return multi.app.request(`/v25.0/${path}`, {
				method: init.method ?? "GET",
				headers: { authorization: `Bearer ${BILLING_TOKEN}`, "content-type": "application/json" },
				...(init.body !== undefined && { body: JSON.stringify(init.body) }),
			});
		}

		it("acts on the app the access token belongs to", async () => {
			await asBilling(`${multi.wabaId}/subscribed_apps`, { method: "POST" });

			const page = await readJson<SubscribedAppsPage>(await asBilling(`${multi.wabaId}/subscribed_apps`));

			expect(page.data.map(entry => entry.whatsapp_business_api_data)).toEqual([
				{ id: "200000000000002", name: "Billing", link: TEST_PUBLIC_URL },
			]);
		});

		it("sets a WABA override, reports it next to the app, and clears it with a bare POST", async () => {
			const set = await asBilling(`${multi.wabaId}/subscribed_apps`, {
				method: "POST",
				body: { override_callback_uri: "https://override.test/waba", verify_token: "vt" },
			});

			expect(set.status).toBe(200);
			expect(await set.json()).toEqual({ success: true });
			expect(await readJson(await asBilling(`${multi.wabaId}/subscribed_apps`))).toEqual({
				data: [
					{
						whatsapp_business_api_data: { id: "200000000000002", name: "Billing", link: TEST_PUBLIC_URL },
						override_callback_uri: "https://override.test/waba",
					},
				],
			});

			await asBilling(`${multi.wabaId}/subscribed_apps`, { method: "POST" });

			const page = await readJson<{ data: Record<string, unknown>[] }>(
				await asBilling(`${multi.wabaId}/subscribed_apps`),
			);

			expect(page.data[0]).not.toHaveProperty("override_callback_uri");
		});

		it("needs the override URL and its verify token together, as Meta does", async () => {
			const response = await asBilling(`${multi.wabaId}/subscribed_apps`, {
				method: "POST",
				body: { override_callback_uri: "https://override.test/waba" },
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100 } });
		});

		it("rejects an override URL longer than Meta's 200 characters", async () => {
			const response = await asBilling(`${multi.wabaId}/subscribed_apps`, {
				method: "POST",
				body: { override_callback_uri: `https://override.test/${"a".repeat(200)}`, verify_token: "vt" },
			});

			expect(response.status).toBe(400);
		});

		it("sets, reads and removes a number's webhook_configuration", async () => {
			await asBilling(`${multi.wabaId}/subscribed_apps`, {
				method: "POST",
				body: { override_callback_uri: "https://override.test/waba", verify_token: "vt" },
			});

			const set = await asBilling(multi.phoneNumberId, {
				method: "POST",
				body: { webhook_configuration: { override_callback_uri: "https://override.test/phone", verify_token: "vt" } },
			});

			expect(set.status).toBe(200);
			expect(await set.json()).toEqual({ success: true });
			expect(await readJson(await asBilling(`${multi.phoneNumberId}?fields=webhook_configuration`))).toEqual({
				webhook_configuration: {
					phone_number: "https://override.test/phone",
					whatsapp_business_account: "https://override.test/waba",
					application: "http://127.0.0.1:9/billing",
				},
				id: multi.phoneNumberId,
			});

			await asBilling(multi.phoneNumberId, {
				method: "POST",
				body: { webhook_configuration: { override_callback_uri: "" } },
			});

			const after = await readJson<{ webhook_configuration: Record<string, string> }>(
				await asBilling(`${multi.phoneNumberId}?fields=webhook_configuration`),
			);

			expect(after.webhook_configuration).not.toHaveProperty("phone_number");
		});

		it("keeps the uniform missing-object envelope for an unknown number", async () => {
			const response = await asBilling("999999999999999", {
				method: "POST",
				body: { webhook_configuration: { override_callback_uri: "https://override.test/phone", verify_token: "vt" } },
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ error: { code: 100, error_subcode: 33 } });
		});
	});
});
