# Webhooks

How WaSandbox sends webhooks to your app: connecting a receiver, the handshake, signatures, several
apps and their routing, retries, and what to check when a delivery goes wrong.

**On this page:** [Connect a receiver](#connect-a-receiver) · [Run the handshake](#run-the-handshake) ·
[Verify the signature](#verify-the-signature) · [Events WaSandbox sends](#events-wasandbox-sends) ·
[Several apps and routing](#several-apps-and-routing) · [Retries](#retries) ·
[Redeliver by hand](#redeliver-by-hand) · [The delivery log](#the-delivery-log) ·
[Troubleshooting](#troubleshooting)

## Connect a receiver

Set three variables on WaSandbox, with the same values your receiver uses:

| Variable                      | Value                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `WASANDBOX_WEBHOOK_URL`          | Your receiver's URL **as WaSandbox reaches it**, such as `http://app:3001/meta-webhooks` in Compose |
| `WASANDBOX_APP_SECRET`           | The app secret your receiver verifies signatures with                                            |
| `WASANDBOX_WEBHOOK_VERIFY_TOKEN` | The verify token your receiver expects in the handshake                                          |

Each delivery is a `POST` with `Content-Type: application/json`, `User-Agent: facebookexternalua`
and, when a secret is set, `X-Hub-Signature-256`. WaSandbox waits up to 10 seconds for an answer.

`localhost` inside the WaSandbox container is WaSandbox itself. To reach a receiver on your computer
from Docker, use `http://host.docker.internal:<port>/…` (on Linux add
`--add-host=host.docker.internal:host-gateway`). A full Compose example is in
[Getting started → Connect your own app](getting-started.md#connect-your-own-app).

Without `WASANDBOX_WEBHOOK_URL`, nothing is sent: each event is logged as `skipped`, with the body it
would have had. WaSandbox never replies to a user by itself; replies come only from your app.

## Run the handshake

Meta checks a receiver with a `GET <url>?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<random>`;
the receiver must answer `200` with the challenge. WaSandbox runs the same check:

- at boot, **once**, when `WASANDBOX_VERIFY_ON_START=true`. A receiver that is still starting makes it
  fail with `webhook handshake failed` in the log, and nothing else is wrong;
- whenever you ask: **Verify webhook** on the Webhooks page, or

```sh
curl -s -X POST http://localhost:8025/api/webhook/handshake
```

For a registered app, use `POST /api/apps/{key}/handshake`.

## Verify the signature

WaSandbox serializes each body **once**, with Meta's escaping of every character above U+007F as
`\uXXXX`, and signs **exactly those bytes** with HMAC-SHA256. Verify over the raw request body,
before any JSON parsing:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

/** `rawBody` is the request body as received (a Buffer), never re-serialized JSON. */
export function isValidSignature(rawBody, header, appSecret) {
	const expected = Buffer.from(`sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`);
	const received = Buffer.from(header ?? "");

	return received.length === expected.length && timingSafeEqual(received, expected);
}
```

A receiver that verifies the way Meta documents accepts WaSandbox's webhooks unchanged. The payloads
are tested against Meta samples in [`docs/fixtures/webhooks/`](fixtures/webhooks/).

The console's Webhooks page says **"signature generated"**: WaSandbox signed the body and sent the
header. It cannot say "verified": only your receiver knows whether it checked, and WaSandbox sees only
the status it answered.

## Events WaSandbox sends

| Event                                          | When                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `messages` with `messages[]`                   | A user sends a message: every type, `unsupported`, with `referral`, forwarded and `referred_product` riders |
| `messages` with `statuses[]`                   | A business message moves to `sent`, `delivered`, `read` or `failed`                                         |
| `messages` with `user_changed_number`          | A contact changes number                                                                                    |
| `message_template_status_update`               | A template is approved, rejected, paused or disabled                                                        |
| `message_template_quality_update`              | A template's quality changes                                                                                |
| `phone_number_quality_update`                  | A number's quality changes (when asked to send it)                                                          |
| `account_update`, `business_capability_update` | Only when you send them from the console or `/api`; they change no state                                    |
| anything                                       | `POST /api/webhook/raw` sends any JSON object, signed                                                       |

A read receipt from your app sends no webhook, as on Meta: statuses are reported for business
messages only.

## Several apps and routing

One WABA can feed several Meta apps, and WaSandbox plays all of them.

- **The default app** is the one the environment describes (`WASANDBOX_WEBHOOK_URL`,
  `WASANDBOX_APP_SECRET`, `WASANDBOX_WEBHOOK_VERIFY_TOKEN`).
- **More apps** come from `WASANDBOX_APPS` or **Settings → Apps & webhooks**. Each has its own URL,
  secret and verify token, and gets **its own copy** of every webhook of the WABAs it subscribes
  to, signed with its own secret:

  ```yaml
  WASANDBOX_APPS: >-
    [{"name":"Billing","appSecret":"billing-secret","verifyToken":"billing-verify",
      "callbackUrl":"http://billing:3001/webhook","accessToken":"billing-token",
      "wabas":["666635535888644"]}]
  ```

- **Which app a Graph call acts for** is the one whose `accessToken` it sends; any other token
  acts for the default app.
- **Overrides** work as on Meta: `POST /{waba}/subscribed_apps` with `override_callback_uri` and
  `verify_token` sets a WABA override; `POST /{phone-number}` with `webhook_configuration` sets a
  number override. A number override beats a WABA override, which beats the app's URL.
  Overrides move message webhooks; **template and account webhooks always go to the app's own
  URL**.
- The default app keeps receiving a WABA's webhooks while **no registered app** subscribes to it,
  so a single-URL setup never goes silent. This differs from Meta on purpose ([SPEC §2](SPEC.md#2-graph-api-mock--mvp-endpoint-behavior), item 20).

To ask where an event would go right now, and why:

```sh
curl -s 'http://localhost:8025/api/webhook-routes?wabaId=666635535888644&field=messages'
```

In **public mode**, destinations come only from configuration: the Graph overrides answer `400`
and the console refuses new URLs with `403 webhook_destinations_locked`.

## Retries

**Only an HTTP `200` counts as delivered**, as on Meta. Anything else is retried: a `500`, a
`404`, even a `204`, a refused connection or a timeout.

- **Schedule**: 10 s, 30 s, 1 m, 5 m, 15 m, 1 h, 3 h, 6 h, 12 h, then every 24 h, until the first
  attempt is 7 days old. Meta documents only "decreasing frequency, for up to 7 days"; the exact
  steps are **WaSandbox's own choice**. Change them with `WASANDBOX_WEBHOOK_RETRY_SCHEDULE` and
  `WASANDBOX_WEBHOOK_RETRY_MAX_AGE`, or turn retries off with `WASANDBOX_WEBHOOK_RETRY_SCHEDULE=off`.
- **Same bytes, same signature.** A retry resends the stored body with the same signature, so your
  handler can deduplicate.
- **Stored.** The queue is in SQLite. With a file database a pending retry survives a restart and
  goes out when due (late, if WaSandbox was down then). An import cancels pending retries.
- **On the virtual clock**, retries wait for virtual time; advance the clock to fire them.
- **Cancel** one chain's retries with **Cancel retry**, or
  `POST /api/webhook-deliveries/{id}/cancel-retry`.

### Watch a retry happen

This continues the [Getting started](getting-started.md#do-a-first-round-trip) setup: WaSandbox on
`127.0.0.1:8025`, and [`examples/echo-app`](../examples/echo-app/server.mjs) in the container
`wasandbox-quickstart-echo`, whose port 3001 is published on `127.0.0.1:3001`. The `/fail` calls go
to the echo app, not to wasandbox.

The echo app fails the next deliveries **of any kind**, status webhooks included. So start at
least five seconds after your last send, when the earlier status webhooks have gone out;
otherwise one of them takes a failure meant for Ana's message.

1. Make the echo app answer the next two deliveries with `500`:

   ```sh
   curl -s -X PUT http://127.0.0.1:3001/fail -H 'Content-Type: application/json' \
     -d '{"status":500,"count":2}'
   ```

2. Send a message as Ana:

   ```sh
   curl -s -X POST http://127.0.0.1:8025/api/inbound -H 'Content-Type: application/json' \
     -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"retry me"}}'
   ```

3. Wait about 45 seconds, then read the newest deliveries:

   ```sh
   curl -s 'http://127.0.0.1:8025/api/webhook-deliveries?limit=10'
   ```

   Expected result: step 1 answers `{"status":500,"remaining":2}`, step 2 answers `201`. The
   list is newest first; find the three rows of Ana's message (the same `chainId`, a
   `requestBody` that contains `retry me`):

   | `attempt` | When                  | `responseStatus` | `outcome`   |
   | --------- | --------------------- | ---------------- | ----------- |
   | `1`       | at once               | `500`            | `failed`    |
   | `2`       | 10 s later            | `500`            | `failed`    |
   | `3`       | 30 s after the second | `200`            | `delivered` |

   If you look sooner, the newest failed row shows `retrying` instead: a failed attempt reads
   `retrying` while its next attempt is still due, and `failed` once that attempt has run.

   The echo app then handles the message, so its `echo: retry me` reply and that reply's status
   webhooks follow. In the console, **Webhooks** shows the same chain.

The count runs out by itself. To fail every delivery until you stop it, leave out `count`, and
answer normally again with `curl -s -X DELETE http://127.0.0.1:3001/fail`.

## Redeliver by hand

A retry and a redelivery are different things:

|               | Automatic retry                | Redeliver                                                            |
| ------------- | ------------------------------ | -------------------------------------------------------------------- |
| Who starts it | WaSandbox, after a failure        | You: **Redeliver**, or `POST /api/webhook-deliveries/{id}/redeliver` |
| Where it goes | The URL of the first attempt   | The app's **current** URL and routing                                |
| Signature     | The original one, same bytes   | Signed **now**, with the app's current secret                        |
| Chain         | Next attempt of the same chain | A **new** chain                                                      |

Use redeliver after you fix a URL or a secret.

## The delivery log

Every attempt is a row: `GET /api/webhook-deliveries`, or the Webhooks page. Retries are separate
rows of one chain (same `chainId`, `attempt` counting up). Each row keeps the exact body and
headers sent, the receiver's status and answer, and the outcome: `delivered`, `retrying`,
`failed` or `skipped`.

- In **dev mode** the log keeps every row until a reset or an import.
- In **public mode** finished rows are cut to the newest 2,000 on each cleanup pass, and a
  visitor's rows leave with the visitor ([Deployment → Cleanup](deployment.md#cleanup)).
- The log holds message text and phone numbers. A snapshot leaves it out unless
  `?include=deliveries` asks for it.

## Troubleshooting

| What you see                                                        | Likely cause and fix                                                                                                 |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Every row `skipped`                                                 | `WASANDBOX_WEBHOOK_URL` is not set, or the app has no URL                                                               |
| `webhook handshake failed` at boot                                  | Receiver not up yet, or a different verify token. Run the handshake again                                            |
| Error `ECONNREFUSED`, `ENOTFOUND` or a timeout                      | WaSandbox cannot reach the URL. Use the Compose service name or `host.docker.internal`, not `localhost`                 |
| `401` or `403` from your receiver, and a signature error in its log | `WASANDBOX_APP_SECRET` differs from the receiver's secret, or the receiver verifies parsed JSON instead of the raw body |
| `retrying` though your receiver handled it                          | It answered something other than `200` (a `201` or `204` counts as a failure)                                        |
| A user's message is stored but nothing answers                      | Expected without an app that replies. Check **Requests**: did your app call the Graph API?                           |
| Webhooks go to an unexpected URL                                    | An override is set. Ask `GET /api/webhook-routes`                                                                    |
| Template webhooks ignore your override                              | By design: they always go to the app's own URL                                                                       |
