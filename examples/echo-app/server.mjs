// A minimal app under test for mockwa: what a real WhatsApp Cloud API integration does, and
// nothing that knows it is talking to a simulator. Dependency-free, so it runs with plain
// `node examples/echo-app/server.mjs` and shares no code with the server it tests.
//
//   GET  /webhook      Meta's `hub.challenge` handshake, checked against VERIFY_TOKEN
//   POST /webhook      a webhook delivery: the signature is checked over the raw bytes, the
//                      delivery is recorded, and an inbound message gets a reply:
//                        "menu"      → an interactive message with two reply buttons
//                        "template"  → the TEMPLATE_NAME template (quick-reply buttons)
//                        a tapped button (interactive reply or template quick reply)
//                                    → "selected: <title>"
//                        any other text → "echo: <text>"
//   GET  /deliveries   what was received, for tests to assert on
//   DELETE /deliveries forget it
//   PUT  /fail         make deliveries fail on purpose, to watch mockwa retry them:
//                      {"status": 500, "count": 2} answers the next 2 with a 500; without
//                      "count" every delivery fails until DELETE /fail. Any status but 200
//                      counts as a failure for Meta, a 204 included.
//   GET  /fail         the failure mode in force, `{"status": null}` when there is none
//   DELETE /fail       answer normally again
//   GET  /health       liveness
//
// Environment: PORT (3001), APP_SECRET, VERIFY_TOKEN, GRAPH_API_BASE_URL (with its version
// segment, e.g. http://127.0.0.1:8888/v25.0), ACCESS_TOKEN (any non-empty token by default),
// TEMPLATE_NAME / TEMPLATE_LANGUAGE (an approved template whose body takes one parameter, the
// customer's name; appointment_confirmation / en by default).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "3001");
const appSecret = process.env.APP_SECRET ?? "";
const verifyToken = process.env.VERIFY_TOKEN ?? "";
const graphApiBaseUrl = (process.env.GRAPH_API_BASE_URL ?? "").replace(/\/+$/, "");
const accessToken = process.env.ACCESS_TOKEN ?? "echo-app-token";
const templateName = process.env.TEMPLATE_NAME ?? "appointment_confirmation";
const templateLanguage = process.env.TEMPLATE_LANGUAGE ?? "en";

/** @type {Array<{receivedAt: string, url: string, signature: string | null, signatureValid: boolean, answeredStatus: number, rawBody: string, body: unknown, reply: unknown}>} */
const deliveries = [];

/** The failure mode `PUT /fail` sets: `remaining` is `null` for "until cleared". */
const failure = { status: null, remaining: null };

function setFailureMode(status, remaining) {
	failure.status = status;
	failure.remaining = remaining;
}

/** The status to fail this delivery with, consuming one from the count; `null` to answer normally. */
function takeFailure() {
	if (failure.status === null) {
		return null;
	}

	const { status } = failure;

	if (failure.remaining !== null) {
		failure.remaining -= 1;

		if (failure.remaining <= 0) {
			setFailureMode(null, null);
		}
	}

	return status;
}

function setFailure(res, rawBody) {
	const text = rawBody.toString("utf8") || "{}";
	let request;

	try {
		request = JSON.parse(text);
	} catch {
		sendJson(res, 400, { error: "the body must be JSON" });

		return;
	}

	const status = Number(request.status ?? 500);
	const count = request.count === undefined ? null : Number(request.count);

	if (status === 200 || !Number.isSafeInteger(status) || status < 100 || status > 599) {
		sendJson(res, 400, { error: "status must be an HTTP status other than 200" });

		return;
	}

	if (count !== null && (!Number.isSafeInteger(count) || count < 1)) {
		sendJson(res, 400, { error: "count must be a positive integer" });

		return;
	}

	setFailureMode(status, count);
	console.log(
		`[fail] answering ${String(status)} ${count === null ? "until DELETE /fail" : `${String(count)} time(s)`}`,
	);
	sendJson(res, 200, failure);
}

/** HMAC-SHA256 of the exact bytes received, compared in constant time. */
function isSignatureValid(header, rawBody) {
	if (appSecret === "" || typeof header !== "string") {
		return false;
	}

	const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
	const actual = Buffer.from(header);

	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The title of a tapped button: an interactive `button_reply`, or a template quick reply. */
function tappedTitle(message) {
	if (message.type === "interactive") {
		return message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
	}

	return message.type === "button" ? message.button?.text : undefined;
}

/** What a small booking bot would answer; `null` for a message it ignores. */
function replyFor(value, message) {
	const tapped = tappedTitle(message);

	if (tapped !== undefined) {
		return { type: "text", text: { body: `selected: ${tapped}` } };
	}

	if (message.type !== "text") {
		return null;
	}

	const text = message.text.body.trim().toLowerCase();

	if (text === "menu") {
		return {
			type: "interactive",
			interactive: {
				type: "button",
				body: { text: "Your technician visit is tomorrow at 10:00. Does that still work?" },
				action: {
					buttons: [
						{ type: "reply", reply: { id: "visit-confirm", title: "Confirm" } },
						{ type: "reply", reply: { id: "visit-reschedule", title: "Reschedule" } },
					],
				},
			},
		};
	}

	if (text === "template") {
		const name = value.contacts?.find(contact => contact.wa_id === message.from)?.profile?.name ?? "there";

		return {
			type: "template",
			template: {
				name: templateName,
				language: { code: templateLanguage },
				components: [{ type: "body", parameters: [{ type: "text", text: name }] }],
			},
		};
	}

	return { type: "text", text: { body: `echo: ${message.text.body}` } };
}

/** Replies through the Graph API, the way a real bot would, quoting the message it answers. */
async function replyTo(value, message) {
	const reply = replyFor(value, message);

	if (graphApiBaseUrl === "" || reply === null) {
		return null;
	}

	const response = await fetch(`${graphApiBaseUrl}/${value.metadata.phone_number_id}/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: message.from,
			...reply,
			context: { message_id: message.id },
		}),
	});

	return { status: response.status, body: await response.json() };
}

/** Every inbound message in a delivery, with the `value` node that carries its metadata. */
function inboundMessages(body) {
	const changes = (body.entry ?? []).flatMap(entry => entry.changes ?? []);

	return changes.flatMap(change => (change.value?.messages ?? []).map(message => ({ value: change.value, message })));
}

function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

async function handleDelivery(req, res, rawBody) {
	const signature = req.headers["x-hub-signature-256"] ?? null;
	const signatureValid = isSignatureValid(signature, rawBody);
	const receivedAt = new Date();
	const record = {
		receivedAt: receivedAt.toISOString(),
		// The path and query it arrived on, so a test can tell an override URL from the app's own.
		url: req.url ?? "/",
		signature,
		signatureValid,
		answeredStatus: 200,
		rawBody: rawBody.toString("utf8"),
		body: null,
		reply: null,
	};

	deliveries.push(record);

	// A real app must not act on a payload it cannot authenticate.
	if (!signatureValid) {
		console.log(`[webhook] REJECTED signature=${String(signature)}`);
		record.answeredStatus = 401;
		sendJson(res, 401, { error: "invalid signature" });

		return;
	}

	const failWith = takeFailure();

	// A simulated outage: nothing is acted on, so the retry that follows is what does the work.
	if (failWith !== null) {
		console.log(`[webhook] failing on purpose with ${String(failWith)}`);
		record.answeredStatus = failWith;
		res.writeHead(failWith, { "content-type": "application/json" });
		res.end(failWith === 204 ? undefined : JSON.stringify({ error: "failing on purpose" }));

		return;
	}

	record.body = JSON.parse(record.rawBody);
	// Meta wants a fast 200; the reply goes out after it.
	sendJson(res, 200, { ok: true });

	for (const { value, message } of inboundMessages(record.body)) {
		try {
			record.reply = await replyTo(value, message);
		} catch (error) {
			record.reply = { error: String(error) };
		}
	}

	console.log(`[webhook] valid ${record.rawBody}`);
}

async function handleDeliverySafely(req, res, rawBody) {
	try {
		await handleDelivery(req, res, rawBody);
	} catch (error) {
		console.error(error);

		if (!res.headersSent) {
			sendJson(res, 500, { error: "internal" });
		}
	}
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const chunks = [];

	req.on("data", chunk => {
		chunks.push(chunk);
	});
	req.on("end", () => {
		const rawBody = Buffer.concat(chunks);

		if (url.pathname === "/health") {
			sendJson(res, 200, { status: "ok" });
		} else if (url.pathname === "/deliveries" && req.method === "GET") {
			sendJson(res, 200, { deliveries });
		} else if (url.pathname === "/deliveries" && req.method === "DELETE") {
			deliveries.length = 0;
			sendJson(res, 200, { ok: true });
		} else if (url.pathname === "/fail" && req.method === "PUT") {
			setFailure(res, rawBody);
		} else if (url.pathname === "/fail" && req.method === "GET") {
			sendJson(res, 200, failure);
		} else if (url.pathname === "/fail" && req.method === "DELETE") {
			setFailureMode(null, null);
			sendJson(res, 200, failure);
		} else if (url.pathname === "/webhook" && req.method === "GET") {
			const isVerified =
				url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === verifyToken;

			res.writeHead(isVerified ? 200 : 403, { "content-type": "text/plain" });
			res.end(isVerified ? (url.searchParams.get("hub.challenge") ?? "") : "forbidden");
		} else if (url.pathname === "/webhook" && req.method === "POST") {
			void handleDeliverySafely(req, res, rawBody);
		} else {
			sendJson(res, 404, { error: "not found" });
		}
	});
});

server.listen(port, () => {
	console.log(`echo-app listening on :${String(port)} (webhook: POST /webhook)`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
