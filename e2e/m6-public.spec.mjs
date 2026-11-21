import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

/**
 * Milestone M6 acceptance in a browser (AC-14, AC-15, AC-16): the public Virtual Phone of a
 * WASANDBOX_MODE=public instance — in CI, the built Docker image — with the example echo app as the
 * app under test. Every test runs in a fresh browser context, so each is a new anonymous visitor.
 * The HTTP half (every route, quotas, cleanup, restart) is e2e/m6-public.mjs.
 *
 * Environment, required (e2e/targets.mjs): M6_CONSOLE_URL (the Playwright baseURL), with an
 * explicit port. Optional: M6_ADMIN_TOKEN (m6-admin-token-0123456789). The instance's session TTL
 * must be short (20 s in CI): one test waits it out.
 */

const { M6_CONSOLE_URL: CONSOLE_URL } = readTargets(process.env, { suite: "m6-public", urls: ["M6_CONSOLE_URL"] });
const ADMIN_TOKEN = process.env.M6_ADMIN_TOKEN ?? "m6-admin-token-0123456789";

/** Opens the demo in this page, starts it, and returns the visitor's first number. */
async function startDemo(page) {
	await page.goto("/phone");
	await page.getByTestId("phone-start-demo").click();
	await expect(page.getByTestId("phone-screen")).toBeVisible();
	await expect(page.getByTestId("phone-connection")).toHaveAttribute("data-connection", "open");

	return page.getByTestId("phone-screen").evaluate(element => element.dataset.waId);
}

async function openChat(page) {
	await page.getByTestId("phone-chat").first().click();
	await expect(page.getByTestId("phone-thread")).toHaveAttribute("data-state", "ready");
}

async function send(page, text) {
	await page.getByLabel("Message").fill(text);
	await page.getByRole("button", { name: "Send" }).click();
}

function bubble(page, text) {
	return page.getByTestId("phone-message").filter({ hasText: text });
}

test.describe("the public Virtual Phone", () => {
	test("AC-14: a fresh visitor gets its own numbers, messages the business and taps the app's buttons", async ({
		page,
	}) => {
		await page.goto("/phone");
		await expect(page.getByTestId("phone-welcome")).toBeVisible();

		const waId = await startDemo(page);

		expect(waId).toMatch(/^999\d{12}$/);
		await expect(page.getByTestId("phone-identity-name")).toContainText("CUSTOMER");

		await openChat(page);
		await send(page, "hello from a browser");
		await expect(bubble(page, "echo: hello from a browser")).toBeVisible();

		await send(page, "menu");
		await page.getByTestId("phone-message").getByRole("button", { name: "Confirm" }).last().click();
		await expect(bubble(page, "selected: Confirm")).toBeVisible();

		// The visitor's own numbers are all the picker offers: one per role of the template.
		await page.getByRole("button", { name: "Back to chats" }).click();
		await page.getByRole("button", { name: "Switch" }).click();
		await expect(page.getByTestId("phone-identity")).toHaveCount(2);
		await expect(page.getByTestId("phone-demo-limits")).toContainText("without activity");
	});

	test("AC-15: two visitors see only their own conversations, even when the URL names another's number", async ({
		browser,
	}) => {
		const first = await browser.newContext({ baseURL: CONSOLE_URL });
		const second = await browser.newContext({ baseURL: CONSOLE_URL });
		const ana = await first.newPage();
		const bruno = await second.newPage();

		try {
			const anaWaId = await startDemo(ana);
			const brunoWaId = await startDemo(bruno);

			expect(anaWaId).not.toBe(brunoWaId);

			await openChat(ana);
			await openChat(bruno);
			await send(ana, "only ana should see this");
			await send(bruno, "only bruno should see this");
			await expect(bubble(ana, "echo: only ana should see this")).toBeVisible();
			await expect(bubble(bruno, "echo: only bruno should see this")).toBeVisible();
			await expect(ana.getByTestId("phone-thread")).not.toContainText("bruno");
			await expect(bruno.getByTestId("phone-thread")).not.toContainText("ana");

			// Bruno pastes Ana's link: the phone offers him his own numbers instead.
			await bruno.goto(`/phone?as=${anaWaId}`);
			await expect(bruno.getByTestId("phone-identity")).toHaveCount(2);
			await expect(bruno.locator(`[data-testid="phone-identity"][data-wa-id="${anaWaId}"]`)).toHaveCount(0);
			await expect(bruno.getByTestId("phone-screen")).toHaveCount(0);
		} finally {
			await first.close();
			await second.close();
		}
	});

	test("leaving the demo removes the session; a new one gets new numbers", async ({ page }) => {
		const waId = await startDemo(page);

		await page.getByRole("button", { name: "Switch" }).click();
		await page.getByTestId("phone-leave-demo").click();
		await expect(page.getByTestId("phone-start-demo")).toHaveText("Start demo");

		const next = await startDemo(page);

		expect(next).not.toBe(waId);
	});

	test("an idle session ends with an explanation and an offer to start again", async ({ page }) => {
		test.setTimeout(90_000);
		await startDemo(page);
		await expect(page.getByTestId("phone-session-ended")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("phone-start-demo")).toHaveText("Start a new demo");

		// Reloading keeps the explanation: the server still knows this browser's session ended.
		await page.reload();
		await expect(page.getByTestId("phone-start-demo")).toBeVisible();
	});

	test("AC-16: the console is not served without the admin token, and opens after signing in", async ({ page }) => {
		for (const path of ["/", "/settings"]) {
			const response = await page.goto(path);

			expect(response?.status()).toBe(404);
		}

		await page.goto("/admin");
		await page.getByLabel("Admin token").fill("not-the-admin-token");
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page).toHaveURL(/\/admin\?error=invalid$/);

		await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
		await page.getByRole("button", { name: "Sign in" }).click();
		await expect(page).toHaveURL(`${CONSOLE_URL}/`);
		await expect(page.getByRole("navigation").first()).toBeVisible();
	});
});
