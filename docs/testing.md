# Testing your app

How to test your own WhatsApp integration against mockwa: keep runs isolated, play the user from
a test, move time, make things fail on purpose, and run scenario files in CI. Each section says
which parts follow Meta and which are mockwa's own.

**On this page:** [Start a test instance](#start-a-test-instance) ·
[Keep every run isolated](#keep-every-run-isolated) ·
[Play the user from a test](#play-the-user-from-a-test) ·
[Move time with the virtual clock](#move-time-with-the-virtual-clock) ·
[Check the messaging rules](#check-the-messaging-rules) · [Inject errors](#inject-errors) ·
[Expire or reject tokens](#expire-or-reject-tokens) · [Expire media](#expire-media) ·
[Run scenarios](#run-scenarios) · [Share a reproduction](#share-a-reproduction) ·
[Meta behavior and mockwa behavior](#meta-behavior-and-mockwa-behavior)

## Start a test instance

Several commands on this page **wipe the instance** they are sent to: a reset, an import, a
scenario run. So every command here goes to a **dedicated test instance**, never to the
[Getting started](getting-started.md) one or to an instance someone else uses.

1. Pick two free host ports. This page uses 47888 (Graph) and 47025 (console);
   `lsof -i :47888 -i :47025` prints nothing when they are free.
2. Start the instance from a checkout, with the `mockwa:local` image from
   [Getting started](getting-started.md#get-an-image). It runs on the virtual clock, accepts one
   app token, and has the example scenarios mounted:

   ```sh
   docker run -d --name mockwa-test -p 127.0.0.1:47888:8888 -p 127.0.0.1:47025:8025 \
     -v "$PWD/examples/scenarios:/scenarios:ro" \
     -e MOCKWA_CLOCK=virtual -e MOCKWA_CLOCK_START=2026-06-01T08:00:00Z \
     -e MOCKWA_TOKENS=test-app-token \
     mockwa:local
   ```

3. Name its two addresses once, in the shell you run the rest of the page from:

   ```sh
   CONSOLE=http://127.0.0.1:47025
   GRAPH=http://127.0.0.1:47888
   curl -s "$CONSOLE/health"
   ```

   Expected result: `{"status":"ok",…}`.

It has no webhook URL, so webhooks are logged as `skipped` instead of sent. Point
`MOCKWA_WEBHOOK_URL` at your app to test it for real.

When you are done, remove it with its anonymous `/data` volume:
`docker rm -f -v mockwa-test`.

## Keep every run isolated

1. Give each test run its own container, with a unique name and free host ports.
2. Keep state in memory (the default), or on a volume only that run uses.
3. Call `POST /api/reset` before each test that needs a clean world. It wipes everything, deletes
   stored media, and applies the seed again. The seeded IDs stay the same.
4. Remove the container, with `-v`, when the run ends.

```sh
curl -s -X POST "$CONSOLE/api/reset"
```

On the virtual clock, the same steps after a reset produce the same wamids, the same webhook
bytes and the same signatures, so you can compare whole payloads. On the real clock, IDs are
random.

## Play the user from a test

Everything the console does, a test can do through the console port's `/api`.

| To…                                           | Call                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------- |
| Send a message as a user                      | `POST /api/inbound` (text, media, interactive and button replies, location, …)      |
| Mark a business message delivered/read/failed | `POST /api/messages/{id}/status`                                                    |
| Approve or reject a template                  | `POST /api/templates/{id}/approve` or `…/reject`                                    |
| See what your app sent                        | `GET /api/conversations/{phoneNumberId}:{waId}/messages`, `GET /api/graph-requests` |
| See what mockwa sent to your app              | `GET /api/webhook-deliveries`                                                       |
| Wait for events instead of polling            | the WebSocket `GET /api/ws`                                                         |

Example: Ana writes, the app answers, and Ana reads the answer. The `id` of the app's message
(its wamid) comes from the Graph answer, so the second command keeps it in `WAMID`:

```sh
curl -s -X POST "$CONSOLE/api/inbound" -H 'Content-Type: application/json' \
  -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"yes"}}'

WAMID=$(curl -s -X POST "$GRAPH/v25.0/573542517421694/messages" \
  -H 'Authorization: Bearer test-app-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"Thanks!"}}' |
  sed -E 's/.*"id":"([^"]+)".*/\1/')
echo "$WAMID"

curl -s -X POST "$CONSOLE/api/messages/$WAMID/status" -H 'Content-Type: application/json' \
  -d '{"status":"read"}'
```

Expected result: the inbound call answers `201` with Ana's message, `echo` prints a `wamid.…`,
and the last call answers with that message and `"status":"read"`. With a webhook URL set, your
app also gets a `read` status webhook; on the test instance it is logged as `skipped`. The full
list of calls is in the
[API reference](api-reference.md#control-plane-api).

## Move time with the virtual clock

> Simulator-only. Meta has no clock you can move.

With `MOCKWA_CLOCK=virtual`, as on the [test instance](#start-a-test-instance), time stands
still until you move it:

```sh
curl -s "$CONSOLE/api/clock"                                     # now, and what is pending
curl -s -X POST "$CONSOLE/api/clock/advance" -H 'Content-Type: application/json' -d '{"by":"5m"}'
curl -s -X POST "$CONSOLE/api/clock/set" -H 'Content-Type: application/json' -d '{"to":"2026-06-02T08:00:00Z"}'
curl -s -X POST "$CONSOLE/api/clock/run-next"                    # jump to the next event
```

An advance answers `{from, to, fired, clock}`: every event it ran, in order, each at its own due
time. It returns only when that work, and the webhooks it sent, is done, so you can assert right
after it.

**What the clock moves.** Every timer and timestamp **inside mockwa**: message, status and webhook
timestamps, the status ladder, template auto-approval, typing indicators, the 24-hour window, the
messaging limit, rate limits, media expiry, and webhook retries with their 7-day limit.

**What it does not move.**

- **Your app's clock.** Its timers, token expiry, OTP expiry and `Date.now()` keep real time. This
  includes apps such as Workbench and GotUnit: advancing mockwa does not expire their codes.
  Webhook timestamps show mockwa's time, so an app that compares them with its own clock sees a
  difference.
- **Network time.** A webhook's 10-second timeout and a scenario's `within` wait stay real.

**The status ladder is cumulative.** `MOCKWA_STATUS_DELAYS=sent:0,delivered:800,read:1000` means
`sent` at once, `delivered` 800 ms later, and `read` 1,000 ms after that: 1,800 ms after the send.

**Good to know.**

- Events due at the same instant run in the order they were scheduled.
- Time never goes back. `set` to an earlier time is refused; `POST /api/reset` returns to
  `MOCKWA_CLOCK_START`.
- With a file database, the clock's position and pending webhook retries survive a restart. The
  status ladder, auto-approvals and typing timers do not.
- Public mode refuses the virtual clock.

## Check the messaging rules

mockwa can apply four of Meta's sending rules. Only the first is on by default.

| Rule                    | Variable (default)               | When it applies                                                       | Result                                                   |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Customer service window | `MOCKWA_SERVICE_WINDOW` (`24h`)  | A non-template message to a contact who has not written in the window | `200`, then a `failed` status with `131047`              |
| Throughput              | `MOCKWA_THROUGHPUT` (`off`)      | Too many sends per second from one number                             | `429`, code `130429`, `Retry-After: 1`                   |
| Pair rate limit         | `MOCKWA_PAIR_RATE_LIMIT` (`off`) | Too many sends to one contact                                         | `400`, code `131056`                                     |
| Messaging limit         | `MOCKWA_MESSAGING_LIMIT` (`off`) | A template to a **new** contact over the 24-hour limit                | `200`, then `failed` with mockwa's own code **`990001`** |

To reach a boundary fast, shorten it (`MOCKWA_SERVICE_WINDOW=30s`) or close one window now:

```sh
curl -s "$CONSOLE/api/service-window?phoneNumberId=573542517421694&waId=5571990000001"
curl -s -X POST "$CONSOLE/api/service-window/expire" -H 'Content-Type: application/json' \
  -d '{"phoneNumberId":"573542517421694","waId":"5571990000001"}'
curl -s "$CONSOLE/api/messaging-rules"
```

**`990001` is not a Meta code.** Meta documents the messaging limit but no error code for going
over it, so mockwa uses its own, titled `[mockwa] Messaging limit reached (simulated)`. Never build
production logic on it. **`131048` is not that limit either**: it is a restriction on the sending
number (for example after blocks or spam reports), and in mockwa it is only a manual failure
preset. Every place mockwa differs from Meta here is listed in
[SPEC, "Differences from the real Meta Cloud API"](SPEC.md#differences-from-the-real-meta-cloud-api).

## Inject errors

An injection rule makes Graph calls fail on purpose: **where** (target), **when** (trigger) and
**how** (preset). Rules are off until you create one, never random, and shown in the console's
top bar while they can fire. A reset deletes them.

| Part    | Values                                                                                                                                   |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Target  | `messages.send`, `messages.status`, `media.upload`, `media.resolve`, `media.download`, `templates.create`, `templates.list`, `graph.all` |
| Trigger | `{"kind":"always"}`, `{"kind":"next","count":N}`, `{"kind":"every","nth":N}`                                                             |
| Preset  | `rate_limit_429`, `throughput_131056`, `spam_rate_4`, `server_error_500`, `custom`, `failed_status` (only for `messages.status`)         |

The next three sends answer `429`:

```sh
curl -s -X POST "$CONSOLE/api/injection-rules" -H 'Content-Type: application/json' \
  -d '{"target":"messages.send","trigger":{"kind":"next","count":3},"preset":"rate_limit_429","retryAfterSeconds":42,"regainAccessMinutes":7}'
```

Expected result: each of the next three sends gets Meta's `130429` envelope with `Retry-After: 42`
(seconds) and an `X-Business-Use-Case-Usage` header whose `estimated_time_to_regain_access` is `7`
(minutes). The fourth send succeeds.

| Preset              | Answer                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------- |
| `rate_limit_429`    | `429`, code `130429`, `Retry-After` and `X-Business-Use-Case-Usage`                     |
| `throughput_131056` | `400`, code `131056` (the pair rate limit), no headers                                  |
| `spam_rate_4`       | `429`, code `4`, the same two headers                                                   |
| `server_error_500`  | `500`, code `1`                                                                         |
| `custom`            | The status, code, subcode and message you give                                          |
| `failed_status`     | The send answers `200`, then its first status webhook is `failed` with your `errorCode` |

The name `throughput_131056` is mockwa's own label, inherited from whaloc; `131056` is Meta's
**pair** rate-limit code, not its throughput code (`130429`). The message text of this preset
has not been compared with a captured Meta response.

To fail a message **after** it was accepted, which is how many real failures arrive:

```sh
curl -s -X POST "$CONSOLE/api/injection-rules" -H 'Content-Type: application/json' \
  -d '{"target":"messages.status","trigger":{"kind":"next","count":1},"preset":"failed_status","errorCode":131026}'
```

Rules run after the bearer check, so a rule never hides a `401`. When several rules match, the
first one created whose trigger fires answers; the others keep their countdowns. List and delete
rules with `GET /api/injection-rules` and `DELETE /api/injection-rules/{id}`.

## Expire or reject tokens

By default the Graph API accepts any non-empty bearer token. Set `MOCKWA_TOKENS` to a
comma-separated list and only those pass; anything else gets `401`, code `190`, the same answer
as a missing token. Then expire one to test your "refresh the token" path.

1. Start from a clean world. The sections above left injection rules behind (the next sends
   would get `429`, and their statuses `failed`), and closed Ana's service window. A reset
   removes the rules and restores every token; a message from Ana opens her window again:

   ```sh
   curl -s -X POST "$CONSOLE/api/reset"
   curl -s -X POST "$CONSOLE/api/inbound" -H 'Content-Type: application/json' \
     -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"hi again"}}'
   curl -s "$CONSOLE/api/injection-rules"
   ```

   Expected result: the reset answers with the fresh state (`{"data":{…,"wabas":[…]}}`), the
   inbound call answers `201` with Ana's message, and the rule list is `{"data":[]}`.

2. Find the token's `id`. The list shows each token masked; the test instance has one, so the
   first `id` is the one to use:

   ```sh
   curl -s "$CONSOLE/api/tokens"
   TOKEN_ID=$(curl -s "$CONSOLE/api/tokens" | sed -E 's/[^{]*\{[^}]*"id":"?([^",}]+).*/\1/')
   echo "$TOKEN_ID"
   ```

   Expected result: one token, `"strict":true`, and `echo` prints its `id`.

3. Expire it, send, restore it, and send the same message again. `-w` prints each answer's HTTP
   status:

   ```sh
   curl -s -X POST "$CONSOLE/api/tokens/$TOKEN_ID/expire"
   curl -s -w '\nHTTP %{http_code}\n' -X POST "$GRAPH/v25.0/573542517421694/messages" \
     -H 'Authorization: Bearer test-app-token' -H 'Content-Type: application/json' \
     -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"still there?"}}'
   curl -s -X POST "$CONSOLE/api/tokens/$TOKEN_ID/restore"
   curl -s -w '\nHTTP %{http_code}\n' -X POST "$GRAPH/v25.0/573542517421694/messages" \
     -H 'Authorization: Bearer test-app-token' -H 'Content-Type: application/json' \
     -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"still there?"}}'
   ```

   Expected result: after `expire`, the send answers `HTTP 401` with `"code":190,"error_subcode":463`
   and a "Session has expired" message, as Meta does. After `restore`, the same send answers
   `HTTP 200` with a `wamid.…`.

An expiry survives a restart with a file database; a reset restores every token. Token values
never leave the process. A registered app's `accessToken` must also be in `MOCKWA_TOKENS`.

## Expire media

`MOCKWA_MEDIA_TTL_SECONDS=5` makes uploaded media disappear from the Graph API 5 seconds after
upload (at exactly 5 s, it is gone). The media ID then answers `400`, code `100`, subcode `33`,
which is how apps detect expired media, and the byte URL answers a plain `404`. To remove one
object at once, call `DELETE /v25.0/{media-id}` on port 8888.

## Run scenarios

> Simulator-only.

A scenario is a JSON file: a world (numbers, people, apps, templates, error rules, a start time)
and steps (`send`, `tap`, `expect`, `advance`). mockwa **resets** into that world and runs the
steps against your app. Two examples are in [`examples/scenarios/`](../examples/scenarios/); the
format is in [SPEC, "Scenarios"](SPEC.md#scenarios-m4).

```json
{
	"name": "menu tap",
	"clock": { "start": "2026-05-04T09:00:00Z" },
	"identities": [{ "waId": "60123000001", "name": "Ana", "role": "CUSTOMER" }],
	"steps": [
		{ "send": { "as": "Ana", "text": "menu" } },
		{ "expect": { "message": { "to": "Ana", "type": "interactive" } } },
		{ "tap": { "as": "Ana", "option": "Confirm" } },
		{ "expect": { "message": { "to": "Ana", "text": "selected: Confirm" }, "within": "5s" } },
		{ "advance": "24h" },
		{ "expect": { "window": { "as": "Ana", "open": false } } }
	]
}
```

This example expects replies from [`examples/echo-app`](../examples/echo-app/server.mjs); with
your own app, expect what your app sends. A scenario that uses `advance` needs
`MOCKWA_CLOCK=virtual`.

### The `mockwa` command

```text
mockwa scenario run <file.json>... --url <console URL> [--junit <report.xml>] [--json <results.json>] [--timeout <seconds>]
mockwa scenario validate <file.json>... [--url <console URL>]
```

| Option      | Meaning                                                                          |
| ----------- | -------------------------------------------------------------------------------- |
| `--url`     | The console to use, such as `http://127.0.0.1:8025`. Or set `MOCKWA_CONSOLE_URL` |
| `--junit`   | Also write a JUnit XML report to this file                                       |
| `--json`    | Also write the full results as JSON                                              |
| `--timeout` | Give up on one scenario after this many seconds (default 600)                    |
| `--help`    | Print the usage                                                                  |

| Exit code | Meaning                                                                           |
| --------- | --------------------------------------------------------------------------------- |
| `0`       | Every scenario passed                                                             |
| `1`       | At least one scenario failed                                                      |
| `2`       | Bad arguments, an invalid file, or an instance it cannot reach or that refuses it |

`run` always needs `--url`, because it resets that instance. `validate` without `--url` checks
the file's shape only; with `--url` the instance checks it too, without changing anything.

**Inside the container**, the command is on the `PATH`. The scenario files are not in the image,
so mount them (the [test instance](#start-a-test-instance) has them at `/scenarios`), and use the
container's **own** console port, 8025, whatever the host port is:

```sh
docker exec mockwa-test mockwa scenario run /scenarios/service-window.json \
  --url http://127.0.0.1:8025 --junit /tmp/report.xml
echo "exit code $?"
```

Expected result: `PASS service window …`, nine `✓` steps, `1 scenario(s): 1 passed, 0 failed`,
and exit code `0`.

**From a checkout**, without Docker (after `npm ci`):
`npm run mockwa -- scenario run examples/scenarios/service-window.json --url "$CONSOLE"`.

**With an admin token.** The command sends no credentials and has no token option, so against an
instance with `MOCKWA_ADMIN_TOKEN` set it stops with `the instance refused it (401)` and exit
code `2`. Call the API yourself instead:

```sh
curl -s -X POST "$CONSOLE/api/scenarios/run" \
  -H "Authorization: Bearer $MOCKWA_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  --data-binary @examples/scenarios/service-window.json
```

Add `?format=junit` for a JUnit report. In public mode, keep scenarios off the public instance:
a run resets it and ends every visitor's session.

## Share a reproduction

A snapshot is the whole data of an instance in one JSON file, media bytes included:

```sh
curl -s "$CONSOLE/api/export" -o snapshot.json
curl -s "$CONSOLE/api/export?include=deliveries" -o snapshot-with-deliveries.json
curl -s -X POST "$CONSOLE/api/import" -H 'Content-Type: application/json' --data-binary @snapshot.json
```

- An import **replaces everything** and does not apply the seed. It is validated before anything
  is deleted, and a snapshot from a newer version is refused.
- The delivery log is left out unless `?include=deliveries` asks for it.
- A snapshot carries **app secrets, verify tokens and media URL tokens**, so an import gives a
  working instance. Treat the file as a secret.
- It is not a full backup: no clock position, no pending retries or timers, no request log.
  See [Configuration → What survives what](configuration.md#what-survives-what).

## Meta behavior and mockwa behavior

| Topic                          | Follows Meta                                                 | mockwa's own                                                         |
| ------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Error envelopes and codes      | Shapes and codes from Meta's references and captured traffic | `990001` (messaging limit); preset names such as `throughput_131056` |
| Unknown object ID              | `400`, code `100`, subcode `33`                              | —                                                                    |
| Webhook payloads and signing   | Tested against Meta samples in `docs/fixtures/webhooks/`     | —                                                                    |
| Only `200` counts as delivered | Meta's rule                                                  | —                                                                    |
| Retry timing                   | Meta: retries with decreasing frequency for up to 7 days     | The exact schedule (`10s,30s,1m,…`)                                  |
| Window error timing            | Meta documents `131047`, not whether it is synchronous       | Always `200`, then a `failed` status                                 |
| Messaging limit scope          | Per business portfolio                                       | Per WABA, fixed number, no tier upgrades                             |
| Clock, scenarios, injection    | —                                                            | Simulator-only                                                       |

The left column is mockwa's reading of Meta's documentation, recorded in [SPEC](SPEC.md) with its
sources. These pages do not re-check Meta's live documentation; where SPEC names no source,
treat the behavior as mockwa's choice.
