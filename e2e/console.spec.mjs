import { expect, test } from "@playwright/test";

const GRAPH_URL = process.env.GRAPH_URL ?? "http://127.0.0.1:8888";

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

	await expect(page.locator(".topbar__brand-name")).toHaveText("mockwa");
	// The badge only says "live" once the WebSocket on 8025 is open.
	await expect(page.locator(".connection")).toHaveText("live");

	await page.getByText(CONTACT.name).first().click();
	await expect(page.getByText(text)).toBeVisible();
});

test("the console does not hand Graph routes to the UI", async ({ request }) => {
	const response = await request.get("/v25.0/me", { headers: { authorization: "Bearer playwright" } });

	expect(response.status()).toBe(404);
});
