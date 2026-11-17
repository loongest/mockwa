import { expect, test } from "@playwright/test";

/**
 * Milestone M2 in the console: the apps of e2e/fixtures/m2-apps.json in Settings, and a failing
 * delivery's retry in the Webhooks view — the same instance e2e/m2-webhooks.mjs checks from the
 * outside.
 *
 * Environment: M2_CONSOLE_URL (the Playwright baseURL, http://127.0.0.1:28025),
 * M2_SALES_ECHO_URL (http://127.0.0.1:3003).
 */

const SALES_ECHO_URL = process.env.M2_SALES_ECHO_URL ?? "http://127.0.0.1:3003";
/** From e2e/fixtures/m2-seed.json. */
const SALES_PHONE = "310000000000001";
const SALES_CUSTOMER = "60123451001";

test.afterEach(async ({ request }) => {
	await request.delete(`${SALES_ECHO_URL}/fail`);
});

test("Settings lists each app with its credentials set, never their values", async ({ page }) => {
	await page.goto("/settings");

	const section = page.locator("#apps");

	await expect(section.getByRole("button", { name: "Delete Sales App" })).toBeVisible();
	await expect(section.getByRole("button", { name: "Delete Support App" })).toBeVisible();
	// The default app comes from the environment: it cannot be deleted from here.
	await expect(section.getByRole("button", { name: "Delete whaloc" })).toHaveCount(0);
	await expect(section.getByLabel("Sales App subscribed to Acme Sales")).toBeChecked();
	await expect(section.getByLabel("Sales App subscribed to Acme Support")).not.toBeChecked();
	await expect(section.getByText("m2-sales-secret")).toHaveCount(0);
});

test("a failing delivery shows its app and next retry, and the retry can be cancelled", async ({ page, request }) => {
	const text = `m2-ui-${String(Date.now())}`;

	await request.put(`${SALES_ECHO_URL}/fail`, { data: { status: 500 } });
	await request.post("/api/inbound", {
		data: { phoneNumberId: SALES_PHONE, from: SALES_CUSTOMER, type: "text", text: { body: text } },
	});

	/** The webhook goes out after `/api/inbound` answers, so the log is polled for it. */
	async function findDelivery() {
		const logged = await request.get("/api/webhook-deliveries?limit=20");
		const { data } = await logged.json();

		return data.find(candidate => candidate.requestBody.includes(text)) ?? null;
	}

	await expect.poll(findDelivery).toMatchObject({ responseStatus: 500, outcome: "retrying" });

	const delivery = await findDelivery();

	await page.goto("/webhooks");

	const row = page.locator("tr.delivery").filter({ has: page.getByLabel(`Toggle delivery ${delivery.id}`) });

	await expect(row.getByText("Sales App")).toBeVisible();
	await expect(row.getByText(/retry at/)).toBeVisible();

	await row.getByLabel(`Toggle delivery ${delivery.id}`).click();
	await page.getByRole("button", { name: "Cancel retry" }).click();

	await expect(row.getByText("gave up")).toBeVisible();
});
