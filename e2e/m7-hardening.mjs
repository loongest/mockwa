// Milestone M7 acceptance checks (AC-19 and the hardening review) against a running WaSandbox —
// normally the built Docker image — in public mode with the **default** limits, so the limits a
// real instance ships with are what is exercised. The example echo app plays the app under test.
//
//   node e2e/m7-hardening.mjs
//
// The instance runs WASANDBOX_MODE=public on e2e/fixtures/m1-seed.json with the default limits
// and WASANDBOX_TRUSTED_PROXIES=127.0.0.1 so requests made from inside the
// container may name a client address (that is how one machine plays many visitors here). Its
// webhook points at the echo app, which answers through the Graph listener with the registered
// token. See .github/workflows/docker.yml for the exact flags.
//
// What it proves: every page and answer carries the security headers, the cookie is HttpOnly and
// SameSite=Strict, writes and sockets need the CSRF token and the listener's origin (AC-19);
// stored media of any type never renders as a page on either listener; forged references to
// another visitor's identity, conversation, message, reply, reaction and media are refused over
// HTTP and never arrive live; the default per-session and per-address limits hold under
// concurrent requests; oversized and malformed bodies get bounded answers; wrong admin tokens
// lock an address out; a spoofed X-Forwarded-For from an untrusted peer changes nothing; a reset
// ends every session; leaving visitors take their data and log copies with them and the
// in-memory counters return to zero; the Graph listener takes only registered tokens; and no
// credential reaches the container's log.
//
// Environment, required (e2e/targets.mjs): M7_GRAPH_URL, M7_CONSOLE_URL and M7_ECHO_URL, each
// with an explicit port, and M7_CONTAINER (used for in-container requests and its log).
// Optional: M7_ADMIN_TOKEN (m7-admin-token-0123456789), M7_APP_TOKEN (m7-app-token).
// Prints PASS/FAIL per check and exits non-zero if any failed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { WebSocket } from "ws";
import { requireTargets } from "./targets.mjs";

const {
	M7_GRAPH_URL: GRAPH_URL,
	M7_CONSOLE_URL: CONSOLE_URL,
	M7_ECHO_URL: ECHO_URL,
	M7_CONTAINER: CONTAINER,
} = requireTargets({
	suite: "M7 hardening",
	urls: ["M7_GRAPH_URL", "M7_CONSOLE_URL", "M7_ECHO_URL"],
	names: ["M7_CONTAINER"],
});
const ADMIN_TOKEN = process.env.M7_ADMIN_TOKEN ?? "m7-admin-token-0123456789";
const APP_TOKEN = process.env.M7_APP_TOKEN ?? "m7-app-token";
const ADMIN = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** The defaults this instance runs with (SPEC §7); the checks below hold it to them. */
const DEFAULTS = { messagesPerSession: 20, sessionsPerIp: 3, socketsPerSession: 8, adminFailures: 10 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, () => 7)]);

const results = [];

async function check(name, run) {
	const startedAt = performance.now();

	try {
		try {
			await run();
		} finally {
			// The default limits allow an address only a few live sessions: each check leaves.
			await endVisitors();
		}
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

function docker(...args) {
	return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * Runs `body` inside the container as an async function of `(base, origin)`, where `base` is the
 * console listener as seen from there; its JSON-serializable result comes back. Requests from
 * inside come from 127.0.0.1, the trusted proxy, so they may set X-Forwarded-For.
 */
function inContainer(body) {
	const script = `
		const base = "http://127.0.0.1:8025";
		const origin = "http://127.0.0.1:8025";
		const result = await (async () => { ${body} })();
		console.log(JSON.stringify(result));
	`;

	return JSON.parse(docker("exec", CONTAINER, "node", "--input-type=module", "-e", script));
}

/** POSTs `bytes` bytes of JSON-ish filler with curl, which waits for `100 Continue`; the status. */
function oversizedPost(path, bytes, headers = {}) {
	const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST", "--data-binary", "@-"];

	const allHeaders = { origin: CONSOLE_URL, "content-type": "application/json", ...headers };

	for (const [name, value] of Object.entries(allHeaders)) {
		args.push("-H", `${name}: ${value}`);
	}

	return execFileSync("curl", [...args, `${CONSOLE_URL}${path}`], {
		input: `{"pad":"${"x".repeat(bytes)}"}`,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
	}).trim();
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

async function admin(path, init = {}) {
	const response = await fetch(`${CONSOLE_URL}${path}`, { ...init, headers: { ...ADMIN, ...init.headers } });

	return { status: response.status, headers: response.headers, body: await readBody(response) };
}

async function stats() {
	const { status, body } = await admin("/api/public/stats");

	assert.equal(status, 200, JSON.stringify(body));

	return body.data;
}

async function graph(path, init = {}, token = APP_TOKEN) {
	const response = await fetch(`${GRAPH_URL}/v25.0${path}`, {
		...init,
		headers: { ...(token !== null && { authorization: `Bearer ${token}` }), ...init.headers },
	});

	return { status: response.status, headers: response.headers, body: await readBody(response) };
}

/** One browser: the visitor cookie it was given, the CSRF token from its session, its own origin. */
class Visitor {
	cookie = undefined;
	session = undefined;
	setCookie = undefined;

	get waId() {
		return this.session.identities[0].waId;
	}

	chat(waId = this.waId) {
		return `/api/phone/identities/${waId}/chats/${PHONE_NUMBER_ID}`;
	}

	async request(path, { method = "GET", json, form, raw, headers = {}, origin = CONSOLE_URL, csrf = true } = {}) {
		const all = { ...headers };

		if (this.cookie !== undefined) {
			all.cookie = `wasandbox_visitor=${this.cookie}`;
		}

		if (origin !== null) {
			all.origin = origin;
		}

		if (method !== "GET" && csrf && this.session !== undefined) {
			all["x-csrf-token"] = this.session.csrfToken;
		}

		let body;

		if (json !== undefined) {
			all["content-type"] = "application/json";
			body = JSON.stringify(json);
		} else if (raw !== undefined) {
			all["content-type"] = "application/json";
			body = raw;
		} else if (form !== undefined) {
			body = form;
		}

		const response = await fetch(`${CONSOLE_URL}${path}`, { method, headers: all, body, redirect: "manual" });

		for (const header of response.headers.getSetCookie()) {
			const [pair] = header.split(";", 1);
			const [name, value] = pair.split("=", 2);

			if (name === "wasandbox_visitor") {
				this.cookie = value === "" ? undefined : value;
				this.setCookie = header;
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

	async leave() {
		await this.request("/api/public/session", { method: "DELETE" });
	}

	sendText(text, waId = this.waId) {
		return this.request(`${this.chat(waId)}/messages`, {
			method: "POST",
			json: { type: "text", text: { body: text } },
		});
	}

	async messages(waId = this.waId) {
		const { status, body } = await this.request(`${this.chat(waId)}/messages?limit=100`);

		assert.equal(status, 200, JSON.stringify(body));

		return body.data;
	}

	async socket(waId = this.waId, origin = CONSOLE_URL) {
		const url = `${CONSOLE_URL.replace(/^http/, "ws")}/api/phone/identities/${waId}/ws`;
		const headers = { ...(origin !== null && { origin }) };

		if (this.cookie !== undefined) {
			headers.cookie = `wasandbox_visitor=${this.cookie}`;
		}

		const ws = new WebSocket(url, { headers });
		const events = [];

		ws.on("message", data => {
			events.push(JSON.parse(String(data)));
		});
		ws.on("error", () => {});

		return new Promise(resolve => {
			ws.on("open", () => resolve({ ws, events, status: 101 }));
			ws.on("unexpected-response", (_request, response) => resolve({ ws, events, status: response.statusCode }));
		});
	}
}

/** The status of a response, from a promise of one: assertions read better with it inline. */
async function statusOf(pending) {
	const response = await pending;

	return response.status;
}

/** How many messages a visitor's chat holds. */
async function countMessages(visitor) {
	const messages = await visitor.messages();

	return messages.length;
}

/** One figure from the instance stats. */
async function statOf(name) {
	const figures = await stats();

	return figures[name];
}

/** The seed's one business number, as the admin sees it. */
const PHONE_NUMBER_ID = await (async () => {
	const { status, body } = await admin("/api/phone-numbers");

	assert.equal(status, 200, JSON.stringify(body));

	return body.data[0].id;
})();

/** Every visitor this script started, so the last check can end them all. */
const started = [];

/**
 * A new visitor from this machine. The default limits allow an address 10 new sessions a minute,
 * and this script needs more than that over its run: past the limit, it waits as told.
 */
async function startVisitor() {
	for (;;) {
		const visitor = new Visitor();
		const response = await visitor.request("/api/public/session", { method: "POST" });

		if (response.status === 429 && response.body?.error?.code === "session_rate_limited") {
			await new Promise(resolve => setTimeout(resolve, Number(response.headers.get("retry-after") ?? "5") * 1000));
			continue;
		}

		assert.equal(response.status, 201, JSON.stringify(response.body));
		visitor.session = response.body.data;
		started.push(visitor);

		return visitor;
	}
}

async function endVisitors() {
	for (const visitor of started.splice(0)) {
		await visitor.leave();
	}
}

// --- checks -------------------------------------------------------------------------------------

await check("a spoofed X-Forwarded-For from an untrusted peer changes nothing", async () => {
	// From the host the peer is not a trusted proxy: every request is the same client, whatever
	// address it claims. The per-address quota therefore runs out after its default.
	const statuses = [];

	for (let index = 0; index < DEFAULTS.sessionsPerIp + 2; index += 1) {
		const visitor = new Visitor();
		const response = await visitor.request("/api/public/session", {
			method: "POST",
			headers: { "x-forwarded-for": `192.0.2.${String(index + 1)}` },
		});

		if (response.status === 429 && response.body.error.code === "session_rate_limited") {
			await new Promise(resolve => setTimeout(resolve, Number(response.headers.get("retry-after")) * 1000));
			index -= 1;
			continue;
		}

		statuses.push(response.status);

		if (response.status === 201) {
			visitor.session = response.body.data;
			started.push(visitor);
		}
	}

	assert.equal(statuses.filter(status => status === 201).length, DEFAULTS.sessionsPerIp, JSON.stringify(statuses));
	assert.ok(
		statuses.slice(DEFAULTS.sessionsPerIp).every(status => status === 429),
		JSON.stringify(statuses),
	);
});

await check(
	"AC-19: the phone page, the sign-in page and the console carry a strict policy and security headers",
	async () => {
		const phone = await fetch(`${CONSOLE_URL}/phone`);
		const phoneCsp = phone.headers.get("content-security-policy") ?? "";

		assert.equal(phone.status, 200);
		assert.match(phoneCsp, /script-src 'self'(;|$)/);
		assert.match(phoneCsp, /frame-ancestors 'none'/);
		assert.match(phoneCsp, /object-src 'none'/);
		assert.equal(phone.headers.get("x-content-type-options"), "nosniff");
		assert.equal(phone.headers.get("x-frame-options"), "DENY");

		const signIn = await fetch(`${CONSOLE_URL}/admin`);

		assert.match(signIn.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		assert.equal(signIn.headers.get("cache-control"), "no-store");

		const console_ = await fetch(`${CONSOLE_URL}/settings`, { headers: ADMIN });
		const consoleCsp = console_.headers.get("content-security-policy") ?? "";

		assert.equal(console_.status, 200);
		assert.match(consoleCsp, /script-src 'self'(;|$)/);
		assert.match(consoleCsp, /frame-ancestors 'none'/);
		assert.doesNotMatch(consoleCsp, /unsafe-eval|script-src[^;]*unsafe-inline/);

		// Every script and stylesheet the pages load is served nosniff and same-origin only.
		const page = await fetch(`${CONSOLE_URL}/phone`);
		const html = await page.text();
		const assets = html
			.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)
			.map(match => match[1])
			.toArray();

		assert.ok(assets.length > 0, html);

		for (const asset of assets) {
			const response = await fetch(`${CONSOLE_URL}${asset}`);

			assert.equal(response.status, 200, asset);
			assert.equal(response.headers.get("x-content-type-options"), "nosniff", asset);
			assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin", asset);
		}
	},
);

await check("AC-19: the session cookie is HttpOnly and SameSite=Strict; its answers are never cached", async () => {
	const ana = await startVisitor();

	assert.match(ana.setCookie, /HttpOnly/i);
	assert.match(ana.setCookie, /SameSite=Strict/i);
	// Plain HTTP and no trusted proxy: `auto` leaves Secure off, or the browser would drop it.
	assert.doesNotMatch(ana.setCookie, /;\s*Secure/i);

	const session = await ana.request("/api/public/session");

	assert.equal(session.headers.get("cache-control"), "no-store");
	assert.equal(session.headers.get("x-content-type-options"), "nosniff");

	// A spoofed X-Forwarded-Proto from an untrusted peer does not make it Secure either.
	const spoof = new Visitor();
	const response = await spoof.request("/api/public/session", {
		method: "POST",
		headers: { "x-forwarded-proto": "https" },
	});

	assert.equal(response.status, 201, JSON.stringify(response.body));
	started.push(spoof);
	spoof.session = response.body.data;
	assert.doesNotMatch(spoof.setCookie, /;\s*Secure/i);
});

await check("AC-19: writes need the CSRF token and this origin; sockets need this origin", async () => {
	const ana = await startVisitor();

	assert.equal(await statusOf(ana.sendText("with token")), 201);

	const noToken = await ana.request(`${ana.chat()}/messages`, {
		method: "POST",
		json: { type: "text", text: { body: "no token" } },
		csrf: false,
	});

	assert.equal(noToken.status, 403);
	assert.equal(noToken.body.error.code, "csrf_failed");

	for (const origin of ["https://evil.example", null, "null"]) {
		const response = await ana.request(`${ana.chat()}/messages`, {
			method: "POST",
			json: { type: "text", text: { body: "cross-site" } },
			origin,
		});

		assert.equal(response.status, 403, String(origin));
	}

	assert.equal(await statusOf(ana.socket(ana.waId, "https://evil.example")), 403);
	assert.equal(await statusOf(ana.socket(ana.waId, null)), 403);

	const good = await ana.socket();

	assert.equal(good.status, 101);
	good.ws.close();
});

await check("AC-19: hostile text is stored and served as data, byte for byte", async () => {
	const ana = await startVisitor();
	const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script>"'&`;

	assert.equal(await statusOf(ana.sendText(hostile)), 201);

	const echoed = await waitFor("the echo app's reply", async () => {
		const messages = await ana.messages();

		return messages.find(message => message.payload?.text?.body === `echo: ${hostile}`);
	});

	assert.ok(echoed);

	const raw = await ana.request(`${ana.chat()}/messages?limit=10`);

	assert.match(raw.headers.get("content-type") ?? "", /^application\/json/);
});

await check("stored media of any type never renders as a page, on either listener", async () => {
	const ana = await startVisitor();

	for (const [type, bytes] of [
		["text/html", "<script>alert(document.cookie)</script>"],
		["image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`],
	]) {
		const form = new globalThis.FormData();

		form.set("messaging_product", "whatsapp");
		form.set("file", new globalThis.Blob([bytes], { type }), "x");
		form.set("type", type);

		const uploaded = await graph(`/${PHONE_NUMBER_ID}/media`, { method: "POST", body: form });

		assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));

		const sent = await graph(`/${PHONE_NUMBER_ID}/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: ana.waId,
				type: "document",
				document: { id: uploaded.body.id },
			}),
		});

		assert.equal(sent.status, 200, JSON.stringify(sent.body));

		const descriptor = await ana.request(`/api/phone/identities/${ana.waId}/media/${uploaded.body.id}`);
		const path = descriptor.body.data.url;
		const answers = [await ana.request(path), await admin(path), await fetch(`${GRAPH_URL}${path}`)];

		for (const answer of answers) {
			assert.equal(answer.status, 200, type);
			assert.equal(answer.headers.get("content-disposition"), "attachment", type);
			assert.equal(answer.headers.get("content-security-policy"), "default-src 'none'; sandbox", type);
			assert.equal(answer.headers.get("x-content-type-options"), "nosniff", type);
		}
	}

	// A visitor cannot smuggle HTML in under an image's name.
	const form = new globalThis.FormData();

	form.set("file", new globalThis.Blob(["<html><script>alert(1)</script>"], { type: "image/png" }), "x.png");
	const uploadPath = `${ana.chat()}/media`;

	assert.equal(await statusOf(ana.request(uploadPath, { method: "POST", form })), 415);
});

await check("forged references to another visitor are refused over HTTP and never arrive live", async () => {
	const ana = await startVisitor();
	const bruno = await startVisitor();
	const brunoLive = await bruno.socket();

	assert.equal(brunoLive.status, 101);
	assert.equal(await statusOf(ana.sendText("ana's secret")), 201);

	const anaMessages = await waitFor("ana's echo", async () => {
		const messages = await ana.messages();

		return messages.length >= 2 ? messages : null;
	});
	const anaMessageId = anaMessages[0].id;
	const form = new globalThis.FormData();

	form.set("file", new globalThis.Blob([PNG], { type: "image/png" }), "a.png");

	const anaMedia = await ana.request(`${ana.chat()}/media`, { method: "POST", form });

	assert.equal(anaMedia.status, 201);

	const anaMediaId = anaMedia.body.data.id;
	const brunoChat = bruno.chat();

	// Bruno names Ana's number in every route.
	for (const [method, path, json] of [
		["GET", `/api/phone/identities/${ana.waId}/chats`],
		["GET", `${ana.chat()}/messages`],
		["POST", `${ana.chat()}/messages`, { type: "text", text: { body: "as ana" } }],
		["POST", `${ana.chat()}/read`, {}],
		["GET", `/api/phone/identities/${ana.waId}/media/${anaMediaId}`],
	]) {
		const response = await bruno.request(path, { method, json });

		assert.equal(response.status, 404, `${method} ${path}`);
	}

	assert.equal(await statusOf(bruno.socket(ana.waId)), 404);

	// From his own number, he points at Ana's message, reaction target and media.
	for (const json of [
		{ type: "text", text: { body: "reply" }, replyTo: anaMessageId },
		{ type: "reaction", reaction: { message_id: anaMessageId, emoji: "👍" } },
		{ type: "image", media: { id: anaMediaId } },
		{ type: "text", text: { body: "body override" }, from: ana.waId },
	]) {
		const response = await bruno.request(`${brunoChat}/messages`, { method: "POST", json });

		if (json.from === undefined) {
			assert.equal(response.status, 404, JSON.stringify(json));
		} else {
			// `from` in the body is ignored: the path decides, and it is Bruno's.
			assert.equal(response.status, 201);
			assert.equal(response.body.data.contactWaId, bruno.waId);
		}
	}

	// Ana's media URL itself is not his to load either.
	const anaDescriptor = await ana.request(`/api/phone/identities/${ana.waId}/media/${anaMediaId}`);

	assert.equal(await statusOf(bruno.request(anaDescriptor.body.data.url)), 404);

	// Nothing of Ana's reached Bruno's live stream.
	await new Promise(resolve => setTimeout(resolve, 1500));
	brunoLive.ws.close();

	const leaked = JSON.stringify(brunoLive.events);

	assert.ok(!leaked.includes(ana.waId), leaked);
	assert.ok(!leaked.includes("ana's secret"), leaked);
});

await check("the default limits hold under concurrent requests", async () => {
	// Sessions per address, racing: from inside, every request names the same client.
	const sessions = inContainer(`
		const attempts = await Promise.all(Array.from({ length: 12 }, () =>
			fetch(base + "/api/public/session", { method: "POST", headers: { origin, "x-forwarded-for": "198.51.100.71" } })
				.then(async response => ({ status: response.status, cookie: response.headers.get("set-cookie") }))));
		for (const attempt of attempts) {
			const cookie = attempt.cookie?.split(";")[0];
			if (cookie) {
				const session = await (await fetch(base + "/api/public/session", { headers: { cookie } })).json();
				await fetch(base + "/api/public/session", { method: "DELETE", headers: { cookie, origin, "x-csrf-token": session.data.csrfToken } });
			}
		}
		return attempts.map(attempt => attempt.status);
	`);

	assert.equal(sessions.filter(status => status === 201).length, DEFAULTS.sessionsPerIp, JSON.stringify(sessions));
	assert.equal(sessions.filter(status => status === 429).length, 12 - DEFAULTS.sessionsPerIp);

	// Messages per session, racing, from an address of their own.
	const flood = inContainer(`
		const headers = { origin, "x-forwarded-for": "198.51.100.72" };
		const started = await fetch(base + "/api/public/session", { method: "POST", headers });
		const cookie = started.headers.get("set-cookie").split(";")[0];
		const session = (await started.json()).data;
		const write = { ...headers, cookie, "x-csrf-token": session.csrfToken, "content-type": "application/json" };
		const path = base + "/api/phone/identities/" + session.identities[0].waId + "/chats/${PHONE_NUMBER_ID}/messages";
		const sends = await Promise.all(Array.from({ length: 30 }, (_, index) =>
			fetch(path, { method: "POST", headers: write, body: JSON.stringify({ type: "text", text: { body: "flood " + index } }) })
				.then(response => ({ status: response.status, retryAfter: response.headers.get("retry-after") }))));
		await fetch(base + "/api/public/session", { method: "DELETE", headers: write });
		return sends;
	`);

	assert.equal(
		flood.filter(send => send.status === 201).length,
		DEFAULTS.messagesPerSession,
		JSON.stringify(flood.map(send => send.status)),
	);
	assert.ok(flood.filter(send => send.status === 429).every(send => Number(send.retryAfter) > 0));

	// Sockets per session, racing.
	const bruno = await startVisitor();
	const sockets = await Promise.all(Array.from({ length: 16 }, () => bruno.socket()));

	assert.equal(sockets.filter(socket => socket.status === 101).length, DEFAULTS.socketsPerSession);
	assert.equal(sockets.filter(socket => socket.status === 429).length, 16 - DEFAULTS.socketsPerSession);

	for (const socket of sockets) {
		socket.ws.close();
	}

	await waitFor("the sockets to be released", async () => (await statOf("sockets")) === 0);
});

await check("oversized and malformed bodies get bounded answers and change nothing", async () => {
	const ana = await startVisitor();
	const before = await countMessages(ana);
	// An oversized body is refused from its Content-Length, before it is read: a client that waits
	// for `100 Continue` (curl does) sees the 413 without sending it at all; one that does not
	// sees the connection closed under it.
	assert.equal(
		oversizedPost(`${ana.chat()}/messages`, 8 * 1024 * 1024, {
			cookie: `wasandbox_visitor=${ana.cookie}`,
			"x-csrf-token": ana.session.csrfToken,
		}),
		"413",
	);

	for (const raw of ["{", "[]", '"text"', '{"type":"payment"}', '{"type":"text","text":{"body":""}}', "\u{0}"]) {
		const response = await ana.request(`${ana.chat()}/messages`, { method: "POST", raw });

		assert.equal(response.status, 400, raw);
	}

	const long = await ana.sendText("z".repeat(4097));

	assert.equal(long.status, 400);

	const hugeFile = nodePath.join(tmpdir(), `wasandbox-m7-${String(process.pid)}.png`);

	writeFileSync(hugeFile, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));

	try {
		const status = execFileSync(
			"curl",
			[
				"-s",
				"-o",
				"/dev/null",
				"-w",
				"%{http_code}",
				"-H",
				`origin: ${CONSOLE_URL}`,
				"-H",
				`cookie: wasandbox_visitor=${ana.cookie}`,
				"-H",
				`x-csrf-token: ${ana.session.csrfToken}`,
				"-F",
				`file=@${hugeFile};type=image/png`,
				`${CONSOLE_URL}${ana.chat()}/media`,
			],
			{ encoding: "utf8" },
		).trim();

		assert.equal(status, "413");
	} finally {
		rmSync(hugeFile, { force: true });
	}

	assert.equal(oversizedPost("/api/admin/login", 64 * 1024), "413");
	assert.equal(await countMessages(ana), before);
	assert.equal(await statusOf(ana.sendText("still works")), 201);
});

await check("repeated wrong admin tokens lock the address out; others are not affected", async () => {
	const statuses = inContainer(`
		const attempt = async (token, address) => {
			const response = await fetch(base + "/api/admin/login", {
				method: "POST",
				headers: { origin, "content-type": "application/json", "x-forwarded-for": address },
				body: JSON.stringify({ token }),
			});
			return response.status;
		};
		const wrong = [];
		for (let i = 0; i < ${String(DEFAULTS.adminFailures)}; i += 1) wrong.push(await attempt("wrong-" + i, "203.0.113.90"));
		const bearer = await fetch(base + "/api/state", { headers: { authorization: "Bearer ${ADMIN_TOKEN}", "x-forwarded-for": "203.0.113.90" } });
		return {
			wrong,
			lockedRight: await attempt(${JSON.stringify(ADMIN_TOKEN)}, "203.0.113.90"),
			lockedBearer: bearer.status,
			retryAfter: bearer.headers.get("retry-after"),
			otherAddress: await attempt(${JSON.stringify(ADMIN_TOKEN)}, "203.0.113.91"),
		};
	`);

	assert.deepEqual(
		statuses.wrong,
		Array.from({ length: DEFAULTS.adminFailures }, () => 401),
	);
	assert.equal(statuses.lockedRight, 429);
	assert.equal(statuses.lockedBearer, 429);
	assert.ok(Number(statuses.retryAfter) > 0);
	assert.equal(statuses.otherAddress, 204);
});

await check("a reset ends every session and closes its sockets", async () => {
	const ana = await startVisitor();
	const live = await ana.socket();
	const closed = new Promise(resolve => live.ws.on("close", code => resolve(code)));

	assert.equal(live.status, 101);
	assert.equal(await statusOf(admin("/api/reset", { method: "POST" })), 200);
	assert.equal(await closed, 4401);

	const after = await ana.request("/api/public/session");

	assert.equal(after.status, 401);
	assert.equal(await statOf("sessions"), 0);
	started.length = 0;
});

await check("leaving visitors take their data and its log copies along; the counters return to zero", async () => {
	const visitors = [await startVisitor(), await startVisitor()];

	for (const visitor of visitors) {
		assert.equal(await statusOf(visitor.sendText(`hello from ${visitor.waId}`)), 201);
		await waitFor("the echo", async () => (await countMessages(visitor)) >= 2);
	}

	const busy = await stats();

	assert.equal(busy.sessions, 2);
	assert.ok(busy.webhookDeliveries > 0);

	const numbers = visitors.map(visitor => visitor.waId);

	await endVisitors();

	const idle = await waitFor("the counters to settle", async () => {
		const current = await stats();

		return current.sessions === 0 && current.sockets === 0 && current.sessionLocks === 0 ? current : null;
	});

	assert.equal(idle.identities, 0);
	assert.equal(idle.uploads, 0);

	const deliveries = await admin("/api/webhook-deliveries?limit=200");
	const requests = await admin("/api/graph-requests?limit=200");

	for (const waId of numbers) {
		assert.ok(!JSON.stringify(deliveries.body).includes(waId), `delivery log still names ${waId}`);
		assert.ok(!JSON.stringify(requests.body).includes(waId), `request log still names ${waId}`);
	}
});

await check("the Graph listener takes only the registered token", async () => {
	const ana = await startVisitor();
	const send = {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ messaging_product: "whatsapp", to: ana.waId, type: "text", text: { body: "hi" } }),
	};

	for (const token of [null, "not-registered", ADMIN_TOKEN]) {
		const response = await graph(`/${PHONE_NUMBER_ID}/messages`, send, token);

		assert.equal(response.status, 401, String(token));
		assert.equal(response.body.error.code, 190);
	}

	const cookieOnly = await fetch(`${GRAPH_URL}/v25.0/${PHONE_NUMBER_ID}/messages`, {
		...send,
		headers: { ...send.headers, cookie: `wasandbox_visitor=${ana.cookie}` },
	});

	assert.equal(cookieOnly.status, 401);
	assert.equal(await statusOf(graph(`/${PHONE_NUMBER_ID}/messages`, send)), 200);
	await endVisitors();
});

await check("no credential reaches the container's log", async () => {
	const ana = await startVisitor();
	const cookie = ana.cookie;

	await ana.sendText("log check");
	await endVisitors();

	const log = docker("logs", CONTAINER);

	for (const secret of [ADMIN_TOKEN, APP_TOKEN, cookie, ana.session.csrfToken]) {
		assert.ok(!log.includes(secret), "the log contains a credential");
	}

	// The Graph request log masks the token it records.
	const requests = await admin("/api/graph-requests?limit=5");

	assert.ok(!JSON.stringify(requests.body).includes(APP_TOKEN));

	// And the echo app is still healthy: nothing above broke the app under test.
	assert.equal(await statusOf(fetch(`${ECHO_URL}/health`)), 200);
});

const failed = results.filter(result => !result.passed);

console.log(`\n${String(results.length - failed.length)}/${String(results.length)} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
