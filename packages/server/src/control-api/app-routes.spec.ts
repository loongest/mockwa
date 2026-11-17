import { isValidMetaSignature } from "../domain/meta-json.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startCaptureServer, type CaptureServer } from "../testing/capture-server.ts";
import { readJson } from "../testing/expectations.ts";
import { createTestApp, type TestApp } from "../testing/test-app.ts";

/**
 * `/api/apps` and `/api/webhook-routes` (SPEC §5): the console's side of the webhook model
 * (SPEC §3, "Apps and routing").
 */
interface RoutingBody {
	data: {
		apps: { key: string; name: string; isDefault: boolean; hasAppSecret: boolean; callbackUrl: string | null }[];
		subscriptions: { wabaId: string; appKey: string; overrideCallbackUri: string | null; isImplicit: boolean }[];
		phoneOverrides: { phoneNumberId: string; appKey: string; callbackUri: string }[];
	};
}

interface ErrorBody {
	error: { code: string };
}

describe("apps (SPEC §3, §5)", () => {
	let fixture: TestApp;
	let capture: CaptureServer;

	beforeEach(async () => {
		capture = await startCaptureServer();
		fixture = await createTestApp({
			MOCKWA_WEBHOOK_URL: `${capture.url}/default`,
			MOCKWA_APP_SECRET: "default-secret",
		});
	});

	afterEach(async () => {
		await fixture.close();
		await capture.close();
	});

	function api(path: string, method = "GET", body?: unknown) {
		return fixture.app.request(`/api${path}`, {
			method,
			...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
	}

	async function createBilling() {
		const response = await api("/apps", "POST", {
			name: "Billing",
			callbackUrl: `${capture.url}/billing`,
			appSecret: "billing-secret",
			verifyToken: "billing-verify",
		});

		expect(response.status).toBe(201);

		const { data } = await readJson<{ data: { key: string; id: string } }>(response);

		return data;
	}

	it("lists the default app from the environment, implicitly receiving the seeded WABA", async () => {
		const { data } = await readJson<RoutingBody>(await api("/apps"));

		expect(data.apps).toEqual([expect.objectContaining({ key: "default", isDefault: true, hasAppSecret: true })]);
		expect(data.subscriptions).toEqual([
			expect.objectContaining({ wabaId: fixture.wabaId, appKey: "default", isImplicit: true }),
		]);
	});

	it("creates an app without ever echoing its secrets", async () => {
		const created = await createBilling();
		const listing = await api("/apps");
		const raw = await listing.text();

		expect(created.id).toMatch(/^\d+$/);
		expect(raw).not.toContain("billing-secret");
		expect(raw).not.toContain("billing-verify");
	});

	it("refuses a second app with the same name", async () => {
		await createBilling();

		const response = await api("/apps", "POST", { name: "Billing" });

		expect(response.status).toBe(409);
		const { error } = await readJson<ErrorBody>(response);

		expect(error.code).toBe("app_exists");
	});

	it("keeps the default app read-only", async () => {
		const response = await api("/apps/default", "PATCH", { name: "renamed" });

		expect(response.status).toBe(400);
		const { error } = await readJson<ErrorBody>(response);

		expect(error.code).toBe("default_app_read_only");
	});

	it("answers 404 for an unknown app", async () => {
		const response = await api("/apps/123", "DELETE");

		expect(response.status).toBe(404);
		const { error } = await readJson<ErrorBody>(response);

		expect(error.code).toBe("app_not_found");
	});

	it("routes a WABA to every subscribed app, each copy signed with its own secret", async () => {
		const billing = await createBilling();

		await api(`/apps/default/subscriptions/${fixture.wabaId}`, "PUT", {});
		await api(`/apps/${billing.key}/subscriptions/${fixture.wabaId}`, "PUT", {});

		const routes = await readJson<{ data: { appKey: string; url: string; source: string }[] }>(
			await api(`/webhook-routes?wabaId=${fixture.wabaId}&phoneNumberId=${fixture.phoneNumberId}`),
		);

		expect(routes.data).toEqual([
			expect.objectContaining({ appKey: "default", url: `${capture.url}/default`, source: "app" }),
			expect.objectContaining({ appKey: billing.key, url: `${capture.url}/billing`, source: "app" }),
		]);

		// An inbound message: one `messages` webhook, delivered as soon as it is accepted.
		await api("/inbound", "POST", {
			phoneNumberId: fixture.phoneNumberId,
			from: "5571990000001",
			type: "text",
			text: { body: "to both apps" },
		});
		await fixture.services.domain.tasks.whenIdle();

		const byPath = (suffix: string) => capture.requests.filter(request => request.path.endsWith(suffix));

		expect(byPath("/default").length).toBeGreaterThan(0);
		expect(byPath("/billing")).toHaveLength(byPath("/default").length);

		const [toBilling] = byPath("/billing");

		expect(isValidMetaSignature(toBilling!.headers["x-hub-signature-256"]!, "billing-secret", toBilling!.body)).toBe(
			true,
		);
	});

	it("applies a number override to messages but never to template webhooks", async () => {
		await api(`/apps/default/phone-overrides/${fixture.phoneNumberId}`, "PUT", {
			callbackUri: `${capture.url}/phone`,
			verifyToken: "vt",
		});

		const query = `wabaId=${fixture.wabaId}&phoneNumberId=${fixture.phoneNumberId}`;
		const messages = await readJson<{ data: { url: string; source: string }[] }>(
			await api(`/webhook-routes?${query}&field=messages`),
		);
		const templates = await readJson<{ data: { url: string; source: string }[] }>(
			await api(`/webhook-routes?${query}&field=message_template_status_update`),
		);

		expect(messages.data).toEqual([expect.objectContaining({ url: `${capture.url}/phone`, source: "phone_number" })]);
		expect(templates.data).toEqual([expect.objectContaining({ url: `${capture.url}/default`, source: "app" })]);
	});

	it("removes an app with its subscriptions, overrides and pending retries", async () => {
		const billing = await createBilling();

		await api(`/apps/${billing.key}/subscriptions/${fixture.wabaId}`, "PUT", {});
		await api(`/apps/${billing.key}/phone-overrides/${fixture.phoneNumberId}`, "PUT", {
			callbackUri: `${capture.url}/phone`,
		});

		const deleted = await api(`/apps/${billing.key}`, "DELETE");

		expect(deleted.status).toBe(204);

		const { data } = await readJson<RoutingBody>(await api("/apps"));

		expect(data.apps.map(app => app.key)).toEqual(["default"]);
		expect(data.subscriptions.filter(subscription => subscription.appKey === billing.key)).toEqual([]);
		expect(data.phoneOverrides).toEqual([]);
	});

	it("runs an app's verification handshake against its own URL and token", async () => {
		const billing = await createBilling();

		capture.respondWith(request => ({ status: 200, body: request.query.get("hub.challenge") ?? "" }));

		const { data } = await readJson<{ data: { ok: boolean; url: string } }>(
			await api(`/apps/${billing.key}/handshake`, "POST"),
		);

		expect(data).toMatchObject({ ok: true });
		expect(data.url).toContain("/billing");
		expect(capture.requests.at(-1)!.query.get("hub.verify_token")).toBe("billing-verify");
	});

	it("announces routing changes on the event bus", async () => {
		const events: string[] = [];

		fixture.services.domain.events.subscribe(event => {
			events.push(event.type);
		});
		await createBilling();

		expect(events).toContain("webhook_routing.changed");
	});
});
