import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

/**
 * M4 in the browser: the virtual phone stays live on the virtual clock. Runs against the
 * instance e2e/m4-clock-scenarios.mjs drives (MOCKWA_CLOCK=virtual, the default seed, status
 * rungs at sent:0, delivered:+2m, read:+4m, the example echo app as the app under test; see
 * .github/workflows/docker.yml). It resets that instance first, so the clock is at its start.
 *
 * Environment, required (e2e/targets.mjs): M4_CONSOLE_URL, the project's baseURL. Optional:
 * M4_CLOCK_START (2026-06-01T08:00:00.000Z), the instance's MOCKWA_CLOCK_START.
 */

readTargets(process.env, { suite: "m4-clock", urls: ["M4_CONSOLE_URL"] });

const START = new Date(process.env.M4_CLOCK_START ?? "2026-06-01T08:00:00.000Z");
/** The default seed's first contact and business (packages/server/src/config/seed.ts). */
const CUSTOMER = { waId: "5571990000001", name: "Ana Souza" };
const BUSINESS = "whaloc Test Business";

function bubble(page, text) {
	return page.getByTestId("phone-message").filter({ hasText: text });
}

async function clock(request) {
	const response = await request.get("/api/clock");
	const body = await response.json();

	return body.data;
}

async function advance(request, by) {
	const response = await request.post("/api/clock/advance", { data: { by } });

	expect(response.status()).toBe(200);
}

test("the virtual phone shows replies at virtual time and status changes live as the clock moves", async ({
	page,
	request,
}) => {
	const reset = await request.post("/api/reset");

	expect(reset.status()).toBe(200);

	const before = await clock(request);

	expect(before).toMatchObject({ mode: "virtual", now: START.toISOString() });

	await page.goto("/phone");
	await page.locator(`[data-testid="phone-identity"][data-wa-id="${CUSTOMER.waId}"]`).click();
	await expect(page.getByTestId("phone-identity-name")).toContainText(CUSTOMER.name);
	await expect(page.getByTestId("phone-connection")).toHaveAttribute("data-connection", "open");
	await page.getByTestId("phone-chat").filter({ hasText: BUSINESS }).click();
	await expect(page.getByTestId("phone-thread")).toHaveAttribute("data-state", "ready");

	const text = `on virtual time ${String(Date.now())}`;

	await page.getByLabel("Message").fill(text);
	await page.getByRole("button", { name: "Send" }).click();

	// The echo app's reply arrives live, stamped with the virtual instant, not the wall clock.
	const reply = bubble(page, `echo: ${text}`);

	await expect(reply).toHaveAttribute("data-direction", "received");

	const shownAt = await reply.locator("time").evaluate(element => element.dateTime);

	expect(Date.parse(shownAt)).toBe(START.getTime());

	// The clock stands still, so the reply stays at "sent" until it is moved…
	await expect(reply).toHaveAttribute("data-status", "sent");
	await page.waitForTimeout(500);
	await expect(reply).toHaveAttribute("data-status", "sent");

	// …and the next rung shows up without a reload once it is (the open chat then reads it).
	await advance(request, "2m");
	await expect(reply).toHaveAttribute("data-status", "read");

	const after = await clock(request);

	expect(Date.parse(after.now)).toBe(START.getTime() + 2 * 60_000);
});
