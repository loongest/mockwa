import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readTargets } from "./targets.mjs";

/**
 * M5 in the browser (AC-13): the console on simulator time. Runs against the instance
 * e2e/m5-console.mjs drives (WASANDBOX_CLOCK=virtual, the default seed, the example echo app as the
 * app under test; see .github/workflows/docker.yml). Every test resets that instance first.
 *
 * Environment, required (e2e/targets.mjs): M5_CONSOLE_URL, the project's baseURL, and
 * M5_GRAPH_URL, the same instance's Graph port (for a request the app under test would make). Optional:
 * M5_CLOCK_START (2026-07-01T08:00:00.000Z), the instance's WASANDBOX_CLOCK_START.
 */

const { M5_GRAPH_URL: GRAPH_URL } = readTargets(process.env, {
	suite: "m5-console",
	urls: ["M5_CONSOLE_URL", "M5_GRAPH_URL"],
});

test.describe.configure({ mode: "serial" });

const START = new Date(process.env.M5_CLOCK_START ?? "2026-07-01T08:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The default seed (packages/server/src/config/seed.ts). */
const WABA_ID = "666635535888644";
const PHONE_NUMBER_ID = "573542517421694";
const ANA = { waId: "5571990000001", name: "Ana Souza" };

function at(offsetMs) {
	const instant = new Date(START.getTime() + offsetMs);

	return instant.toISOString();
}

async function inbound(request, from, text) {
	const response = await request.post("/api/inbound", {
		data: { phoneNumberId: PHONE_NUMBER_ID, from, type: "text", text: { body: text } },
	});

	expect(response.status()).toBe(201);
}

async function serviceWindow(request) {
	const response = await request.get(`/api/service-window?phoneNumberId=${PHONE_NUMBER_ID}&waId=${ANA.waId}`);

	return response.json();
}

async function advance(request, by) {
	const response = await request.post("/api/clock/advance", { data: { by } });

	expect(response.status()).toBe(200);
}

test.beforeEach(async ({ request }) => {
	const reset = await request.post("/api/reset");

	expect(reset.status()).toBe(200);
});

test("the Clock view shows simulator time, moves it once per click and runs the next event", async ({
	page,
	request,
}) => {
	await page.goto("/clock");
	await expect(page.getByTestId("clock-mode")).toHaveText("virtual");
	await expect(page.getByTestId("clock-now")).toHaveAttribute("data-now", at(0));
	await expect(page.getByTestId("clock-badge")).toHaveAttribute("data-now", at(0));
	await expect(page.getByTestId("clock-explainer")).toContainText("the app under test keeps its own clock");

	// A double click is one move, not two: the controls lock while the first one runs.
	await page.getByRole("button", { name: "+1h" }).dblclick();
	await expect(page.getByTestId("clock-move")).toBeVisible();
	await expect(page.getByTestId("clock-now")).toHaveAttribute("data-now", at(HOUR));
	await page.waitForTimeout(300);
	await expect(page.getByTestId("clock-now")).toHaveAttribute("data-now", at(HOUR));

	// A move made elsewhere (the API, the CLI, a scenario) shows up without a reload.
	await advance(request, "5m");
	await expect(page.getByTestId("clock-badge")).toHaveAttribute("data-now", at(HOUR + 5 * MINUTE));

	// An inbound message makes the echo app reply; its status rungs wait on the clock.
	await inbound(request, ANA.waId, "pending please");
	await page.getByRole("button", { name: "Refresh" }).click();
	await expect(page.getByTestId("clock-pending")).toBeVisible();
	await page.getByRole("button", { name: "Run the next event" }).click();
	await expect(page.getByTestId("clock-fired").first()).toBeVisible();
	await expect(page.getByTestId("clock-error")).toHaveCount(0);
});

test("the service-window badge follows simulator time: open, closed at the boundary, reopened, expired by hand", async ({
	page,
	request,
}) => {
	await inbound(request, ANA.waId, "open the window");
	await page.goto(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats/${ANA.waId}`);

	const badge = page.getByTestId("service-window");

	await expect(badge).toHaveAttribute("data-state", "open");
	await expect(badge).toHaveAttribute("data-expires-at", at(DAY));
	await expect(badge).toContainText("1d 0h left");

	await advance(request, DAY - MINUTE);
	await expect(badge).toHaveAttribute("data-state", "open");
	await expect(badge).toContainText("1m 00s left");

	await advance(request, "1m");
	await expect(badge).toHaveAttribute("data-state", "closed");

	const server = await serviceWindow(request);

	expect(server.data.isOpen).toBe(false);

	await inbound(request, ANA.waId, "and again");
	await expect(badge).toHaveAttribute("data-state", "open");

	await page.getByRole("button", { name: "Expire now" }).click();
	await expect(badge).toHaveAttribute("data-state", "expired");

	const expired = await serviceWindow(request);

	expect(expired.data.isOpen).toBe(false);
	expect(expired.data.expiredManuallyAt).toBe(at(DAY));
});

test("Open phone opens the Virtual Phone as the selected contact, in the selected business chat", async ({
	page,
	request,
}) => {
	await inbound(request, ANA.waId, "who am I");
	await page.goto(`/w/${WABA_ID}/p/${PHONE_NUMBER_ID}/chats/${ANA.waId}`);

	const link = page.getByTestId("open-phone");

	await expect(link).toHaveAttribute("href", `/phone?as=${ANA.waId}&chat=${PHONE_NUMBER_ID}`);

	const [phone] = await Promise.all([page.waitForEvent("popup"), link.click()]);

	await expect(phone.getByTestId("phone-identity-name")).toContainText(ANA.name);
	// Ana's own message is on her side of the chat; the echo app's reply is on the other.
	await expect(
		phone.locator('[data-testid="phone-message"][data-direction="sent"]').filter({ hasText: "who am I" }),
	).toBeVisible();
	await expect(
		phone.locator('[data-testid="phone-message"][data-direction="received"]').filter({ hasText: "echo: who am I" }),
	).toBeVisible();
	const opened = new URL(phone.url());

	expect(opened.searchParams.get("as")).toBe(ANA.waId);
});

test("Scenarios: check an example, run a failing one, read the failure and download its JUnit report", async ({
	page,
}) => {
	await page.goto("/scenarios");
	await expect(page.getByTestId("scenario-reset-warning")).toContainText("resets");

	await page.getByLabel("Example scenario").selectOption("service-window.json");
	await page.getByRole("button", { name: "Check" }).click();
	await expect(page.getByTestId("scenario-valid")).toBeVisible();

	await page.getByLabel("Scenario JSON").fill('{"name":"broken","steps":[{"send":{"as":"Nobody","text":"hi"}}]}');
	await page.getByRole("button", { name: "Check" }).click();
	await expect(page.getByTestId("scenario-invalid")).toContainText("Nobody");

	const unmet = readFileSync(new URL("fixtures/m4-unmet.json", import.meta.url), "utf8");

	await page.getByLabel("Scenario JSON").fill(unmet);
	await page.getByRole("button", { name: "Run…" }).click();
	await page.getByRole("button", { name: "Reset and run" }).click();

	const report = page.getByTestId("scenario-report");

	await expect(report).toHaveAttribute("data-passed", "false", { timeout: 15_000 });
	await expect(page.getByTestId("scenario-step")).toHaveCount(3);
	await expect(page.getByTestId("scenario-step").nth(1)).toHaveAttribute("data-status", "failed");
	await expect(page.getByTestId("scenario-step").nth(2)).toHaveAttribute("data-status", "skipped");
	await expect(page.getByTestId("scenario-failure")).toContainText("Hello, Dina!");
	await expect(page.getByTestId("scenario-failure")).toContainText("echo: hi");

	const [download] = await Promise.all([
		page.waitForEvent("download"),
		page.getByRole("button", { name: "Download JUnit XML" }).click(),
	]);
	const xml = readFileSync(await download.path(), "utf8");

	expect(xml).toContain('<testsuite name="unmet expectation" tests="3" failures="1" errors="0" skipped="1"');
});

test("Requests shows the app's Graph call live and opens its detail", async ({ page, request }) => {
	await page.goto("/requests");
	await inbound(request, ANA.waId, "log my reply");

	const row = page.getByTestId("graph-request").filter({ hasText: "/messages" }).first();

	await expect(row).toHaveAttribute("data-status", "200");
	await row.click();

	const detail = page.getByTestId("request-detail");

	await expect(detail).toContainText("echo: log my reply");
	await expect(detail.getByTestId("request-body").first()).toHaveAttribute("data-kind", "json");
});

test("Requests shows that a malformed body was not stored, and nothing of it reaches the page", async ({
	page,
	request,
}) => {
	const secret = "m5-review-dummy-secret";
	const answer = await request.post(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}/messages`, {
		headers: { authorization: "Bearer m5-browser", "content-type": "application/json" },
		// A Buffer goes out as these exact bytes; a string would be JSON-encoded into a valid one.
		data: Buffer.from(`{"password":"${secret}"`),
	});

	expect(answer.status()).toBe(400);

	await page.goto("/requests");

	const row = page.getByTestId("graph-request").filter({ hasText: "/messages" }).first();

	await expect(row).toHaveAttribute("data-status", "400");
	await row.click();
	await expect(page.getByTestId("request-body-omitted")).toContainText("Not stored: malformed JSON");
	await expect(page.locator("body")).not.toContainText(secret);

	const html = await page.content();

	expect(html).not.toContain(secret);
});

test("Webhooks says the signature was generated, never that the receiver verified it", async ({ page, request }) => {
	await inbound(request, ANA.waId, "signed please");
	await page.goto("/webhooks");
	await page.locator("tr.delivery").filter({ hasText: "messages" }).first().click();

	const signature = page.getByTestId("delivery-signature");

	await expect(signature).toContainText("signature generated");
	await expect(signature).toContainText("not visible to wasandbox");
	await expect(page.getByTestId("delivery-outcome").first()).toHaveAttribute("data-outcome", "delivered");
});
