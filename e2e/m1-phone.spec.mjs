import { expect, test } from "@playwright/test";
import { createHmac } from "node:crypto";
import { readTargets } from "./targets.mjs";

/**
 * Milestone M1 acceptance (AC-03, AC-04, AC-05): the virtual phone on 8025 against a real WaSandbox
 * — in CI, the built Docker image — seeded from e2e/fixtures/m1-seed.json, with the example echo
 * app as the app under test. Nothing is faked: a phone's send is a signed webhook the echo app
 * verifies, and every reply it sees came back through the Graph API on 8888.
 *
 * Environment, required (e2e/targets.mjs): M1_CONSOLE_URL (the Playwright baseURL) and
 * M1_ECHO_URL, each with an explicit port. Optional: M1_APP_SECRET (the secret both sides were
 * started with).
 */

const { M1_ECHO_URL: ECHO_URL } = readTargets(process.env, {
	suite: "m1-phone",
	urls: ["M1_CONSOLE_URL", "M1_ECHO_URL"],
});
const APP_SECRET = process.env.M1_APP_SECRET ?? "m1-app-secret";
/** The seed's identities (e2e/fixtures/m1-seed.json). */
const CUSTOMER_A = { waId: "60123450001", name: "Customer A" };
const CUSTOMER_B = { waId: "60123450002", name: "Customer B" };
const TECHNICIAN = { waId: "60123450003", name: "Ah Mad" };
const BUSINESS = "Acme Home Services";
const WAMID = /^wamid\.[\w+/=-]+$/;

/** Recomputed here, independently of both WaSandbox and the echo app. */
function signatureOf(rawBody) {
	return `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
}

function valueOf(delivery) {
	return delivery.body?.entry?.[0]?.changes?.[0]?.value;
}

async function deliveries(request) {
	const response = await request.get(`${ECHO_URL}/deliveries`);
	const body = await response.json();

	return body.deliveries;
}

/**
 * The wamid of the echo app's reply to `messageId`, once the Graph API on 8888 accepted it. The
 * echo app records the Graph response next to the webhook that triggered it.
 */
async function replyIdTo(request, messageId) {
	let reply;

	await expect
		.poll(
			async () => {
				const delivery = await inboundDelivery(request, messageId);

				reply = delivery.reply;

				return reply?.status;
			},
			{ message: `the echo app's reply to ${messageId}` },
		)
		.toBe(200);

	return reply.body.messages[0].id;
}

/** The first inbound message the echo app received that quotes `contextId`, with its delivery. */
async function tapQuoting(request, type, contextId) {
	let tapped;

	await expect
		.poll(
			async () => {
				const all = await deliveries(request);

				tapped = all
					.map(delivery => ({ delivery, message: valueOf(delivery)?.messages?.[0] }))
					.find(({ message }) => message?.type === type && message.context?.id === contextId);

				return tapped !== undefined;
			},
			{ message: `a ${type} reply quoting ${contextId}` },
		)
		.toBe(true);

	return tapped;
}

/** A data attribute of the element a locator points at. */
async function dataOf(locator, key) {
	return locator.evaluate((element, name) => element.dataset[name], key);
}

/** The echo app's record of the inbound webhook that carried `messageId`, once it arrives. */
async function inboundDelivery(request, messageId) {
	let found;

	await expect
		.poll(
			async () => {
				const all = await deliveries(request);

				found = all.find(delivery => valueOf(delivery)?.messages?.[0]?.id === messageId);

				return found !== undefined;
			},
			{ message: `the webhook for ${messageId}` },
		)
		.toBe(true);

	return found;
}

/** The statuses the echo app was told about for one of its own sends, in arrival order. */
async function statusesOf(request, messageId) {
	const all = await deliveries(request);

	return all.flatMap(delivery => (valueOf(delivery)?.statuses ?? []).filter(status => status.id === messageId));
}

/** Asserts a delivery was signed over its exact bytes and that the echo app accepted it. */
function expectSigned(delivery) {
	expect(delivery.signatureValid).toBe(true);
	expect(delivery.signature).toBe(signatureOf(delivery.rawBody));
}

/** Signs a page in as `identity` and opens its chat with the business. */
async function openChat(page, identity) {
	await page.goto("/phone");
	await page.locator(`[data-testid="phone-identity"][data-wa-id="${identity.waId}"]`).click();
	await expect(page.getByTestId("phone-identity-name")).toContainText(identity.name);
	// "live" only once the phone's own socket is open, so nothing pushed after this is missed.
	await expect(page.getByTestId("phone-connection")).toHaveAttribute("data-connection", "open");
	await page.getByTestId("phone-chat").filter({ hasText: BUSINESS }).click();
	// The history is in, so whatever arrives from here on is new.
	await expect(page.getByTestId("phone-thread")).toHaveAttribute("data-state", "ready");
}

function bubble(page, text) {
	return page.getByTestId("phone-message").filter({ hasText: text });
}

/**
 * Types and sends a text; resolves to the wamid the phone shows for it. The same words may
 * already be in the history (a rerun against the same instance), so it is the new bubble.
 */
async function sendText(page, text) {
	const sent = bubble(page, text).and(page.locator('[data-direction="sent"]'));
	const before = await sent.count();

	await page.getByLabel("Message").fill(text);
	await page.getByRole("button", { name: "Send" }).click();
	await expect(sent).toHaveCount(before + 1);

	return dataOf(sent.last(), "messageId");
}

test.describe("M1 virtual phone", () => {
	test("AC-03 Customer A's text reaches the echo app signed, and its reply comes back live", async ({
		page,
		request,
	}) => {
		const text = `Is my booking confirmed? ${String(Date.now())}`;

		await openChat(page, CUSTOMER_A);

		const startedAt = Math.floor(Date.now() / 1000);
		const sentId = await sendText(page, text);

		expect(sentId).toMatch(WAMID);

		// The inbound webhook: signed over its bytes, from Customer A, stamped now.
		const delivery = await inboundDelivery(request, sentId);
		const inbound = valueOf(delivery).messages[0];

		expectSigned(delivery);
		expect(inbound).toMatchObject({ from: CUSTOMER_A.waId, type: "text", text: { body: text } });
		expect(Number(inbound.timestamp)).toBeGreaterThanOrEqual(startedAt - 5);
		expect(Number(inbound.timestamp)).toBeLessThanOrEqual(Math.ceil(Date.now() / 1000) + 5);
		expect(valueOf(delivery).contacts[0]).toMatchObject({ wa_id: CUSTOMER_A.waId, profile: { name: "Customer A" } });

		// The echo app's reply went out through 8888 and is shown live, with no reload.
		const replyId = await replyIdTo(request, sentId);
		const reply = bubble(page, `echo: ${text}`);

		expect(replyId).toMatch(WAMID);
		await expect(reply).toHaveAttribute("data-direction", "received");
		await expect(reply).toHaveAttribute("data-message-id", replyId);

		// The reply quotes the message it answers, and carries a timestamp of its own.
		await expect(reply.locator(".bubble__quote")).toContainText(text);
		const shownAt = Date.parse(await reply.locator("time").evaluate(element => element.dateTime));

		expect(Math.abs(shownAt - Date.now())).toBeLessThan(60_000);

		// The chat is open, so the reply is read as soon as it is delivered: sent → delivered →
		// read, each a signed status webhook to the echo app.
		await expect(reply).toHaveAttribute("data-status", "read");
		await expect
			.poll(async () => {
				const statuses = await statusesOf(request, replyId);

				return statuses.map(status => status.status);
			})
			.toEqual(["sent", "delivered", "read"]);

		const received = await deliveries(request);

		for (const delivered of received) {
			expect(delivered.signature).toBe(signatureOf(delivered.rawBody));
		}

		// Customer A's own message shows its ticks: delivered, since the echo app sends no read
		// receipt for it.
		const mine = bubble(page, text).and(page.locator('[data-direction="sent"]'));

		await expect(mine).toHaveAttribute("data-status", "delivered");
		await expect(mine.getByRole("img", { name: "delivered" })).toBeVisible();
	});

	test("AC-04 Customer B and the technician use separate phones without seeing each other", async ({
		browser,
		request,
	}) => {
		const customerContext = await browser.newContext();
		const technicianContext = await browser.newContext();
		const customer = await customerContext.newPage();
		const technician = await technicianContext.newPage();
		const stamp = String(Date.now());
		const customerText = `Customer B here ${stamp}`;
		const technicianText = `Ah Mad on site ${stamp}`;

		try {
			await openChat(customer, CUSTOMER_B);
			await openChat(technician, TECHNICIAN);

			const customerId = await sendText(customer, customerText);
			const technicianId = await sendText(technician, technicianText);

			expect(customerId).not.toBe(technicianId);

			await expect(bubble(customer, `echo: ${customerText}`)).toBeVisible();
			await expect(bubble(technician, `echo: ${technicianText}`)).toBeVisible();

			const fromCustomer = await inboundDelivery(request, customerId);
			const fromTechnician = await inboundDelivery(request, technicianId);

			expect(valueOf(fromCustomer).messages[0].from).toBe(CUSTOMER_B.waId);
			expect(valueOf(fromTechnician).messages[0].from).toBe(TECHNICIAN.waId);

			// Each phone's thread holds its own conversation only.
			await expect(customer.getByTestId("phone-thread")).not.toContainText(technicianText);
			await expect(technician.getByTestId("phone-thread")).not.toContainText(customerText);

			// The roles are what each phone signed in as.
			await expect(customer.getByTestId("phone-identity-name")).toContainText("CUSTOMER");
			await expect(technician.getByTestId("phone-identity-name")).toContainText("TECHNICIAN");

			// The developer console still sees both conversations.
			const listed = await request.get("/api/conversations");
			const conversations = await listed.json();
			const contacts = conversations.data.map(conversation => conversation.contactWaId);

			expect(contacts).toEqual(expect.arrayContaining([CUSTOMER_B.waId, TECHNICIAN.waId]));
		} finally {
			await customerContext.close();
			await technicianContext.close();
		}
	});

	test("AC-05 a template's quick reply and an interactive reply button send real reply webhooks", async ({
		page,
		request,
	}) => {
		await openChat(page, CUSTOMER_A);

		// The echo app answers "template" with the approved appointment_confirmation template.
		const templateRequestId = await sendText(page, "template");
		const templateReply = await inboundDelivery(request, templateRequestId);
		const templateId = await replyIdTo(request, templateRequestId);
		const template = page.locator(`[data-message-id="${templateId}"]`);

		expectSigned(templateReply);
		await expect(template).toContainText("Hi Customer A, your technician visit is booked for tomorrow at 10:00.");
		await template.getByRole("button", { name: "Confirm" }).click();

		// A quick-reply tap is a `button` message quoting the template.
		const tapped = await tapQuoting(request, "button", templateId);

		expectSigned(tapped.delivery);
		expect(tapped.message).toMatchObject({ from: CUSTOMER_A.waId, button: { text: "Confirm" } });
		// The echo app's answer to the tap comes back live.
		const tappedReplyId = await replyIdTo(request, tapped.message.id);

		await expect(page.locator(`[data-message-id="${tappedReplyId}"]`)).toContainText("selected: Confirm");

		// The echo app answers "menu" with an interactive message carrying two reply buttons.
		const menuRequestId = await sendText(page, "menu");

		const menuId = await replyIdTo(request, menuRequestId);
		const menu = page.locator(`[data-message-id="${menuId}"]`);

		await expect(menu).toContainText("Does that still work?");
		await menu.getByRole("button", { name: "Reschedule" }).click();

		const picked = await tapQuoting(request, "interactive", menuId);

		expectSigned(picked.delivery);
		expect(picked.message).toMatchObject({
			from: CUSTOMER_A.waId,
			interactive: { type: "button_reply", button_reply: { id: "visit-reschedule", title: "Reschedule" } },
		});
		// The echo app's answer to the tap comes back live.
		const pickedReplyId = await replyIdTo(request, picked.message.id);

		await expect(page.locator(`[data-message-id="${pickedReplyId}"]`)).toContainText("selected: Reschedule");
	});
});
