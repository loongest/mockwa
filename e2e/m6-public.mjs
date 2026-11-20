// Milestone M6 acceptance checks (AC-14 to AC-17: public demo mode) against a running mockwa —
// normally the built Docker image — with the example echo app playing the app under test. HTTP,
// WebSocket and `docker`; the browser half lives in e2e/m6-public.spec.mjs.
//
//   node e2e/m6-public.mjs
//
// The instance runs MOCKWA_MODE=public on e2e/fixtures/m1-seed.json (one business number, whose
// template has quick replies) with the limits this script expects (see
// .github/workflows/docker.yml): a 20 s session TTL, 6 messages a minute per session, 64 KiB
// and 2 files of media per session, 30 sessions per address, and MOCKWA_TRUSTED_PROXIES=127.0.0.1
// so that requests made from inside the container may name a client address. Its webhook points
// at the echo app, which answers through the Graph listener with the registered token.
//
// What it proves: a fresh visitor gets its own identities and talks to the app end to end,
// buttons included (AC-14); two visitors cannot reach each other's identities, chats, messages,
// media or live stream by any route, and forged references are refused (AC-15); without the
// admin token every admin surface answers 401 (API) or 404 (pages and bundles), and webhook
// destinations stay the configured ones (AC-16); rate, size, count and per-address quotas are
// refused, idle cleanup removes exactly the idle visitor's data, a late app reply does not bring
// it back, and sessions behave across a restart (AC-17).
//
// Environment, required (e2e/targets.mjs): M6_GRAPH_URL, M6_CONSOLE_URL and M6_ECHO_URL, each
// with an explicit port, and M6_CONTAINER (restarted, and used for in-container requests).
// Optional: M6_ADMIN_TOKEN (m6-admin-token-0123456789), M6_APP_TOKEN (m6-app-token),
// M6_APP_SECRET (m6-app-secret). Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { WebSocket } from "ws";
import { requireTargets } from "./targets.mjs";

const {
	M6_GRAPH_URL: GRAPH_URL,
	M6_CONSOLE_URL: CONSOLE_URL,
	M6_ECHO_URL: ECHO_URL,
	M6_CONTAINER: CONTAINER,
} = requireTargets({
	suite: "M6 public demo",
	urls: ["M6_GRAPH_URL", "M6_CONSOLE_URL", "M6_ECHO_URL"],
	names: ["M6_CONTAINER"],
});
const ADMIN_TOKEN = process.env.M6_ADMIN_TOKEN ?? "m6-admin-token-0123456789";
const APP_TOKEN = process.env.M6_APP_TOKEN ?? "m6-app-token";
const APP_SECRET = process.env.M6_APP_SECRET ?? "m6-app-secret";
const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };
const SESSIONS_PER_IP = 30;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, () => 7)]);

const results = [];

async function check(name, run) {
	const startedAt = performance.now();

	try {
		await run();
	} catch (error) {
		const message = String(error?.stack ?? error?.message ?? error);

		results.push({ name, passed: false });
		console.log(`FAIL  ${name}\n      ${message.replaceAll("\n", "\n      ")}`);

		return;
	}

	results.push({ name, passed: true });
	const elapsedMs = Math.round(performance.now() - startedAt);

	console.log(`PASS  ${name} (${String(elapsedMs)} ms)`);
}

// --- helpers ------------------------------------------------------------------------------------

async function waitFor(description, probe, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		let result;

		try {
			result = await probe();
		} catch {
			// Not there yet.
		}

		if (result !== false && result !== null && result !== undefined) {
			return result;
		}

		if (Date.now() > deadline) {
			throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${description}`);
		}

		await new Promise(resolve => setTimeout(resolve, 200));
	}
}

async function sleep(ms) {
	await new Promise(resolve => setTimeout(resolve, ms));
}

function docker(...args) {
	return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
}

async function waitHealthy() {
	await waitFor(
		"the container to be healthy",
		() => docker("inspect", "--format", "{{.State.Health.Status}}", CONTAINER) === "healthy",
		90_000,
	);
}

/** The status of a response, or of a visitor request's result, in one expression. */
async function statusOf(pending) {
	const settled = await pending;

	return settled.status;
}

/** The parsed body of a visitor request's result, in one expression. */
async function bodyOf(pending) {
	const settled = await pending;

	return settled.body;
}

async function readBody(response) {
	const text = await response.text();

	if (text === "") {
		return null;
	}

	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** One browser: the visitor cookie it was given, the CSRF token from its session, its own origin. */
class Visitor {
	cookie = undefined;
	session = undefined;

	get waId() {
		return this.session.identities[0].waId;
	}

	get identities() {
		return this.session.identities.map(identity => identity.waId);
	}

	chat(waId = this.waId) {
		return `/api/phone/identities/${waId}/chats/${PHONE_NUMBER_ID}`;
	}

	async request(path, { method = "GET", json, form, headers = {}, origin = CONSOLE_URL } = {}) {
		const all = { ...headers };

		if (this.cookie !== undefined) {
			all.cookie = `mockwa_visitor=${this.cookie}`;
		}

		if (origin !== null) {
			all.origin = origin;
		}

		if (method !== "GET" && this.session !== undefined) {
			all["x-csrf-token"] = this.session.csrfToken;
		}

		let body;

		if (json !== undefined) {
			all["content-type"] = "application/json";
			body = JSON.stringify(json);
		} else if (form !== undefined) {
			body = form;
		}

		const response = await fetch(`${CONSOLE_URL}${path}`, { method, headers: all, body, redirect: "manual" });

		for (const header of response.headers.getSetCookie()) {
			const [pair] = header.split(";", 1);
			const [name, value] = pair.split("=", 2);

			if (name === "mockwa_visitor") {
				this.cookie = value === "" ? undefined : value;
			}
		}

		return { status: response.status, headers: response.headers, body: await readBody(response) };
	}

	async start() {
		const response = await this.request("/api/public/session", { method: "POST" });

		assert.ok(response.status === 201 || response.status === 200, JSON.stringify(response.body));
		this.session = response.body.data;

		return response;
	}

	async send(message, waId = this.waId) {
		return this.request(`${this.chat(waId)}/messages`, { method: "POST", json: message });
	}

	async sendText(text, waId = this.waId) {
		return this.send({ type: "text", text: { body: text } }, waId);
	}

	async messages(waId = this.waId) {
		const response = await this.request(`${this.chat(waId)}/messages?limit=100`);

		assert.equal(response.status, 200, JSON.stringify(response.body));

		return response.body.data;
	}

	async upload(bytes = PNG, type = "image/png", filename = "photo.png", waId = this.waId) {
		const form = new globalThis.FormData();

		form.set("file", new globalThis.Blob([bytes], { type }), filename);

		return this.request(`${this.chat(waId)}/media`, { method: "POST", form });
	}

	async leave() {
		if (this.session !== undefined) {
			await this.request("/api/public/session", { method: "DELETE" });
		}
	}
}

async function replyFromApp(visitor, predicate, description) {
	return waitFor(description, async () => {
		const messages = await visitor.messages();

		return messages.find(message => message.direction === "outbound" && predicate(message));
	});
}

async function admin(path, init = {}) {
	const response = await fetch(`${CONSOLE_URL}${path}`, {
		...init,
		headers: { ...ADMIN, ...init.headers },
		redirect: "manual",
	});

	return { status: response.status, body: await readBody(response) };
}

/** Whether the contact still exists, as the admin sees the world. */
async function contactExists(waId) {
	const { status, body } = await admin("/api/contacts");

	assert.equal(status, 200, JSON.stringify(body));

	return body.data.some(contact => contact.waId === waId);
}

async function graphSend(to, text) {
	const response = await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
	});

	return { status: response.status, body: await readBody(response) };
}

/** A visitor's live stream; resolves with the HTTP status when the upgrade is refused. */
async function openSocket(visitor, waId = visitor.waId, origin = CONSOLE_URL) {
	const headers = {};

	if (visitor?.cookie !== undefined) {
		headers.cookie = `mockwa_visitor=${visitor.cookie}`;
	}

	if (origin !== null) {
		headers.origin = origin;
	}

	const socket = new WebSocket(`${CONSOLE_URL.replace(/^http/, "ws")}/api/phone/identities/${waId}/ws`, { headers });
	const frames = [];
	const closed = new Promise(resolve => {
		socket.on("close", code => {
			resolve(code);
		});
	});

	socket.on("error", () => {});
	socket.on("message", data => {
		frames.push(JSON.parse(String(data)));
	});

	return new Promise(resolve => {
		socket.on("open", () => {
			resolve({ socket, frames, closed });
		});
		socket.on("unexpected-response", (_request, response) => {
			resolve(response.statusCode);
		});
	});
}

async function jsonOf(url) {
	const response = await fetch(url);

	return response.json();
}

async function textOf(url, init) {
	const response = await fetch(url, init);

	return response.text();
}

/** The `/assets/…` files an HTML page references. */
function assetsIn(html) {
	return Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g), match => match[1]);
}

/** Requests made from inside the container, where the trusted proxy (127.0.0.1) may name the client. */
function sessionsFromAddress(address, count) {
	const script = `
		const statuses = [];
		for (let index = 0; index < ${String(count)}; index += 1) {
			const response = await fetch("http://127.0.0.1:8025/api/public/session", {
				method: "POST",
				headers: { origin: "http://127.0.0.1:8025", "x-forwarded-for": ${JSON.stringify(address)} },
			});
			const body = await response.json();
			statuses.push([response.status, body.error?.code ?? null]);
		}
		console.log(JSON.stringify(statuses));
	`;

	return JSON.parse(docker("exec", CONTAINER, "node", "--input-type=module", "-e", script));
}

/**
 * One request per `[method, path]` with a wrong admin token, each from its own documentation
 * address (203.0.113.x), made inside the container where the trusted proxy may name the client.
 */
function wrongTokenFromEachAddress(routes) {
	const script = `
		const answers = [];
		for (const [index, [method, path]] of ${JSON.stringify(routes)}.entries()) {
			const response = await fetch("http://127.0.0.1:8025" + path, {
				method,
				headers: { authorization: "Bearer not-the-admin-token-000", "x-forwarded-for": "203.0.113." + (index + 1) },
			});
			answers.push([path, response.status]);
		}
		console.log(JSON.stringify(answers));
	`;

	return JSON.parse(docker("exec", CONTAINER, "node", "--input-type=module", "-e", script));
}

/** The seed's one business number, as the admin sees it. */
const PHONE_NUMBER_ID = await (async () => {
	const { status, body } = await admin("/api/phone-numbers");

	assert.equal(status, 200, JSON.stringify(body));

	return body.data[0].id;
})();

// --- checks -------------------------------------------------------------------------------------

await check("the instance is in public mode and its phone page is served with a strict CSP", async () => {
	const config = await jsonOf(`${CONSOLE_URL}/api/phone/config`);

	assert.deepEqual(config, { data: { mode: "public" } });

	const page = await fetch(`${CONSOLE_URL}/phone`);

	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
	assert.equal(page.headers.get("x-content-type-options"), "nosniff");
});

await check("AC-14: a fresh visitor gets its own identities and messages the business end to end", async () => {
	const ana = new Visitor();
	const started = await ana.start();
	const cookie = started.headers.getSetCookie().find(header => header.startsWith("mockwa_visitor="));

	assert.equal(started.status, 201);
	assert.match(cookie, /HttpOnly/);
	assert.match(cookie, /SameSite=Strict/);
	assert.deepEqual(
		ana.session.identities.map(identity => identity.role),
		["CUSTOMER", "TECHNICIAN"],
	);

	for (const waId of ana.identities) {
		assert.match(waId, /^999\d{12}$/);
	}

	// Asking again from the same browser returns the same identities, never a second set.
	const again = await ana.request("/api/public/session", { method: "POST" });

	assert.equal(again.status, 200);
	assert.deepEqual(
		again.body.data.identities.map(identity => identity.waId),
		ana.identities,
	);

	const listed = await ana.request("/api/phone/identities");

	assert.deepEqual(
		listed.body.data.map(identity => identity.waId),
		ana.identities,
	);

	const chats = await ana.request(`/api/phone/identities/${ana.waId}/chats`);

	assert.equal(chats.status, 200);
	assert.ok(chats.body.data.some(chat => chat.phoneNumberId === PHONE_NUMBER_ID));

	const sent = await ana.sendText("hello from the demo");

	assert.equal(sent.status, 201, JSON.stringify(sent.body));
	await replyFromApp(ana, message => message.payload?.text?.body === "echo: hello from the demo", "the echo reply");

	// The app received a correctly signed webhook naming the visitor's number.
	const { deliveries } = await jsonOf(`${ECHO_URL}/deliveries`);
	const delivery = deliveries.find(entry => entry.rawBody.includes("hello from the demo"));

	assert.ok(delivery, "the echo app got the message");
	assert.equal(delivery.signatureValid, true);
	assert.equal(
		delivery.signature,
		`sha256=${createHmac("sha256", APP_SECRET).update(delivery.rawBody, "utf8").digest("hex")}`,
	);
	assert.match(delivery.rawBody, new RegExp(`"wa_id":"${ana.waId}"`));
	await ana.leave();
});

await check("AC-14: the app's reply buttons and template quick replies work from a demo phone", async () => {
	const ana = new Visitor();

	await ana.start();
	assert.equal(await statusOf(ana.sendText("menu")), 201);

	const menu = await replyFromApp(ana, message => message.type === "interactive", "the interactive menu");
	const button = menu.payload.interactive.action.buttons[0].reply;
	const tapped = await ana.send({
		type: "interactive",
		interactive: { type: "button_reply", button_reply: button },
		replyTo: menu.id,
	});

	assert.equal(tapped.status, 201, JSON.stringify(tapped.body));
	await replyFromApp(ana, message => message.payload?.text?.body === `selected: ${button.title}`, "the tap's answer");

	assert.equal(await statusOf(ana.sendText("template")), 201);

	const template = await replyFromApp(ana, message => message.type === "template", "the template");
	const quickReply = await ana.send({
		type: "button",
		button: { payload: "confirm", text: "Confirm" },
		replyTo: template.id,
	});

	assert.equal(quickReply.status, 201, JSON.stringify(quickReply.body));
	await replyFromApp(
		ana,
		message => message.payload?.text?.body === "selected: Confirm" && message.replyTo !== menu.id,
		"the quick reply's answer",
	);

	// The app's own correlation data never reaches the visitor.
	const history = await ana.messages();

	for (const message of history) {
		assert.equal(message.bizOpaqueCallbackData ?? null, null);
	}

	await ana.leave();
});

await check("AC-15: two visitors cannot reach each other's identities, chats, messages or media", async () => {
	const ana = new Visitor();
	const bruno = new Visitor();

	await ana.start();
	await bruno.start();
	assert.equal(await statusOf(ana.sendText("private to ana")), 201);

	const [anaMessage] = await ana.messages();
	const upload = await ana.upload();

	assert.equal(upload.status, 201, JSON.stringify(upload.body));

	const mediaId = upload.body.data.id;
	const descriptor = await ana.request(`/api/phone/identities/${ana.waId}/media/${mediaId}`);

	assert.equal(descriptor.status, 200);
	assert.match(descriptor.body.data.url, /^\/whaloc-media\//);

	const download = await ana.request(descriptor.body.data.url);

	assert.equal(download.status, 200);

	for (const waId of ana.identities) {
		const refused = [
			await bruno.request(`/api/phone/identities/${waId}/chats`),
			await bruno.request(`${bruno.chat(waId)}/messages`),
			await bruno.sendText("forged sender", waId),
			await bruno.request(`${bruno.chat(waId)}/read`, { method: "POST" }),
			await bruno.upload(PNG, "image/png", "photo.png", waId),
			await bruno.request(`/api/phone/identities/${waId}/media/${mediaId}`),
		];

		assert.deepEqual(
			refused.map(response => [response.status, response.body?.error?.code]),
			Array.from({ length: refused.length }, () => [404, "unknown_contact"]),
		);
	}

	// Bruno's own routes, pointed at Ana's things.
	assert.equal(await statusOf(bruno.request(`/api/phone/identities/${bruno.waId}/media/${mediaId}`)), 404);
	assert.equal(await statusOf(bruno.request(descriptor.body.data.url)), 404);
	const stranger = new Visitor();

	assert.equal(await statusOf(stranger.request(descriptor.body.data.url)), 404);
	const borrowed = await bodyOf(bruno.send({ type: "image", media: { id: mediaId } }));

	assert.equal(borrowed.error.code, "unknown_media");
	assert.equal(
		await statusOf(bruno.send({ type: "text", text: { body: "quoting ana" }, replyTo: anaMessage.id })),
		404,
	);
	assert.equal(
		await statusOf(bruno.send({ type: "reaction", reaction: { message_id: anaMessage.id, emoji: "👍" } })),
		404,
	);

	// Identity fields in the body are ignored: the path, checked against the session, decides.
	const forged = await bruno.send({ type: "text", text: { body: "who am i" }, from: ana.waId, phoneNumberId: "1" });

	assert.equal(forged.status, 201);
	assert.equal(forged.body.data.contactWaId, bruno.waId);
	assert.equal(forged.body.data.phoneNumberId, PHONE_NUMBER_ID);
	const anasHistory = await ana.messages();

	assert.ok(anasHistory.every(message => message.payload?.text?.body !== "who am i"));

	// Without a session, or without the CSRF token, nothing goes through.
	const anonymous = new Visitor();

	assert.equal(await statusOf(anonymous.request("/api/phone/identities")), 401);
	const anasChat = `${anonymous.chat(ana.waId)}/messages`;

	assert.equal(await statusOf(anonymous.request(anasChat)), 401);

	const noCsrf = await fetch(`${CONSOLE_URL}${ana.chat()}/messages`, {
		method: "POST",
		headers: { cookie: `mockwa_visitor=${ana.cookie}`, origin: CONSOLE_URL, "content-type": "application/json" },
		body: JSON.stringify({ type: "text", text: { body: "csrf" } }),
	});

	assert.equal(noCsrf.status, 403);

	const crossSite = await ana.request(`${ana.chat()}/messages`, {
		method: "POST",
		json: { type: "text", text: { body: "cross-site" } },
		origin: "https://evil.example",
	});

	assert.equal(crossSite.status, 403);
	await ana.leave();
	await bruno.leave();
});

await check("AC-15: live streams carry only the visitor's own conversation, and refuse anyone else", async () => {
	const ana = new Visitor();
	const bruno = new Visitor();

	await ana.start();
	await bruno.start();

	const anaSocket = await openSocket(ana);
	const brunoSocket = await openSocket(bruno);

	assert.equal(typeof anaSocket, "object");
	assert.equal(typeof brunoSocket, "object");
	assert.equal(await statusOf(ana.sendText("live for ana")), 201);
	assert.equal(await statusOf(bruno.sendText("live for bruno")), 201);
	await waitFor("ana's own events", () =>
		anaSocket.frames.some(frame => frame.payload?.message?.payload?.text?.body === "echo: live for ana"),
	);
	await waitFor("bruno's own events", () =>
		brunoSocket.frames.some(frame => frame.payload?.message?.payload?.text?.body === "echo: live for bruno"),
	);

	const contacts = frames =>
		new Set(frames.flatMap(frame => (frame.payload?.message === undefined ? [] : [frame.payload.message.contactWaId])));

	assert.deepEqual([...contacts(anaSocket.frames)], [ana.waId]);
	assert.deepEqual([...contacts(brunoSocket.frames)], [bruno.waId]);

	assert.equal(await openSocket(bruno, ana.waId), 404);
	assert.equal(await openSocket(new Visitor(), ana.waId), 401);
	assert.equal(await openSocket(ana, ana.waId, "https://evil.example"), 403);
	assert.equal(await openSocket(ana, ana.waId, null), 403);

	// Leaving the demo closes its sockets for good.
	await ana.leave();
	assert.equal(await anaSocket.closed, 4401);
	brunoSocket.socket.close();
	await bruno.leave();
});

await check("AC-16: without the admin token every admin surface answers 401 (API) or 404 (pages)", async () => {
	const ana = new Visitor();

	await ana.start();

	const adminApi = [
		["GET", "/api/state"],
		["GET", "/api/export"],
		["POST", "/api/import"],
		["POST", "/api/reset"],
		["GET", "/api/contacts"],
		["GET", "/api/conversations"],
		["POST", "/api/inbound"],
		["GET", "/api/templates"],
		["GET", "/api/graph-requests"],
		["GET", "/api/webhook-deliveries"],
		["GET", "/api/apps"],
		["POST", "/api/apps"],
		["GET", "/api/tokens"],
		["GET", "/api/injection-rules"],
		["GET", "/api/messaging-rules"],
		["GET", "/api/clock"],
		["POST", "/api/clock/advance"],
		["POST", "/api/scenarios/validate"],
		["POST", "/api/scenarios/run"],
		["GET", `/api/media/1`],
		["GET", "/api/wabas"],
		["GET", "/api/ws"],
	];

	for (const [method, path] of adminApi) {
		const anonymous = await fetch(`${CONSOLE_URL}${path}`, { method });
		const asVisitor = await ana.request(path, { method });

		assert.deepEqual([path, anonymous.status, asVisitor.status], [path, 401, 401]);
	}

	// A wrong token on every path, each from its own address: since M7, 10 wrong tokens from one
	// address lock it out for 15 minutes, which would also refuse this script's own admin calls.
	const wrongTokens = wrongTokenFromEachAddress(adminApi);

	assert.deepEqual(
		wrongTokens,
		adminApi.map(([, path]) => [path, 401]),
	);

	// The console's pages and its own bundle are not served at all.
	const adminAssets = assetsIn(await textOf(`${CONSOLE_URL}/`, { headers: ADMIN }));
	const phoneAssets = new Set(assetsIn(await textOf(`${CONSOLE_URL}/phone`)));
	const adminOnly = adminAssets.filter(asset => !phoneAssets.has(asset));

	assert.ok(adminOnly.length > 0, "the console has assets of its own");

	for (const path of ["/", "/index.html", "/chats", "/settings", "/.vite/manifest.json", ...adminOnly]) {
		const response = await ana.request(path);

		assert.deepEqual([path, response.status], [path, 404]);
	}

	for (const asset of phoneAssets) {
		assert.equal(await statusOf(fetch(`${CONSOLE_URL}${asset}`)), 200, asset);
	}

	// The admin token opens all of it; the sign-in page exists, and refuses a wrong token.
	assert.equal(await statusOf(admin("/api/state")), 200);
	assert.equal(await statusOf(fetch(`${CONSOLE_URL}/admin`)), 200);

	const wrong = await fetch(`${CONSOLE_URL}/api/admin/login`, {
		method: "POST",
		headers: { origin: CONSOLE_URL, "content-type": "application/x-www-form-urlencoded" },
		body: "token=nope",
		redirect: "manual",
	});

	assert.equal(wrong.headers.get("location"), "/admin?error=invalid");

	// The Graph listener only takes the registered token, and the console serves no Graph route.
	const guessed = await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}`, {
		headers: { authorization: "Bearer guessed-token" },
	});

	assert.equal(guessed.status, 401);
	assert.equal(await statusOf(ana.request(`/v25.0/${PHONE_NUMBER_ID}/messages`)), 404);
	await ana.leave();
});

await check("AC-16: webhook destinations stay the configured ones", async () => {
	const wabas = await admin("/api/wabas");
	const WABA_ID = wabas.body.data[0].id;
	const override = { override_callback_uri: "https://elsewhere.example/hook", verify_token: "v" };
	const subscribed = await fetch(`${GRAPH_URL}/v25.0/${WABA_ID}/subscribed_apps`, {
		method: "POST",
		headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify(override),
	});

	assert.equal(subscribed.status, 400);

	const configured = await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}`, {
		method: "POST",
		headers: { authorization: `Bearer ${APP_TOKEN}`, "content-type": "application/json" },
		body: JSON.stringify({ webhook_configuration: override }),
	});

	assert.equal(configured.status, 400);

	const created = await admin("/api/apps", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "Elsewhere", callbackUrl: "https://elsewhere.example/hook" }),
	});

	assert.equal(created.status, 403);
	assert.equal(created.body.error.code, "webhook_destinations_locked");
});

await check("AC-17: message rate, media size, type and count are refused with documented statuses", async () => {
	const ana = new Visitor();

	await ana.start();

	const { limits } = ana.session;

	assert.equal(limits.messagesPerMinute, 6);

	// Concurrent sends from one session: exactly the allowance gets through.
	const burst = await Promise.all(Array.from({ length: 10 }, (_, index) => ana.sendText(`burst ${String(index)}`)));
	const statuses = burst.map(response => response.status).toSorted((a, b) => a - b);

	assert.deepEqual(statuses, [...Array.from({ length: 6 }, () => 201), ...Array.from({ length: 4 }, () => 429)]);

	const limited = burst.find(response => response.status === 429);

	assert.equal(limited.body.error.code, "message_rate_limited");
	assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);

	const bruno = new Visitor();

	await bruno.start();

	const tooLarge = await bruno.upload(Buffer.concat([PNG, Buffer.alloc(limits.mediaMaxBytes)]));

	assert.equal(tooLarge.status, 413);
	assert.equal(tooLarge.body.error.code, "media_too_large");

	const notAnImage = await bruno.upload(Buffer.from("<svg onload=alert(1)>"), "image/png");

	assert.equal(notAnImage.status, 415);

	const svg = await bruno.upload(Buffer.from("<svg/>"), "image/svg+xml", "x.svg");

	assert.equal(svg.status, 415);

	for (let index = 0; index < limits.mediaPerSession; index += 1) {
		assert.equal(await statusOf(bruno.upload()), 201);
	}

	const overQuota = await bruno.upload();

	assert.equal(overQuota.status, 429);
	assert.equal(overQuota.body.error.code, "media_quota_exceeded");

	// Text past 4096 characters, and message types a demo phone does not send.
	const tooLong = "x".repeat(4097);

	assert.equal(await statusOf(bruno.sendText(tooLong)), 400);
	assert.equal(await statusOf(bruno.send({ type: "unsupported" })), 400);
	await ana.leave();
	await bruno.leave();
});

await check("AC-17: sessions per address are capped, behind a trusted proxy only", async () => {
	const statuses = sessionsFromAddress("203.0.113.7", SESSIONS_PER_IP + 1);

	assert.deepEqual(
		statuses.slice(0, SESSIONS_PER_IP),
		Array.from({ length: SESSIONS_PER_IP }, () => [201, null]),
	);
	assert.deepEqual(statuses.at(-1), [429, "session_quota_exceeded"]);
	// Another address behind the same proxy is still welcome.
	assert.deepEqual(sessionsFromAddress("203.0.113.8", 1), [[201, null]]);
});

await check("AC-17: idle cleanup removes only the idle visitor's identities, messages and media", async () => {
	const idle = new Visitor();
	const active = new Visitor();

	await idle.start();
	await active.start();

	const ttlMs = idle.session.limits.sessionTtlSeconds * 1000;

	assert.equal(await statusOf(idle.sendText("soon gone")), 201);
	assert.equal(await statusOf(active.sendText("still here")), 201);

	const { data: uploaded } = await bodyOf(idle.upload());
	const media = uploaded.id;
	const descriptor = await idle.request(`/api/phone/identities/${idle.waId}/media/${media}`);
	const socket = await openSocket(idle);

	assert.equal(await contactExists(idle.waId), true);
	assert.equal(await statusOf(admin(`/api/media/${media}`)), 200);

	// The active visitor keeps using the demo while the idle one waits out its TTL.
	const deadline = Date.now() + ttlMs + 12_000;

	while (Date.now() < deadline) {
		assert.equal(await statusOf(active.request("/api/phone/identities")), 200);

		if (!(await contactExists(idle.waId))) {
			break;
		}

		await sleep(2000);
	}

	for (const waId of idle.identities) {
		assert.equal(await contactExists(waId), false, waId);
	}

	assert.equal(await statusOf(admin(`/api/media/${media}`)), 404);
	assert.equal(await socket.closed, 4401);

	const expired = await idle.request("/api/public/session");

	assert.equal(expired.status, 401);
	assert.equal(await statusOf(idle.request(descriptor.body.data.url)), 404);
	assert.equal(await statusOf(idle.sendText("after the end")), 401);

	// The active visitor is untouched.
	assert.equal(await contactExists(active.waId), true);
	const activeHistory = await active.messages();

	assert.ok(activeHistory.some(message => message.payload?.text?.body === "still here"));

	// A late reply from the app does not bring the number back for anyone.
	const late = await graphSend(idle.waId, "late reply");

	assert.equal(late.status, 200, JSON.stringify(late.body));
	await waitFor("the late reply's contact to be swept", async () => !(await contactExists(idle.waId)), ttlMs);
	assert.equal(await statusOf(idle.request(`/api/phone/identities/${idle.waId}/chats`)), 401);

	// A new session never reuses a number.
	const next = new Visitor();

	await next.start();
	assert.ok(next.identities.every(waId => !idle.identities.includes(waId)));
	await next.leave();
	await active.leave();
});

await check(
	"AC-17: a live session survives a restart; one that expires while the server is down is cleaned at boot",
	async () => {
		const survivor = new Visitor();
		const expiring = new Visitor();

		await survivor.start();
		await expiring.start();

		const ttlMs = survivor.session.limits.sessionTtlSeconds * 1000;

		docker("restart", CONTAINER);
		await waitHealthy();

		const resumed = await survivor.request("/api/public/session");

		assert.equal(resumed.status, 200);
		assert.deepEqual(
			resumed.body.data.identities.map(identity => identity.waId),
			survivor.identities,
		);

		docker("stop", CONTAINER);
		await sleep(ttlMs + 2000);
		docker("start", CONTAINER);
		await waitHealthy();

		for (const visitor of [survivor, expiring]) {
			assert.equal(await statusOf(visitor.request("/api/public/session")), 401);

			for (const waId of visitor.identities) {
				assert.equal(await contactExists(waId), false, waId);
			}
		}
	},
);

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
