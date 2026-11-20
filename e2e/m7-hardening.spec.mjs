import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

/**
 * Milestone M7 acceptance in a browser (AC-19): the public phone and the admin console work under
 * their Content-Security-Policy, and hostile message text — markup, script, event handlers — is
 * shown as text in both and never runs. The instance is the one e2e/m7-hardening.mjs checks.
 *
 * Environment, required (e2e/targets.mjs): M7_CONSOLE_URL (the Playwright baseURL), with an
 * explicit port. Optional: M7_ADMIN_TOKEN (m7-admin-token-0123456789).
 */

readTargets(process.env, { suite: "m7-hardening", urls: ["M7_CONSOLE_URL"] });

const ADMIN_TOKEN = process.env.M7_ADMIN_TOKEN ?? "m7-admin-token-0123456789";
const HOSTILE = `<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script><b>bold?</b>`;

/** Collects what would show an attack or a policy that breaks the page. */
function watch(page) {
	const problems = [];

	page.on("dialog", async dialog => {
		problems.push(`dialog: ${dialog.message()}`);
		await dialog.dismiss();
	});
	page.on("console", message => {
		if (message.type() === "error" && /Content Security Policy|Refused to/i.test(message.text())) {
			problems.push(`csp: ${message.text()}`);
		}
	});
	page.on("pageerror", error => {
		problems.push(`error: ${error.message}`);
	});

	return problems;
}

test("AC-19: the public phone runs under its policy and shows hostile text as text", async ({ page }) => {
	const problems = watch(page);

	await page.goto("/phone");
	await page.getByTestId("phone-start-demo").click();
	await expect(page.getByTestId("phone-connection")).toHaveAttribute("data-connection", "open");
	await page.getByTestId("phone-chat").first().click();
	await page.getByLabel("Message").fill(HOSTILE);
	await page.getByRole("button", { name: "Send" }).click();

	const echo = page.getByTestId("phone-message").filter({ hasText: `echo: ${HOSTILE}` });

	await expect(echo).toBeVisible();
	await expect(page.locator("[data-testid='phone-thread'] img[src='x']")).toHaveCount(0);
	await expect(page.locator("[data-testid='phone-thread'] b")).toHaveCount(0);
	expect(await page.evaluate(() => globalThis.__pwned)).toBeUndefined();
	expect(problems).toEqual([]);

	// Leave, so this browser's address keeps its share of sessions for the next test.
	await page.getByRole("button", { name: "Back to chats" }).click();
	await page.getByRole("button", { name: "Switch" }).click();
	await page.getByTestId("phone-leave-demo").click();
	await expect(page.getByTestId("phone-start-demo")).toBeVisible();
});

test("AC-19: the admin console runs under its policy and shows a visitor's hostile text as text", async ({
	browser,
	page,
}) => {
	// A visitor writes something hostile first.
	const visitorContext = await browser.newContext();
	const visitor = await visitorContext.newPage();

	await visitor.goto("/phone");
	await visitor.getByTestId("phone-start-demo").click();
	await expect(visitor.getByTestId("phone-connection")).toHaveAttribute("data-connection", "open");
	await visitor.getByTestId("phone-chat").first().click();
	await visitor.getByLabel("Message").fill(HOSTILE);
	await visitor.getByRole("button", { name: "Send" }).click();
	await expect(visitor.getByTestId("phone-message").filter({ hasText: `echo: ${HOSTILE}` })).toBeVisible();

	const problems = watch(page);

	await page.goto("/admin");
	await page.getByLabel("Admin token").fill(ADMIN_TOKEN);
	await page.getByRole("button", { name: "Sign in" }).click();
	await expect(page.getByRole("navigation").first()).toBeVisible();

	// Every view loads under the policy.
	for (const path of ["/settings", "/clock", "/scenarios", "/requests", "/webhooks", "/templates"]) {
		await page.goto(path);
		await expect(page.getByRole("navigation").first()).toBeVisible();
	}

	// The chats view lists the visitor's conversation, last message included, as plain text.
	await page.goto("/");
	await expect(page.getByText(`echo: ${HOSTILE}`).first()).toBeVisible();
	await page.getByText(`echo: ${HOSTILE}`).first().click();
	await expect(page.getByText(HOSTILE, { exact: true }).first()).toBeVisible();
	await expect(page.locator("img[src='x']")).toHaveCount(0);
	expect(await page.evaluate(() => globalThis.__pwned)).toBeUndefined();
	expect(problems).toEqual([]);

	await visitor.getByRole("button", { name: "Back to chats" }).click();
	await visitor.getByRole("button", { name: "Switch" }).click();
	await visitor.getByTestId("phone-leave-demo").click();
	await visitorContext.close();
});
