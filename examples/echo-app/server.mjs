// A minimal app under test for mockwa: what a real WhatsApp Cloud API integration does, and
// nothing that knows it is talking to a simulator. Dependency-free, so it runs with plain
// `node examples/echo-app/server.mjs` and shares no code with the server it tests.
//
//   GET  /webhook      Meta's `hub.challenge` handshake, checked against VERIFY_TOKEN
//   POST /webhook      a webhook delivery: the signature is checked over the raw bytes, the
//                      delivery is recorded, and an inbound text gets an "echo: …" reply
//   GET  /deliveries   what was received, for tests to assert on
//   DELETE /deliveries forget it
//   GET  /health       liveness
//
// Environment: PORT (3001), APP_SECRET, VERIFY_TOKEN, GRAPH_API_BASE_URL (with its version
// segment, e.g. http://127.0.0.1:8888/v25.0), ACCESS_TOKEN (any non-empty token by default).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "3001");
const appSecret = process.env.APP_SECRET ?? "";
const verifyToken = process.env.VERIFY_TOKEN ?? "";
const graphApiBaseUrl = (process.env.GRAPH_API_BASE_URL ?? "").replace(/\/+$/, "");
const accessToken = process.env.ACCESS_TOKEN ?? "echo-app-token";

/** @type {Array<{receivedAt: string, signature: string | null, signatureValid: boolean, rawBody: string, body: unknown, reply: unknown}>} */
const deliveries = [];

/** HMAC-SHA256 of the exact bytes received, compared in constant time. */
function isSignatureValid(header, rawBody) {
	if (appSecret === "" || typeof header !== "string") {
		return false;
	}

	const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
	const actual = Buffer.from(header);

	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Replies to an inbound text through the Graph API, the way a real bot would. */
async function replyTo(value, message) {
	if (graphApiBaseUrl === "" || message.type !== "text") {
		return null;
	}

	const response = await fetch(`${graphApiBaseUrl}/${value.metadata.phone_number_id}/messages`, {
		method: "POST",
		headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
		body: JSON.stringify({
			messaging_product: "whatsapp",
			to: message.from,
			type: "text",
			text: { body: `echo: ${message.text.body}` },
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
		signature,
		signatureValid,
		rawBody: rawBody.toString("utf8"),
		body: null,
		reply: null,
	};

	deliveries.push(record);

	// A real app must not act on a payload it cannot authenticate.
	if (!signatureValid) {
		console.log(`[webhook] REJECTED signature=${String(signature)}`);
		sendJson(res, 401, { error: "invalid signature" });

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
