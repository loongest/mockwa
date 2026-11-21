import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

// Required, no defaults (e2e/targets.mjs): CONSOLE_URL is the project's baseURL.
const { GRAPH_URL } = readTargets(process.env, { suite: "m0-console", urls: ["CONSOLE_URL", "GRAPH_URL"] });

/** A seeded contact (`DEFAULT_SEED`), so nothing has to be created first. */
const CONTACT = { waId: "5571990000002", name: "Bruno Lima" };

test("the console on 8025 shows a conversation the Graph API on 8888 carried", async ({ page, request }) => {
	const stateResponse = await request.get("/api/state");
	const { wabas } = await stateResponse.json();
	const phoneNumberId = wabas[0].phoneNumbers[0].id;
	const text = `from playwright ${String(Date.now())}`;

	const sent = await request.post(`${GRAPH_URL}/v25.0/${phoneNumberId}/messages`, {
		headers: { authorization: "Bearer playwright" },
		data: { messaging_product: "whatsapp", to: CONTACT.waId, type: "text", text: { body: text } },
	});

	expect(sent.status()).toBe(200);

	await page.goto("/");

	await expect(page.locator(".topbar__brand-name")).toHaveText("WaSandbox");
	// The badge only says "live" once the WebSocket on 8025 is open.
	await expect(page.locator(".connection")).toHaveText("live");

	await page.getByText(CONTACT.name).first().click();
	// The conversation list previews the same text, so look inside the open thread only.
	await expect(page.locator(".messages").getByText(text)).toBeVisible();
});

test("the console does not hand Graph routes to the UI", async ({ request }) => {
	const response = await request.get("/v25.0/me", { headers: { authorization: "Bearer playwright" } });

	expect(response.status()).toBe(404);
});
