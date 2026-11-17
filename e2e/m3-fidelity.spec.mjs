import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

// Required, no defaults (e2e/targets.mjs): M3_CONSOLE_URL is the project's baseURL.
readTargets(process.env, { suite: "m3-fidelity", urls: ["M3_CONSOLE_URL"] });

/**
 * The M3 console views against the instance e2e/m3-fidelity.mjs drives (see
 * .github/workflows/docker.yml): the customer service window badge on a conversation, and the
 * messaging rules in Settings. Each test brings its own contact, written to with a
 * caller-supplied timestamp, so it does not depend on what the Node checks left behind.
 */
const DAY_MS = 86_400_000;

async function scope(request) {
	const response = await request.get("/api/state");
	const { wabas } = await response.json();

	return { wabaId: wabas[0].id, phoneNumberId: wabas[0].phoneNumbers[0].id };
}

async function receive(request, phoneNumberId, from, timestamp) {
	const response = await request.post("/api/inbound", {
		data: { phoneNumberId, from, profileName: `M3 ${from}`, type: "text", text: { body: "hi" }, timestamp },
	});

	expect(response.status()).toBe(201);
}

test("a conversation shows whether its customer service window is open", async ({ page, request }) => {
	const { wabaId, phoneNumberId } = await scope(request);
	const open = `55119000032${String(Date.now() % 100).padStart(2, "0")}`;
	const closed = `55119000033${String(Date.now() % 100).padStart(2, "0")}`;

	const now = new Date();
	const stale = new Date(Date.now() - DAY_MS - 60_000);

	await receive(request, phoneNumberId, open, now.toISOString());
	await receive(request, phoneNumberId, closed, stale.toISOString());

	await page.goto(`/w/${wabaId}/p/${phoneNumberId}/chats/${open}`);
	await expect(page.locator(".chat__header")).toContainText("Service window open until");

	await page.goto(`/w/${wabaId}/p/${phoneNumberId}/chats/${closed}`);
	await expect(page.locator(".chat__header")).toContainText(/Service window closed .*: templates only/);
});

test("Settings lists the messaging rules this instance enforces", async ({ page }) => {
	await page.goto("/settings#messaging-rules");

	const section = page.locator("#messaging-rules");

	await expect(section.getByText("MOCKWA_SERVICE_WINDOW")).toBeVisible();
	await expect(section.getByText("1d")).toBeVisible();
	await expect(section.getByText("5/s per number")).toBeVisible();
	await expect(section.getByText("1 per 1m, bursts of 2")).toBeVisible();
	await expect(section.getByText("2 users / 24h")).toBeVisible();
	await expect(section.getByText(/of 2 users reached outside a window/)).toBeVisible();
});
