# API reference

The two listeners, how each one authenticates, and an index of every route: the Graph API your
app calls, the control-plane API tests use, and the virtual phone's API. Request and response
schemas of `/api` live in [`packages/shared/src/control-plane/`](../packages/shared/src/control-plane/);
the full contract is [SPEC](SPEC.md).

**On this page:** [The two ports](#the-two-ports) · [Authentication](#authentication) ·
[Errors](#errors) · [Graph API](#graph-api) · [How the Graph API behaves](#how-the-graph-api-behaves) ·
[Media and upload bytes](#media-and-upload-bytes) · [Control-plane API](#control-plane-api) ·
[Phone, visitor and admin routes](#phone-visitor-and-admin-routes) · [WebSocket events](#websocket-events)

## The two ports

| Listener | Port in the container          | Serves                                                                       | Used by              |
| -------- | ------------------------------ | ---------------------------------------------------------------------------- | -------------------- |
| Graph    | `8888` (`WASANDBOX_GRAPH_PORT`)   | `/v<major>.<minor>/…`, media and upload bytes, `/health`                     | Your app             |
| Console  | `8025` (`WASANDBOX_CONSOLE_PORT`) | The console, `/phone`, `/admin`, `/api/…`, `/api/ws`, media bytes, `/health` | You, tests, browsers |

Each listener answers `404` for the other's routes, so your app only ever sees a Meta-shaped
surface. Three addresses can point at the same listener:

| From where                     | Graph                          | Console                        |
| ------------------------------ | ------------------------------ | ------------------------------ |
| Your computer (published port) | `http://localhost:<host port>` | `http://localhost:<host port>` |
| Another Compose service        | `http://<service name>:8888`   | `http://<service name>:8025`   |
| Inside the WaSandbox container    | `http://127.0.0.1:8888`        | `http://127.0.0.1:8025`        |

`-p 127.0.0.1:18888:8888` changes only the first row.

## Authentication

### The Graph API

Every Graph route needs `Authorization: Bearer <token>`. A missing or empty token is `401` with
code `190`.

| `WASANDBOX_TOKENS` | Which tokens pass                                                                            |
| --------------- | -------------------------------------------------------------------------------------------- |
| unset (default) | Any non-empty token. WaSandbox never reads its content                                          |
| set             | Only the listed tokens. Others get the same `401` / `190`; an expired one gets subcode `463` |

When `WASANDBOX_APPS` registers apps, a Graph call acts for the app whose `accessToken` it sends,
otherwise for the default app. With `WASANDBOX_TOKENS` set, that token must be in the list too.
Public mode requires `WASANDBOX_TOKENS`.

### The console listener

| Mode                                     | Console pages and `/api`                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `dev`, no `WASANDBOX_ADMIN_TOKEN` (default) | **Open to anyone who can reach the port.** Keep it on `127.0.0.1` or a private network |
| `dev`, with `WASANDBOX_ADMIN_TOKEN`         | Everything except health and the sign-in needs the admin, the developer phone included |
| `public`                                 | Visitors reach the phone and its API with a session; everything else is the admin's    |

The admin authenticates in one of two ways:

- **A script** sends `Authorization: Bearer <WASANDBOX_ADMIN_TOKEN>`.
- **A browser** signs in at `/admin` and gets an HttpOnly, SameSite=Strict cookie for 12 hours,
  kept in memory (a restart signs everyone out).

Ten wrong tokens from one address within 15 minutes lock that address out for the rest of the
window (`429 admin_auth_rate_limited`), even with the right token.

**Cookies and origins.** A request authenticated by a cookie may write, or open a WebSocket, only
from the listener's own origin or one in `WASANDBOX_ALLOWED_ORIGINS`; otherwise `403 origin_refused`.
A visitor also sends its session's `X-CSRF-Token` header on every write (`403 csrf_failed`
without it). A bearer-token request has no origin to check.

**WebSockets.** `/api/ws` follows the same rule as the rest of the console: open in plain dev
mode, the admin's otherwise (`401` without). A visitor's socket is
`/api/phone/identities/{waId}/ws`, for its own numbers only.

**Webhook destinations in public mode** come only from configuration. A Graph override
(`override_callback_uri`, `webhook_configuration`) answers `400`, and a control-plane change that
would add a URL answers `403 webhook_destinations_locked`, admin included.

Route by route, with every refusal code: [access rules](access.md).

## Errors

**The Graph API** answers with Meta's envelope:

```json
{
	"error": {
		"message": "(#130429) Rate limit hit",
		"type": "OAuthException",
		"code": 130429,
		"error_data": { "messaging_product": "whatsapp", "details": "Cloud API message throughput has been reached." },
		"fbtrace_id": "A…"
	}
}
```

An unknown object ID is always `400` with `"code":100, "error_subcode":33`, never `404`. Apps
key "this media expired" and "this number is gone" on it.

**The control plane** has its own, plainer shape: `{"error":{"message":"…","code":"unknown_media"}}`,
where `code` is optional.

## Graph API

Every route is mounted under **any** `/v<major>.<minor>` prefix (`/v25.0`, `/v21.0`, …), on the
Graph port.

| Route                                                      | What it does                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /{id}`                                                | A phone number, WABA, template or media descriptor (media needs `?phone_number_id=`); honors `fields`                                                                 |
| `POST /{phone-number-id}/messages`                         | Send `text`, `template`, `image`, `video`, `audio`, `document`, `sticker`, `interactive`, `location`, `reaction`, `contacts`; to `to` (number) or `recipient` (BSUID) |
| `POST /{phone-number-id}/messages` with `status: "read"`   | Read receipt for an inbound message → `{"success":true}`; add `typing_indicator` to show typing                                                                       |
| `POST /{phone-number-id}/media`                            | Multipart upload → `{"id":"<digits>"}`, about 100 MiB at most                                                                                                         |
| `DELETE /{media-id}`                                       | Deletes the media and its bytes → `{"success":true}`                                                                                                                  |
| `POST /{app-id}/uploads`                                   | Opens a resumable upload → `{"id":"upload:<opaque>"}`                                                                                                                 |
| `POST /upload:{opaque}`                                    | Sends bytes at the `file_offset` header → `{"h":"<handle>"}` once complete                                                                                            |
| `GET /upload:{opaque}`                                     | `{"id":…,"file_offset":N}`: where an interrupted upload resumes                                                                                                       |
| `POST /{waba-id}/message_templates`                        | Creates a template, `PENDING`, then the approval flow                                                                                                                 |
| `GET /{waba-id}/message_templates`                         | `fields`, `limit`, `after`, `before`; filters `name`, `name_or_content`, `status`, `category`, `language`                                                             |
| `DELETE /{waba-id}/message_templates?name=&hsm_id=`        | Deletes every language of it                                                                                                                                          |
| `POST /{template-id}`                                      | Edits a template; back to `PENDING`                                                                                                                                   |
| `GET /{waba-id}/phone_numbers`                             | Lists numbers, with `paging`; honors `fields`                                                                                                                         |
| `POST /{waba-id}/phone_numbers`                            | Adds an unverified number; malformed `400`, digits already used `409`                                                                                                 |
| `POST /{phone-number-id}/request_code`                     | "Texts" a 6-digit code; it shows in the console, never in a Graph answer                                                                                              |
| `POST /{phone-number-id}/verify_code`                      | Confirms the code                                                                                                                                                     |
| `POST /{phone-number-id}/register`                         | `CONNECTED`: the number can send                                                                                                                                      |
| `POST /{phone-number-id}/deregister`                       | `DISCONNECTED`: sends answer `133010` until registered again                                                                                                          |
| `GET`, `POST /{phone-number-id}/whatsapp_business_profile` | Read or merge the business profile; an empty value clears a field                                                                                                     |
| `POST`, `GET`, `DELETE /{waba-id}/subscribed_apps`         | Subscribe an app to a WABA's webhooks, list, unsubscribe; with `override_callback_uri` + `verify_token`, a WABA override                                              |
| `POST /{phone-number-id}` with `webhook_configuration`     | A phone-number webhook override                                                                                                                                       |

Flows, calling, payments and billing are not simulated ([SPEC §9](SPEC.md#9-out-of-scope)).

## How the Graph API behaves

- **The version segment is required.** A base URL without one (`http://wasandbox:8888`) makes your
  client ask for `/573542517421694/messages`, which WaSandbox does not serve.
- **Only a `CONNECTED` number sends.** Seeded numbers, and numbers created in the console or
  through `/api`, start `CONNECTED`. A number added with `POST /{waba-id}/phone_numbers` must be
  verified, then registered (`register` on an unverified number is `133006`). A number that is not
  `CONNECTED`, for example after `deregister`, answers `133010` on every send.
- **Templates are checked on send** against the stored template, by name and language: wrong
  parameter count is `132000`; missing or not `APPROVED` is `132001`.
- **`biz_opaque_callback_data`** (up to 512 characters) is stored and returned on every status
  webhook of that message, never on the send answer.
- **Read receipts** mark the user's message read and send no webhook, as on Meta. A
  `typing_indicator` shows typing in the console until 25 seconds pass or the app sends again.
- **Media download takes two hops**: `GET /{media-id}?phone_number_id=…` returns a `url` built
  from `WASANDBOX_PUBLIC_URL`; fetching it returns the bytes, with `Range` → `206`, never a redirect.
- **Handles come from the Upload API.** A handle works as `profile_picture_handle` and in a
  template's `components[].example.header_handle[]`; an unknown handle is `(#100)`. A plain media
  ID also works as `profile_picture_handle`. `{app-id}` accepts WaSandbox's app ID or any digits.
- **BSUIDs.** A contact may have a business-scoped user ID (`BR.ENT.4KgQ2wJ8` or `US.4KgQ2wJ8`).
  Then webhooks carry `contacts[].user_id`, `messages[].from_user_id` and
  `statuses[].recipient_user_id`, next to `wa_id`. A send to `recipient: "<BSUID>"` goes to that
  contact and answers `{"contacts":[{"input":"<BSUID>","wa_id":"<number>"}]}`; an unknown BSUID is
  `400` / `100` / `33`.
- **Number changes.** When a contact changes number (console, or
  `POST /api/contacts/{waId}/change-number`), its `wa_id` changes in place with its history, and
  Meta's `user_changed_number` system webhook goes to every business number that talked to it.
  The new number is in both `wa_id` and `new_wa_id`, because Meta's webhook version decides which
  one it sends, so read `wa_id ?? new_wa_id`. Wamids stay the same, so replies to older messages
  keep working; the conversation ID (`<phoneNumberId>:<waId>`) changes.

## Media and upload bytes

| Route                        | Listener | Who can read it                                                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `GET /whaloc-media/{token}`  | both     | Whoever has the URL (the token is the credential). Public mode, console: a visitor only its own |
| `GET /whaloc-upload/{token}` | both     | Whoever has the URL. Public mode, console: the admin                                            |

Both honor `Range`. An expired or deleted object is a plain `404` here. Stored files that are not
images, audio, video or PDF are served as downloads (`Content-Disposition: attachment`) with a
sandbox CSP, in both modes.

## Control-plane API

On the console port, under `/api`. Who may call it: [Authentication](#the-console-listener).

### State, reset and snapshots

| Route                                | What it does                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `GET /health`, `GET /api/health`     | Liveness (also on the Graph port as `/health`)                                           |
| `GET /api/state`                     | WABAs, numbers (with any pending verification code), configured behavior, webhook target |
| `POST /api/reset`                    | Wipe everything, media included, and apply the seed again                                |
| `GET /api/export?include=deliveries` | The whole data as one JSON file, media bytes included                                    |
| `POST /api/import`                   | Replace everything with such a file: JSON body, or multipart `file`                      |

### Accounts, numbers and contacts

| Route                                                                       | What it does                                                          |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `GET`, `POST /api/wabas`; `PATCH`, `DELETE /api/wabas/{id}`                 | WABAs; `POST` may set `id`; a delete removes everything under it      |
| `GET`, `POST /api/phone-numbers`; `PATCH`, `DELETE /api/phone-numbers/{id}` | Numbers, `CONNECTED` from the start; `POST` may set `id`              |
| `POST /api/phone-numbers/{id}/quality`                                      | Quality and throughput, optionally with `phone_number_quality_update` |
| `POST /api/phone-numbers/{id}/business-profile`                             | The business profile (camelCase; a blank field clears it)             |
| `GET`, `POST /api/contacts`; `PATCH /api/contacts/{waId}`                   | Contacts, with role, display number and BSUID                         |
| `POST /api/contacts/{waId}/change-number`                                   | Move a contact to a new number; sends `user_changed_number`           |

### Conversations, the user side and media

| Route                                             | What it does                                                                                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/conversations?phoneNumberId=`           | One row per contact, with the last message                                                                                                                                       |
| `GET /api/conversations/{id}/messages`            | A conversation's messages, oldest first; `{id}` is `<phoneNumberId>:<waId>`                                                                                                      |
| `POST /api/inbound`                               | A user message: text, media, interactive and button replies, location, contacts, reaction, `unsupported`, with `referral`, `forwarded`, `frequentlyForwarded`, `referredProduct` |
| `POST /api/inbound-media`                         | Upload the file an inbound media message uses (multipart)                                                                                                                        |
| `POST /api/messages/{id}/status`                  | `{"status":"delivered"\|"read"\|"failed","errorCode"?}` on a business message                                                                                                    |
| `GET /api/message-error-presets`                  | The failure codes that accepts, with Meta's wording                                                                                                                              |
| `GET /api/typing?phoneNumberId=`                  | Typing indicators your app has up                                                                                                                                                |
| `GET /api/media/{id}`, `GET /api/uploads?handle=` | What a media ID or an upload handle points at (ignores media expiry)                                                                                                             |

### Templates

| Route                                                                       | What it does                                |
| --------------------------------------------------------------------------- | ------------------------------------------- |
| `GET /api/templates?status=&category=&language=&name=&search=`              | Templates with status and quality           |
| `POST /api/templates/{id}/approve`, `reject`, `pause`, `disable`, `quality` | Moderation; each sends its template webhook |

### Messaging rules, errors and tokens

| Route                                                                  | What it does                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /api/service-window?phoneNumberId=&waId=`                         | One contact's window                                      |
| `POST /api/service-window/expire`                                      | Close one contact's window now                            |
| `GET /api/messaging-rules`                                             | The rules in force and the messaging-limit count per WABA |
| `GET`, `POST /api/injection-rules`; `DELETE /api/injection-rules/{id}` | Error injection rules                                     |
| `GET /api/tokens`; `POST /api/tokens/{id}/expire`, `restore`           | The `WASANDBOX_TOKENS` registry, masked                      |

### Webhooks and apps

| Route                                                           | What it does                                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `GET /api/webhook-deliveries?limit=&before=`                    | The delivery log, newest first                                              |
| `POST /api/webhook-deliveries/{id}/redeliver`                   | Send a stored body again to the app's current URL, signed now (a new chain) |
| `POST /api/webhook-deliveries/{id}/cancel-retry`                | Stop that delivery's retries                                                |
| `POST /api/webhook/handshake`                                   | Run the `hub.challenge` handshake for the default app                       |
| `POST /api/webhook/raw`                                         | Send any JSON object, signed like a real event                              |
| `POST /api/webhook/account-update`                              | Send `account_update` (event only, no state change)                         |
| `POST /api/webhook/business-capability-update`                  | Send `business_capability_update` (event only)                              |
| `GET`, `POST /api/apps`; `PATCH`, `DELETE /api/apps/{key}`      | Apps; secrets are write-only; the default app is read-only                  |
| `PUT`, `DELETE /api/apps/{key}/subscriptions/{wabaId}`          | Subscribe an app to a WABA, with an optional WABA override                  |
| `PUT`, `DELETE /api/apps/{key}/phone-overrides/{phoneNumberId}` | An app's override for one number                                            |
| `POST /api/apps/{key}/handshake`                                | Check an app's URL with `hub.challenge`                                     |
| `GET /api/webhook-routes?wabaId=&phoneNumberId=&field=`         | Where an event would go now, and why                                        |

### Request log, clock and scenarios

| Route                                                          | What it does                                                                      |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /api/graph-requests?limit=&before=&phoneNumberId=`        | The Graph request log, newest first                                               |
| `GET /api/graph-requests/{id}`                                 | One entry in full (masked)                                                        |
| `GET /api/graph-requests/export`; `DELETE /api/graph-requests` | Download the log as JSON; clear it                                                |
| `GET /api/clock`                                               | Mode, now, start, pending events                                                  |
| `POST /api/clock/advance`, `set`, `run-next`                   | `{"by":"5m"}`, `{"to":"<ISO time>"}`, or the next event                           |
| `POST /api/scenarios/validate`, `run`                          | Check or run a scenario; `?format=junit` for JUnit XML. A run resets the instance |

## Phone, visitor and admin routes

These serve the virtual phone and public mode. Who may call each one in each mode is in the
[access rules](access.md).

| Route                                                                     | What it does                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `GET /phone`                                                              | The virtual phone page                                       |
| `GET /api/phone/config`                                                   | `{data:{mode}}`, always open                                 |
| `GET /api/phone/identities`                                               | The identities the phone can be                              |
| `GET /api/phone/clock`                                                    | The instance clock                                           |
| `GET /api/phone/identities/{waId}/chats`                                  | That identity's business chats                               |
| `GET`, `POST /api/phone/identities/{waId}/chats/{phoneNumberId}/messages` | Read or send messages                                        |
| `POST /api/phone/identities/{waId}/chats/{phoneNumberId}/read`            | Mark the chat read                                           |
| `POST /api/phone/identities/{waId}/chats/{phoneNumberId}/media`           | Upload a file (public mode: JPEG, PNG, WebP or PDF)          |
| `GET /api/phone/identities/{waId}/media/{mediaId}`                        | A media item the identity may see                            |
| `GET /api/phone/identities/{waId}/ws`                                     | WebSocket of that identity's own events                      |
| `GET`, `POST`, `DELETE /api/public/session`                               | Public mode: read, start or leave a visitor session          |
| `GET /api/public/stats`                                                   | Public mode, admin: live sessions, sockets, log rows, memory |
| `GET /admin`; `POST /api/admin/login`, `/api/admin/logout`                | Admin sign-in, when an admin token is set                    |

## WebSocket events

`GET /api/ws` streams JSON events `{type, payload}`:

`message.created`, `message.status_changed`, `typing.changed`, `template.changed`,
`webhook.delivery`, `contact.changed`, `waba.changed`, `phone_number.changed`,
`injection.changed`, `token.changed`, `webhook_routing.changed`, `clock.changed`,
`service_window.changed`, `graph_request.logged`, `state.reset`, `state.imported`.

Schemas: [`packages/shared/src/ws-events.ts`](../packages/shared/src/ws-events.ts). On shutdown,
sockets close with `1001`; a visitor socket closes with `4401` when its session ends.
