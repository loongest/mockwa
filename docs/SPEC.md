# mockwa — WhatsApp Cloud API simulator

mockwa is a fork of [whaloc](https://github.com/dgadelha/whaloc) (MIT). Where this document says "whaloc" it describes behavior mockwa keeps unchanged; mockwa's own changes are called out by name.

whaloc is a local emulator of the **Meta WhatsApp Cloud API (Graph API v25.0)**, distributed as a single Docker image, configured entirely through **environment variables**. It exists so that apps integrating with the WhatsApp Cloud API can run fully offline in docker-compose: the app points `GRAPH_API_BASE_URL` at whaloc, and whaloc plays Meta's side of the conversation, including delivering signed webhooks back to the app.

It ships three surfaces on **two ports** (mockwa; whaloc served all three on one), over one engine in one process:

| Port | Surface | Mount | Purpose |
|---|---|---|---|
| **8888** (`MOCKWA_GRAPH_PORT`) | Graph API mock | `/:version{v\d+\.\d+}/...` (any version, e.g. `/v25.0`) | The endpoints the app under test calls |
| **8025** (`MOCKWA_CONSOLE_PORT`) | Control-plane API + WebSocket | `/api/...`, `/api/ws` | What the web UI (and tests/scripts) use to inspect state and simulate the "user side" |
| **8025** | Web UI | `/` (static React bundle) | Chat-style UI to act as WhatsApp users, manage templates, inspect webhooks |
| **8025** | Virtual phone | `/phone` (second page of the bundle) | One WhatsApp user per tab, chatting with the app under test (§5, "Virtual phone") |

Each port answers **404** for the other's routes: nothing the console offers is reachable from the Graph port, and no Graph route is reachable from the console port (not even through the UI's SPA fallback). Both answer `GET /health`, and both serve the media byte endpoint (`/whaloc-media/{token}`): media URLs point at the Graph port (`MOCKWA_PUBLIC_URL`), and the UI loads the same bytes from its own origin to preview them. Those URLs carry an unguessable token and no bearer token, so the second mount exposes nothing new.

Design inspiration: [fdarian/whap](https://github.com/fdarian/whap), MIT (control-plane + UI-as-pure-client + WS event bus + HMAC approach), but web UI instead of TUI, Meta-faithful envelopes, deterministic behavior (no random failures), media support, and env-only configuration.

**Golden rule: deterministic by default.** Nothing fails or changes state randomly. Failures, rejections, and read receipts are triggered explicitly (UI/control-plane) or by documented configuration.

---

## 1. Consumer contract (fidelity requirements)

These are hard requirements, derived from the Meta adapters of a real production consumer of the Cloud API and from captured traffic between it and Meta. "The consumer" below is that class of client: an application that talks to the Graph API the way a production integration does. Violating any of these breaks such a consumer in subtle ways — usually not at the call that is wrong, but three hops later.

1. **Base URL includes the version**: the consumer sets `GRAPH_API_BASE_URL=http://mockwa:8888/v25.0` and appends `/{id}` paths to it. whaloc must accept **any** `/v\d+\.\d+` prefix (mount the same router for all).
2. **wamids** are opaque non-empty strings; generate Meta-shaped ones: `wamid.` + base64 (e.g. `wamid.HBgN...==`). Never reuse; unique per message.
3. **Media IDs must be digit-only strings, max 32 chars** (consumer validates `/^\d{1,32}$/` before calling). Template IDs should also be numeric strings (Meta emits them as JSON **numbers** in webhooks — stay ≤ 2^53).
4. **Error envelope** is Meta's, always:
   ```json
   {"error":{"message":"(#132000) ...","type":"OAuthException","code":132000,"error_subcode":33,"error_data":{"messaging_product":"whatsapp","details":"..."},"fbtrace_id":"A..."}}
   ```
   (`error_subcode`/`error_data` only when applicable; always include `fbtrace_id`, generated.)
   **Unknown object ID → HTTP 400 with `code:100, error_subcode:33`** ("object missing"), *not* 404. The consumer keys expired-media and deregistered-phone detection on exactly this.
5. **Pagination** (`GET /{wabaId}/message_templates`): return `paging.cursors.{before,after}` always; include `paging.next` **only when another page actually follows** — the consumer stops paging when `next` is absent. `paging.previous` is the mirror image (present only when a page precedes this one) and is what a `before` cursor is read off; a page is always served oldest first, whichever cursor asked for it.
6. **Send response** shape:
   ```json
   {"messaging_product":"whatsapp","contacts":[{"input":"<to>","wa_id":"<waid>"}],"messages":[{"id":"wamid...","message_status":"accepted"}]}
   ```
   `messages` must be non-empty; consumer reads only `messages[0].id`.
7. **Media download is two hops**: `GET /{media-id}?phone_number_id=...` → `{url, mime_type, sha256, file_size}`; then the consumer GETs that `url` directly (any host) with `Authorization: Bearer`, `Accept-Encoding: identity`, optional `Range`. The byte endpoint must support **Range** (206 + `Content-Range`), set `Content-Type`/`Content-Length`, and **never redirect** (3xx is treated as an error by the consumer). Build the `url` from `MOCKWA_PUBLIC_URL` so it is reachable from other containers.
8. **Media upload** is streamed multipart with an injected first part `messaging_product=whatsapp`, then the consumer's parts `file` (binary) and `type` (mime string). `Content-Length` may be present or chunked. Respond `{"id":"<digits>"}`.
9. **Auth**: accept any non-empty `Bearer` token (consumer stores per-WABA tokens; never validates content). Missing/empty Authorization on Graph routes → 401 with `code:190` OAuthException envelope. **Strict mode** (`MOCKWA_TOKENS`, §4): with a registry configured, only the listed tokens pass — an unregistered one is the *same* 401/190 envelope, and one marked expired through the control plane is 401 / 190 / **subcode 463** with no `error_data`. The byte endpoint stays outside the gate (§2.12).
10. **Timeouts**: consumer aborts JSON calls at 10 s. Don't add artificial latency by default.
11. **Rate-limit / throttling headers** the consumer parses when present: `Retry-After` (delta-seconds or HTTP-date) and `X-Business-Use-Case-Usage` (JSON; `estimated_time_to_regain_access` in minutes). Also log-only: `x-fb-request-id`. Emitted on injected 429s (§4, "Error simulation"); not needed on happy path.
12. **Webhook signature**: every webhook POST carries `X-Hub-Signature-256: sha256=<HMAC-SHA256(rawBody, MOCKWA_APP_SECRET)>`, where **the HMAC input is byte-identical to the body actually sent**. Meta escapes every code point > U+007F as `\uXXXX` in the JSON it signs — reproduce that (serialize once with the escaping, use the same string/buffer for both body and HMAC). Port the approach (and test vectors) from whap's `src/server/middleware/hmac-signature.ts`, replacing `Bun.CryptoHasher` with `node:crypto`.
13. **Webhook handshake**: the consumer's receiver implements `GET /meta-webhooks?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` → echoes challenge. whaloc must be able to *initiate* this handshake (on demand from UI/control-plane, and optionally at startup) using `MOCKWA_WEBHOOK_VERIFY_TOKEN`, and report the result.
14. **Status webhook timestamps** are strings of unix **seconds**. Inbound message timestamps likewise.
15. `POST /{phoneNumberId}/messages` may address the recipient via `to` (MSISDN, digits) **or** `recipient` (business-scoped user ID — **BSUID** — `^[A-Z]{2}\.(ENT\.)?[0-9A-Za-z]{1,128}$`). Contacts are modeled primarily by `wa_id` and may *also* carry a BSUID (`contacts.user_id`, unique when set, never seeded). A `recipient` that matches the pattern is **resolved** to the contact that owns it — the answer echoes `contacts:[{input:<bsuid>, wa_id:<contact wa_id>}]` — and an unknown BSUID is the missing-object envelope (§1.4), because a BSUID says nothing about a phone number and inventing a contact for one produces a conversation nothing can reach. A `recipient` that is not BSUID-shaped is treated exactly like a `to`. A contact with a BSUID also carries it through the webhooks: `contacts[].user_id` and `messages[].from_user_id` on inbound events, `statuses[].recipient_user_id` on statuses — always *alongside* `wa_id`/`from`/`recipient_id`, and always absent for a contact that has none.

### Response samples (from production traffic)

Send success (HTTP 200) — the frame of a captured response, re-minted over a synthetic number so no real one is published:

```json
{"messaging_product":"whatsapp","contacts":[{"input":"5511912345678","wa_id":"5511912345678"}],"messages":[{"id":"wamid.HBgNNTUxMTkxMjM0NTY3OBUCABEYEjYzNEQzNzJFQjhDMkNENzU5OQA=","message_status":"accepted"}]}
```

Template param mismatch (HTTP 400):

```json
{"error":{"message":"(#132000) Number of parameters does not match the expected number of params","code":132000,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"body: number of localizable_params (1) does not match the expected number of params (3)"},"fbtrace_id":"AOnodi98JaYHcSTvVvrOtJs"}}
```

Media header sent without its media (HTTP 400) — an `IMAGE`-header template sent with only its body parameters; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#132012) Parameter format does not match format in the created template","code":132012,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"header: Format mismatch, expected IMAGE, received UNKNOWN"},"fbtrace_id":"AQj9NsyVOz1rboSgaFw5lDA"}}
```

Media parameter that names its type without the object (HTTP 400) — `{"type":"image"}` alone as an `IMAGE` header's parameter; no `error_subcode`, `fbtrace_id` re-minted:

```json
{"error":{"message":"(#100) Invalid parameter","code":100,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"Parameter 'image' is mandatory for component parameter type 'image'"},"fbtrace_id":"AR7qZ0nL3xkW9cVtQm2pD1f"}}
```

Media object with neither `id` nor `link` (HTTP 400) — `{"type":"image","image":{}}`; the message's apostrophe is Meta's typographic one, `fbtrace_id` re-minted:

```json
{"error":{"message":"(#132018) There’s an issue with the parameters in your template","code":132018,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"Either one of media ID or link must be present"},"fbtrace_id":"AXk2mPq8rT4vLw9nB3cZs0e"}}
```

Dynamic URL button sent without its parameter (HTTP 400) — no `button` component for a `https://…/{{1}}` button at index 0; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#131008) Required parameter is missing","code":131008,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"buttons: Button at index 0 of type Url requires a parameter"},"fbtrace_id":"AJ5tWc7yNq2kHs8fRd1mV6x"}}
```

Button component of the wrong `sub_type` at a URL button's index (HTTP 400) — `{"type":"button","sub_type":"quick_reply","index":"0",…}`; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#132018) There’s an issue with the parameters in your template","code":132018,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"buttons: Button at index 0 must be of type Url"},"fbtrace_id":"AL8rQx3vHk6nZp1cTf9wJ2s"}}
```

Parameter object missing required fields (HTTP 400) — `{"type":"location","location":{}}` on a `LOCATION` header; Meta's request-schema check, one sentence per missing field and **no `error_data`**, `fbtrace_id` re-minted. `currency: {}` (missing `fallback_value`, `code`, `amount_1000`) and `date_time: {}` (missing `fallback_value`) answer the same way:

```json
{"error":{"message":"Your request has violated JSON schema constraint 'required' for the JSON field 'template.components.0.parameters.0.location', please check the JSON schema for the JSON field 'template.components.0.parameters.0.location' and make sure your request is valid for missing : 'longitude', Your request has violated JSON schema constraint 'required' for the JSON field 'template.components.0.parameters.0.location', please check the JSON schema for the JSON field 'template.components.0.parameters.0.location' and make sure your request is valid for missing : 'latitude'","code":100,"type":"OAuthException","fbtrace_id":"AP4hLw6mXq9sNd2vRb7tKc1"}}
```

URL button suffix with no text (HTTP 400) — `{"type":"text"}` as a dynamic URL button's parameter; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#100) Invalid parameter","code":100,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"button: Parameter 'text' is mandatory for component parameter type 'text' and cannot be empty"},"fbtrace_id":"AQ2mVy8cRn5tLp3xHw6kBd9"}}
```

Body text parameter with no text (HTTP 400) — `{"type":"text"}` in the body; unlike the button's, the `details` names no component; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#100) Invalid parameter","code":100,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"Parameter 'text' is mandatory for component parameter type 'text'"},"fbtrace_id":"AK3nRt7wYq1mPs9vLc4hXd2"}}
```

NAMED template, parameters without `parameter_name` (HTTP 400) — the right count, no names; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#100) Invalid parameter","code":100,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"Parameter name is missing or empty"},"fbtrace_id":"AT6pWk2zNr8dLx5mQv1cHb4"}}
```

NAMED template, a declared placeholder no parameter names (HTTP 400) — the right count, but `customer_name` twice (or `customer_name` plus an undeclared `client`) for `{{customer_name}}` and `{{order_id}}`; `fbtrace_id` re-minted:

```json
{"error":{"message":"(#100) Invalid parameter","code":100,"type":"OAuthException","error_data":{"messaging_product":"whatsapp","details":"Parameter name is missing for the parameter '{{order_id}}'"},"fbtrace_id":"AW9cMt4xLp7nRq2sVh6kZd3"}}
```

### Canonical webhook payload fixtures

`docs/fixtures/webhooks/*.json` holds verbatim v25.0 webhook payloads captured from Meta's webhook references: inbound text, inbound image, status `sent` (with `conversation` + `pricing`), status `failed` (error 131049 with `href`), `message_template_status_update` APPROVED and REJECTED (with `rejection_info`), `message_template_quality_update`, `phone_number_quality_update`. whaloc's webhook builders must produce payloads structurally identical to these.

Six more are Meta's **documented samples** rather than captured traffic, and say so here: `system-user-changed-number.json` (see below), `referral-message.json` (a click-to-WhatsApp inbound, §5), `unsupported-message.json` (a message type this version cannot represent, §5), `account-update.json` and `account-restriction.json` (§3), and `business-capability-update.json` (§3).

Notable fixture facts:
- Envelope: `{object:"whatsapp_business_account", entry:[{id:"<wabaId>", time?, changes:[{value, field}]}]}`.
- Inbound `value`: `messaging_product`, `metadata:{display_phone_number (digits, no +), phone_number_id}`, `contacts:[{profile:{name}, wa_id}]`, `messages:[...]`.
- Inbound media node is named after the type: `{type:"image", image:{id, mime_type, sha256, url, caption?}}`. `url` is the byte URL the descriptor hop would hand out, so Meta's two download paths (fetch the node's `url`, or resolve the id first) land on the same place. An `audio` node always carries `voice` and a `sticker` node always carries `animated`, both booleans, because Meta puts them on every node of their type — and on no other type.
- **`sha256` is base64**, like Meta's (`SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI=`), not hex: it appears in the webhook node, the descriptor hop and the control plane's inspector, and a consumer that decodes it to compare against its own hash of the downloaded bytes has to get 32 bytes back. The encoding is decided once, at the `MediaStorage` boundary (§6).
- Status value: `statuses:[{id, status, timestamp, recipient_id, conversation?:{id, expiration_timestamp?, origin:{type}}, pricing?:{billable, pricing_model:"PMP", type:"regular", category}, biz_opaque_callback_data?, errors?:[{code, title, message, error_data:{details}, href}]}]`.
- Context riders (§5) on an inbound message: `referral` rides **top-level**, `forwarded` / `frequently_forwarded` / `referred_product` ride **inside `context`** — merged with the `{from, id}` quote a reply produces, because Meta sends a forwarded reply as one `context` holding both halves. An `unsupported` message has no type node at all: `type:"unsupported"` plus an `errors[]` entry is the whole message.
- Template status update `value`: `{event:"APPROVED"|"REJECTED"|"PENDING"|"DELETED"|..., message_template_id:<number>, message_template_name, message_template_language, reason:"NONE"|..., message_template_category, disable_info?:{disable_date}, other_info?:{title, description}, rejection_info?:{reason, recommendation}}`. `other_info` rides on the transitions that **lock** a template — a pause (`title:"FIRST_PAUSE"`) and a disable (`title:"DISABLED"`) — and `disable_info.disable_date` (a string of Unix seconds) rides on the disable alone. A `DELETED` event reports **`reason: null`**, not the `"NONE"` string every other transition sends: Meta is explicit that a template scheduled for deletion changes that field's type.
- Template quality update `value`: `{previous_quality_score, new_quality_score, message_template_id:<number>, message_template_name, message_template_language}`.
- Phone quality update `value`: `{display_phone_number, event:"THROUGHPUT_UPGRADE"|..., old_limit?, current_limit, max_daily_conversations_per_business}`. `old_limit` appears only when the tier actually moved, which is what Meta says about it. `max_daily_conversations_per_business` carries the same tier as `current_limit` and is sent always: Meta removes `current_limit` in February 2026 and replaces it with this field, so sending both means a consumer written against either spelling keeps working across the cutover.
- System event (`system-user-changed-number.json`): a `messages` change whose message is `{from:<old wa_id>, id, timestamp, type:"system", system:{body, wa_id, new_wa_id, type:"user_changed_number"}}`. **There is no `contacts[]` array** — Meta's system-messages reference is explicit that "unlike other incoming messages webhooks, system **messages** webhooks don't include a `contacts` array", so the new `wa_id` is only in `system`, which is where a consumer has to read it. (whaloc sent one until the conformance audit; an app that keyed off it would have passed here and failed against Meta.) The new number appears under both spellings on purpose — Meta's webhook version decides which one it sends (`new_wa_id` on the older payloads, `wa_id` on the current ones) and the consumer reads `system.wa_id ?? system.new_wa_id`. `body` is Meta's own wording, `User ` prefix included.
- The BSUID keys (`contacts[].user_id`, `messages[].from_user_id`, `statuses[].recipient_user_id`) are **absent** from every captured fixture, because they came from contacts without one. They are additive: the payload of a contact that has a BSUID is its fixture plus exactly those keys, which is what the builder specs assert.

### Meta OpenAPI references

The v25.0 OpenAPI specs are vendored under `docs/meta-openapi/`. They define: `POST /{Phone-Number-ID}/messages`, `GET|POST /{WABA-ID}/message_templates` (+ `DELETE` with `name`/`hsm_id` query), `GET|POST /{TEMPLATE_ID}`, `GET /{WhatsApp-Account-Number-ID}`, `GET|POST /{WABA-ID}`, `GET /{WABA-ID}/phone_numbers`, media download. Use them to shape request validation, but the consumer contract above wins any conflict.

---

## 2. Graph API mock — MVP endpoint behavior

All routes live under `/:version{v\d+\.\d+}`. IDs are looked up across entity stores; the same `GET /:id` path serves phone numbers, WABAs, media, and templates — **dispatch by which store contains the ID**. Unknown ID → 400 `code:100, error_subcode:33`.

| # | Route | Behavior |
|---|---|---|
| 1 | `GET /:id` where `id` = phone number | Honor `fields` (default all): `verified_name`, `display_phone_number` (formatted, e.g. `+55 11 91234-5678` — non-blank!), `quality_rating` (`GREEN\|YELLOW\|RED\|UNKNOWN`), `throughput:{level:"STANDARD"\|"HIGH"}`, `status`, `code_verification_status`, `name_status`, `id` |
| 2 | `GET /:id` where `id` = WABA | `fields=id` → `{id}`; also support `name` |
| 3 | `GET /:id` where `id` = media (`?phone_number_id=` present) | `{url:"<MOCKWA_PUBLIC_URL>/whaloc-media/<opaque token>", mime_type, sha256, file_size, id, messaging_product:"whatsapp"}` |
| 4 | `GET /:id` where `id` = template | `id, name, language, status, category, components` (honor `fields`) |
| 5 | `POST /:phoneNumberId/messages` | Validate envelope (zod), resolve the recipient (§1.15: `to`, or `recipient` for a BSUID), store message, respond per §1.6, schedule status ladder (§4). Message `type`: `text`, `template`, `image`, `video`, `audio`, `document`, `sticker`, `interactive`, `location`, `reaction`, `contacts`. **`biz_opaque_callback_data`** is an optional string the caller attaches to the send: stored on the message row, **never** echoed on the send response, and reported as `statuses[].biz_opaque_callback_data` on **every** status webhook that message produces — `sent`, `delivered`, `read`, `failed`, whether the ladder or a manual transition raised it. Meta caps it at 512 characters; so does whaloc, with the `(#100)` envelope. A `template` send also stores the **definition it was validated against** (`parameter_format` + `components`, as they stood at send time) on the message row: the send only names the template and fills its placeholders, so this is what lets the UI render what was delivered after the template is edited or deleted. It is served on the control-plane message only (`templateSnapshot`, §5) — never on the send response, never in a webhook. **`context`** marks a reply (`{message_id}`, stored as the message's `replyTo`); `"context": null` means "not a reply", as it does on Meta |
| 6 | `POST /:phoneNumberId/media` | Parse multipart (`messaging_product`, `file`, `type`), persist via storage adapter, respond `{id}`. Enforce ~100 MiB cap |
| 6b | `DELETE /:mediaId` (optional `?phone_number_id=`) | → `{success:true}`; the row goes and the bytes go with it through `MediaStorage`. Afterwards the descriptor hop answers the missing-object envelope (§1.4) and the byte URL 404s like an unknown token, which is how a consumer's "this media is gone" path is rehearsed without waiting out `MOCKWA_MEDIA_TTL_SECONDS`. Scoped exactly like the descriptor hop: another number's object — or one already past the TTL, or an ID that is not media at all — is 400 / 100 / 33 and stays put |
| 7 | `POST /:wabaId/message_templates` | Validate `{name, language, category, components, parameter_format?}`; duplicate (name+language) → 400 error envelope; else create with `status:"PENDING"`, respond `{id, status, category}`; kick off approval flow (§4). A media header's `components[].example.header_handle[]` is **resolved** against the Upload API (§2.21) — a handle no completed session owns is `(#100)` rather than a template whose header points at nothing — and the components are stored **verbatim**, so the association is just the handle plus its `upload_sessions` row. The edit (row 9) checks the same thing |
| 8 | `GET /:wabaId/message_templates` | Honor `fields`, `limit`, `after`, `before`. Cursor pagination per §1.5: `paging.next` only when a page follows, `paging.previous` only when one precedes, both carrying the caller's own `fields` and filters. Meta's filters, all optional and all combinable: `name` (exact), `name_or_content` (substring), `status`, `category`, `language`. A value outside an enum is `(#100)` rather than an empty page. **Divergence**: `name_or_content` matches the name or the *serialized* `components` column, so a search for a component keyword (`BODY`) matches broadly — it keeps the search in SQL, which is what keeps the keyset cursors correct under a filter |
| 9 | `POST /:templateId` | Edit: accept `{components}` (also `category`), set status back to `PENDING`, respond `{success:true}`, re-run approval flow |
| 10 | `DELETE /:wabaId/message_templates?name=&hsm_id=` | Delete all languages matching; respond `{success:true}`; unknown → HTTP **404** error envelope (consumer treats 404 as idempotent success) |
| 11 | `GET /:wabaId/phone_numbers` | List `{data:[<the row-1 node>], paging}`, honoring `fields` |
| 12 | `GET /whaloc-media/:token` (no version prefix) | Byte serving per §1.7 (Range, no redirects, correct headers) |
| 13 | `POST /:wabaId/phone_numbers` | `{phone_number:^[1-9][0-9]{6,14}$, verified_name:2..75, cc?, migrate_phone_number?, preverified_id?}` → `{id}` (digits). Starts `UNVERIFIED`/`NOT_VERIFIED`, `quality_rating:"UNKNOWN"`. Malformed number → 400 code 100 `Invalid parameter: phone_number must be in E.164 format`; digits already used by **any** WABA's number → **409** code 100 `Phone number is already registered with WhatsApp Business` (`GraphMethodException`). Unknown WABA keeps whaloc's uniform 400/100/33 (§1.4) rather than the vendored spec's 404/803 |
| 14 | `POST /:phoneNumberId/request_code` | `{code_method:"SMS"\|"VOICE", language}` → `{success:true}`. Derives the 6-digit code from the ID (stable, never expires) and stores it; the code is **only** readable through the control plane — whaloc is the phone |
| 15 | `POST /:phoneNumberId/verify_code` | `{code}`; match → `code_verification_status:"VERIFIED"` (and `UNVERIFIED` → `PENDING`), clearing the pending code. Mismatch or nothing pending → 400 `(#100) Invalid parameter` with the reason in `error_data.details` |
| 16 | `POST /:phoneNumberId/register` | `{messaging_product:"whatsapp", pin?}` → `{success:true}`, `status:"CONNECTED"`, `name_status:"APPROVED"`. An unverified number → 400 code `133006` |
| 17 | `POST /:phoneNumberId/deregister` | → `{success:true}`, `status:"DISCONNECTED"` (the closest of the spec's statuses); stays verified, so registering again is one call |
| 18 | `POST /:phoneNumberId/messages` with `{status:"read", message_id}` | The **read receipt** Meta overloads the send path with (`MarkMessageRequestPayload` in messages.yaml): `status:"read"` is the discriminator, the answer is `{success:true}`, and the named **inbound** message moves to `read`. Unknown wamid — or one belonging to another number — is the missing-object envelope (§1.4); an *outbound* wamid is `(#100) Invalid parameter` saying so; a number that is not `CONNECTED` is `133010` like a send. Idempotent, and **no webhook**: Meta reports statuses for outbound messages only. Adding `typing_indicator:{type:"text"}` marks the message read *and* raises a typing indicator for that conversation (§4) |
| 19 | `GET\|POST /:phoneNumberId/whatsapp_business_profile` | **GET**: `{data:[{messaging_product:"whatsapp", about?, address?, description?, email?, profile_picture_url?, websites?, vertical?}]}`, honoring `fields` (`messaging_product` always rides along). An unset field is **absent**, which is what an empty profile looks like: `{data:[{messaging_product:"whatsapp"}]}` | **POST**: `{messaging_product:"whatsapp", ...fields}` → `{success:true}`. **Merge**: only the fields present change, and an empty string (or empty array) clears one. Limits are Meta's — `about` ≤ 139, `address` ≤ 256, `description` ≤ 512, `email` ≤ 128, at most 2 `websites` of ≤ 256, `vertical` from Meta's enum. `profile_picture_handle` takes an **upload handle** (§2.21, Meta's own currency here) **or** a whaloc media ID, and sets `profile_picture_url` to that object's byte URL; a handle is not scoped to a number (an upload session belongs to the app), a media ID still is, and a value that resolves to neither is `(#100)` rather than a silent no-op. The media ID is kept alongside the handle on purpose: it is one call instead of three, and it is what whaloc's own docs, UI and scripts have always used. Stored as a JSON column on `phone_numbers`, **not** seedable — `MOCKWA_SEED` stays a description of numbers and templates, and a fresh number's profile is empty |
| 20 | `POST\|GET\|DELETE /:wabaId/subscribed_apps`, `POST /:phoneNumberId` with `webhook_configuration`, `GET /:phoneNumberId?fields=webhook_configuration` | The app a call acts on is the one its **access token** belongs to: a registered app (§3, "Apps and routing") whose `accessToken` matches, otherwise the default app. `POST` → `{success:true}`; with `override_callback_uri` + `verify_token` (both required together, the URL at most 200 characters, read from a JSON body, a form body or the query string) it sets that app's **WABA override**, and a bare `POST` removes it, as Meta's reference describes. `GET` → `{data:[{whatsapp_business_api_data:{id, name, link}, override_callback_uri?}]}` — one entry per *registered or explicitly subscribed* app, `{data:[]}` when there is none; `DELETE` → `{success:true}`, idempotent. `POST /{phoneNumberId}` with `webhook_configuration:{override_callback_uri, verify_token}` sets the calling app's **phone-number override**; an empty `override_callback_uri` removes it. `GET /{phoneNumberId}?fields=webhook_configuration` → `{webhook_configuration:{phone_number?, whatsapp_business_account?, application?}, id}`, each key present only when that level is set. The default app's ID is `MOCKWA_APP_ID` or derived deterministically, its name `whaloc`, its `link` is `MOCKWA_PUBLIC_URL`. **Divergences**: (1) the default app keeps receiving a WABA's webhooks while **no registered app** is subscribed to it, subscribed or not — a single-URL setup must not go silent after a `DELETE`, because that would be a support question rather than a feature; once a registered app subscribes, the default app receives only if it subscribed too, which is Meta's rule. (2) Setting an override does not call the URL: Meta does not document a verification at that moment, so mockwa does not invent a failure for it; `POST /api/apps/:key/handshake` checks any URL on demand. The default app's subscription stays in `wabas.subscribed_at` and is reported in `GET /api/state`; registered apps' subscriptions and every override live in `webhook_subscriptions` and `phone_number_webhook_overrides` (§6) |
| 21 | **Resumable Upload API**: `POST /:appId/uploads`, `POST /upload:<opaque>`, `GET /upload:<opaque>` | Where a real `header_handle` comes from. `POST /{appId}/uploads?file_length=&file_type=&file_name=` opens a session → `{"id":"upload:<opaque>"}` (the parameters are read from the query string *or* the body, because Meta documents one and its SDKs send the other). `POST /upload:<opaque>` with `file_offset: 0` (header, or query) and the raw bytes as the body stores them and answers `{"h":"<handle>"}`. `GET /upload:<opaque>` answers `{"id":"upload:<opaque>","file_offset":<received bytes>}` — **truthful**, so a client that lost its connection knows where to resume; a chunk that does not land exactly on the current offset is `(#100)` rather than a silent overwrite, and more bytes than `file_length` promised is refused. `:appId` accepts whaloc's own app ID (§2.20) **or any digit-only ID** — an app under test is configured with a `META_APP_ID` that has no reason to equal `MOCKWA_APP_ID`, and whaloc has one app either way; anything that is not an ID at all is `(#100)`. Handles are opaque, Meta-shaped — `4:<base64 file_name>:<base64 mime>:ARZ…`, both segments in standard padded base64 as a captured Meta handle has them (`4:b2ZmaWNlLmpwZw==:aW1hZ2UvanBlZw==:…` for `office.jpg`), the name segment empty for a session that named no file (`4::aW1hZ2UvcG5n:ARZ…`, as in Meta's docs) — and usable wherever Meta uses one: `profile_picture_handle` (§2.19) and a template's `components[].example.header_handle[]` (§2.7). Sessions and their handles live in `upload_sessions`, so a handle survives a restart with a file database; the path segment carries a literal colon, which the router matches as one segment ahead of the template edit's `POST /{id}`. **Simplification**: a chunk that is not the whole file is stored by reading what is there, concatenating and putting it back under the same key — O(n²) in chunks, fine at these sizes, and it means a partial upload survives a restart too |
| 22 | `GET /whaloc-upload/:token` (no version prefix) | The bytes behind a completed handle, with the same `Range` / no-redirect rules as §2.12. Its own token space, because a handle is not a media ID and is not scoped to a phone number. Unknown or still-incomplete → plain 404. **Divergence**: the `media.download` injection target (§4) names `/whaloc-media/{token}` only; this route is reachable through `graph.all` |

Template **send** validation: when a `template` message references a known template, validate the parameters against its components — `parameter_format:"NAMED"` templates take `parameters:[{type:"text", parameter_name, text}]`; positional take `{{1}}`-style. A placeholder is filled by any **localizable** parameter — `text`, `currency` or `date_time`, which is what Meta's `details` counts as `localizable_params` — while a media header's parameter counts toward nothing. Every answer below is captured from Meta (samples in §1) unless it says otherwise, and the checks run **in this order**, so a send breaking several rules gets the first one's error:

1. **Existence.** A template whose status ≠ APPROVED, or an unknown name or language → 132001 (template not found/not approved).
2. **Parameter objects and body text**, over every component. A `currency`, `date_time` or `location` parameter without its object is the `(#100)` `Parameter 'currency' is mandatory for component parameter type 'currency'`; an object missing required fields (`fallback_value`, `code`, `amount_1000` for currency; `fallback_value` for date_time; `longitude`, `latitude` for location, whose `name`/`address` are optional) is the request-schema error, naming the object by its position in the send and carrying no `error_data`. A body `text` parameter without `text` is the `(#100)` `Parameter 'text' is mandatory for component parameter type 'text'` — ahead of the counts: one such parameter against a two-placeholder body gets it, not the 132000.
3. **Media header** (`IMAGE`, `VIDEO`, `DOCUMENT`, `LOCATION`). A parameter whose `type` names media it does not carry (`{type:"image"}` with no `image`) is the `(#100)` `Parameter 'image' is mandatory…` — ahead of the format: `{type:"video"}` alone on an `IMAGE` header gets it, not a 132012. An `image`/`video`/`document` object naming neither `id` nor `link` is 132018 `Either one of media ID or link must be present` (its place relative to the format check is inferred). Then the header parameter's type must match: none is 132012 `received UNKNOWN`, the wrong one names it (`received VIDEO`, `received TEXT`).
4. **Counts**, per component, header then body, positional and NAMED alike → the 132000 of §1.
5. **Names** (NAMED only, counts equal), each a `(#100)` naming no component: a parameter without a `parameter_name` (or with an empty one) is `Parameter name is missing or empty`; otherwise the first declared placeholder no parameter names is `Parameter name is missing for the parameter '{{order_id}}'`. A name the template does not declare is never reported itself — with the counts equal, it always leaves a declared one unnamed.
6. **URL buttons** whose `url` carries a placeholder take their suffix from a `button` component with `sub_type:"url"` and that button's `index` (a string or a number). A component at that index naming another `sub_type` is 132018 `buttons: Button at index 0 must be of type Url`; one that names no `sub_type` is accepted, since only the mismatch was captured. No component, or one with no parameters, is 131008 `buttons: Button at index 0 of type Url requires a parameter`. A suffix of `type:"text"` without `text` is the `(#100)` `button: Parameter 'text' is mandatory for component parameter type 'text' and cannot be empty`; an empty string is treated the same, as that message says (inferred).

Message sends where the recipient equals nothing known: auto-create the contact (default profile name = the MSISDN) so the conversation shows up in the UI. **Except a BSUID** (§1.15): an unresolvable `recipient` is 400 / 100 / 33, since there is no number to create a contact under.

---

## 3. Webhook emission engine

A single **WebhookEmitter** service owns all outbound deliveries:

- Serializes payload **once** with Meta's `\uXXXX` escaping, then sends a copy to every app the event routes to (below), each **signed with that app's own App Secret** over those exact bytes (§1.12); POSTs with `Content-Type: application/json`, `User-Agent: facebookexternalua`. An app without a secret gets unsigned deliveries; an app without a URL gets a **skipped** row in the log, never silence.
- **Delivery log**: every attempt is persisted — payload, headers, target URL, the app it went to, response status/body (truncated), duration, error, and when the next retry is due — and browsable in the UI. This is a first-class feature.
- **Retries, Meta's rule**: only an HTTP **`200`** is a success. Anything else — a `5xx`, a `4xx`, a `204`, a network error, a timeout — is retried "with decreasing frequency" for up to **7 days**, as Meta documents. The schedule is `MOCKWA_WEBHOOK_RETRY_SCHEDULE` (default `10s,30s,1m,5m,15m,1h,3h,6h,12h,24h`, the last step repeating) and the age limit `MOCKWA_WEBHOOK_RETRY_MAX_AGE` (default `7d`): a retry that would fall past the limit is not scheduled, and the chain is reported as `failed`. A retry re-sends the **stored** URL, headers and body — the same bytes and the same signature, which is what lets a receiver deduplicate — and each attempt is a new row, linked by `chainId`, with `attempt` counting up. Duplicates are possible, as on Meta.
- **Persistent retry queue**: a pending retry is the `next_attempt_at` of its newest row, in SQLite. One timer (the injectable scheduler) points at the earliest one; a row is **claimed** (its `next_attempt_at` cleared) before it is sent, so it can never go out twice. At boot, after a reset and after an import the queue is read back and the timer re-armed, so with a file database **a pending retry survives a container restart** and goes out when it is due (late, if the container was down at the time). An import **cancels** the snapshot's pending retries — a snapshot is a picture, not a queue — and deleting an app cancels its own. `POST /api/webhook-deliveries/:id/cancel-retry` cancels one chain. `redeliver` re-routes, re-signs and starts a **new** chain, because its purpose is to send to the app's *current* URL.
- Handshake action (§1.13): `GET <callback URL>?hub.mode=subscribe&hub.verify_token=...&hub.challenge=<random>` and verify the echo; expose result via control-plane; optionally run at startup for the default app (`MOCKWA_VERIFY_ON_START=true`). Any app can be checked on demand, against its own URL and Verify Token or an override's.
- Events emitted: inbound messages (all types, including `unsupported` and the context riders of §5), statuses (`sent`/`delivered`/`read`/`failed`), the `user_changed_number` **system** event (§5), `message_template_status_update` (APPROVED/REJECTED/DELETED/PENDING transitions), `message_template_quality_update`, `phone_number_quality_update` (all three quality/template events UI-triggered), the two **account-level** notices below, plus a **raw webhook** escape hatch (arbitrary JSON body from the UI, still signed).
- **`account_update`** — field `"account_update"`, value `{phone_number?, event, restriction_info?}`, `entry.id` = the chosen WABA, `entry.time` set. Events: `VERIFIED_ACCOUNT`, `DISABLED_UPDATE`, `ACCOUNT_RESTRICTION`, `ACCOUNT_DELETED`, `ACCOUNT_VIOLATION`; `restriction_info` is `[{restriction_type: "RESTRICTED_ADD_PHONE_NUMBER_ACTION"|"RESTRICTED_BIZ_INITIATED_MESSAGING"|"RESTRICTED_CUSTOMER_INITIATED_MESSAGING", expiration?}]` and rides only on `ACCOUNT_RESTRICTION`. `phone_number` (bare digits) appears only when a number was named.
- **`business_capability_update`** — field `"business_capability_update"`, value `{max_daily_conversation_per_phone, max_phone_numbers_per_business}` as JSON numbers.
- **Both account-level events are emissions and nothing else**: no whaloc state changes when one goes out. There is no "restricted" flag behind `ACCOUNT_RESTRICTION` and no quota behind the capability numbers, because what a consumer has to get right is its *handler* — and inventing state Meta would then contradict (a whaloc that refused to send while "restricted" is a whaloc that lies about why) would cost more than it buys. Every other webhook whaloc sends describes something it actually did; these two describe something Meta decided.

### Apps and routing

mockwa plays **several apps** at once, the way one WhatsApp Business Account can be wired to several Meta apps:

- The **default app** is the environment's: `MOCKWA_WEBHOOK_URL`, `MOCKWA_APP_SECRET`, `MOCKWA_WEBHOOK_VERIFY_TOKEN`, `MOCKWA_APP_ID`. It is not stored and cannot be edited from the console; its key is `default`. A setup that only sets these variables behaves exactly as before.
- **Registered apps** each have an ID, a name, and their own callback URL, App Secret, Verify Token and (optionally) access token. They come from `MOCKWA_APPS` (inserted at boot and after a reset, never overwriting an app that already exists) or from `/api/apps`, and live in the `apps` table.
- **Who receives a WABA's webhooks**: every registered app subscribed to it, plus the default app when it is subscribed **or** when no registered app is (the §2.20 divergence).
- **Where each copy goes**, Meta's precedence: the app's **phone-number override** for that number, else its **WABA override**, else its **callback URL**. Overrides apply only to the overridable fields mockwa knows from Meta's reference — `messages`, `message_echoes`, `calls`, `consumer_profile`, `messaging_handovers`, `standby`, `history` and `account_settings_update`; any other field ignores them. **Template and account fields** (`message_template_status_update`, `message_template_quality_update`, `phone_number_quality_update`, `account_update`, `business_capability_update`) always go to the app's own callback URL.
- `GET /api/webhook-routes?wabaId=&phoneNumberId=&field=` answers where such an event would go right now, and which level picked each URL — the routing, without having to send anything.

## 4. Deterministic status ladder & template lifecycle

- On accepted send: emit `sent` immediately, then `delivered` after `MOCKWA_STATUS_DELAYS` (default `sent:0,delivered:800`). **`read` is manual by default** (button in UI, or `read:<ms>` in the env var to automate). `failed` is manual (UI picks an error code from presets: 131049 engagement, 131026 undeliverable, 131047 re-engagement window, 130472 experiment, 131048 sending restricted, 131000 unknown error; sends proper `errors[]`) — or decided at send time by a messaging rule or a `messages.status` injection rule (below), in which case `failed` takes the `sent` rung's slot and the ladder stops there: no `sent`, no `delivered`.
- Status webhooks for `sent`/`delivered` include `conversation` + `pricing` shaped like the fixture (conversation ID = stable hash of phone+contact+day; `origin.type`/`pricing.category` = template category lowercased, else `service`; `expiration_timestamp` = now+24h as string).
- Template create/edit → status `PENDING`; if `MOCKWA_TEMPLATE_AUTO_APPROVE` (default `2000` ms) is not `off`, auto-approve after the delay and emit the webhook. UI can approve/reject (with `reason`/`rejection_info`) any PENDING template, and later pause/disable — every transition emits the webhook. A **seeded** template never enters this flow: it is `APPROVED` at boot, announces nothing and schedules no timer (§7).
- Timers must survive nothing: they are in-process `setTimeout`s; on restart pending timers are dropped (fine for a dev tool — document it).

### Typing indicators

A typing indicator belongs to a conversation and lives **only in memory**, next to those timers.
It goes up when the app under test sends `typing_indicator` on `POST /{phoneNumberId}/messages`
(§2 row 18) and comes down at the first of: Meta's **25-second** dismissal window, the next
outbound message in that conversation, a `POST /api/reset`, or a restart. Both edges are
published as `typing.changed` (§5) and readable through `GET /api/typing`; nothing about it is
persisted, and no webhook describes it.

### Phone number registration ladder & the send gate

A phone number's `status` decides whether it can send at all, and **only `CONNECTED` can**: a
`POST /{phoneNumberId}/messages` from anything else is error `133010` ("Phone number not
registered"), which is what a consumer keys deregistration detection on. The rungs (§2, rows
13–17), with nothing timed and nothing random:

| Stage | `status` | `code_verification_status` | `name_status` |
|---|---|---|---|
| seeded, or created through the control plane | `CONNECTED` | `VERIFIED` | `APPROVED` |
| created via `POST /{wabaId}/phone_numbers` | `UNVERIFIED` | `NOT_VERIFIED` | `PENDING_REVIEW` |
| …with a `preverified_id` | `PENDING` | `VERIFIED` | `PENDING_REVIEW` |
| after `verify_code` | `PENDING` | `VERIFIED` | `PENDING_REVIEW` |
| after `register` | `CONNECTED` | `VERIFIED` | `APPROVED` |
| after `deregister` | `DISCONNECTED` | `VERIFIED` | `APPROVED` |

**Everything that existed before the ladder starts at the top of that table**, which is what
keeps `MOCKWA_SEED` (and every consumer configured against it) working unchanged: only a number
created through the Graph endpoint has to climb. `request_code` is accepted at any rung — asking
is harmless and it is the shortest way to see the flow in the UI — and only `verify_code` moves
anything.

### Messaging rules (M3)

Four of Meta's sending rules, decided in one domain service (`MessagingRules`) that reads the
injectable clock — a test steps over a boundary instead of waiting a day. Every default figure
is Meta's documented one; the variables of §7 exist to reach a boundary quickly or to turn a
rule off.

**Customer service window** (`MOCKWA_SERVICE_WINDOW`, default `24h`, **on**). Meta: when a
customer messages a business number, a 24-hour customer service window opens, and each new
message from them restarts it; inside it any message type may be sent, outside it only
templates. mockwa derives the window from the latest **inbound** message between that business
number and that contact (`POST /api/inbound`, the virtual phone, or anything else that stores an
inbound message — an inbound `timestamp` is honored, which is how a test backdates one). The
window is open while `now < last inbound + window` and **closed at exactly the boundary**.

- A template may be sent at any time. One sent while the window is closed is
  *business-initiated* (`messages.business_initiated = 1`), which is what the messaging limit
  counts.
- Any other type sent while the window is closed is **accepted** (200 with a wamid, like any
  send) and then ends with a `failed` status webhook carrying `131047` ("Re-engagement message")
  in the slot `sent` would have used. No `sent` or `delivered` follows.
- `off` turns enforcement off: every send behaves as before M3, and `GET /api/service-window`
  still reports the window (with `isEnforced:false`, measured against 24h).

**Throughput** (`MOCKWA_THROUGHPUT`, default `off`). Meta: up to 80 messages per second per
business number by default, up to 1,000 after the automatic upgrade; exceeding it is `130429`.
`meta` uses each number's `throughput.level` (`STANDARD` → 80, `HIGH` → 1,000); a whole number
applies one figure to every number. Counted per business phone number over **fixed one-second
windows**; a send over the limit is **refused**: HTTP 429, code `130429`, `Retry-After: 1`.

**Pair rate limit** (`MOCKWA_PAIR_RATE_LIMIT`, default `off`). Meta: one message every 6 seconds
to the same WhatsApp user, bursts of up to 45; exceeding it is `131056`. `meta` is `6s/45`;
`<interval>/<burst>` sets both. Modeled as a generic cell rate per (business number, contact):
`burst` sends may go at once, after which one more is allowed per interval. A send over the
limit is **refused**: HTTP 400, code `131056`, no headers.

Throughput and pair limits are checked together and consumed together, after the request has
been validated: a send one of them refuses consumes nothing. Their counters live in memory —
a restart, `POST /api/reset` and `POST /api/import` clear them.

**Messaging limit** (`MOCKWA_MESSAGING_LIMIT`, default `off`). Meta: the number of unique
customers a business can reach with business-initiated messages in a moving 24 hours (tiers
250, 2,000, 10,000, 100,000, unlimited). mockwa counts the unique contacts of non-failed
business-initiated sends created in the last 24 hours (`created_at > now − 24h`), shared by
every number of one WABA. A contact already in the count can always be reached again; a
template to a *new* contact over the limit is accepted and ends `failed` with **`990001`**, a
**simulator-specific** code (below). The
period is always 24 hours, whatever the window is set to. `GET /api/messaging-rules` reports the
count per WABA.

**Order of decisions** on `POST /{phoneNumberId}/messages`: bearer and injection middleware →
the send gate (`133010`) → request validation (recipient, template) → throughput and pair limit
(refusals) → window and messaging limit (failures) → a `messages.status` injection rule (only if
no rule already failed the send) → stored and answered 200.

#### Differences from the real Meta Cloud API

Deliberate, and each one either fills a gap in Meta's documentation or keeps mockwa simple.

| Area | Meta | mockwa |
|---|---|---|
| Window error timing | Documents `131047` but not whether it is synchronous or asynchronous; its error page says codes may be either | Always asynchronous: 200, then a `failed` status webhook |
| Window scope | Opened or restarted by a customer's message or call | Per business **phone number** and contact; opened only by inbound messages. Calls are not modeled |
| Messaging limit scope | Per business portfolio | Per WABA (mockwa has no portfolio) |
| Messaging limit error | Documents the limit, but no error code or behavior for exceeding it. `131048` is a restriction on the phone number (blocks, spam reports), and `131064` is a limit from template classification violations; neither is the tier limit | `failed` status with mockwa's own code `990001`, outside Meta's numbering: title `[mockwa] Messaging limit reached (simulated)`, details beginning `Simulated by mockwa`, `href` to Meta's messaging-limits page. An app must never key production behavior on it |
| Messaging limit tiers | Raised automatically by quality and volume | A fixed number, set by `MOCKWA_MESSAGING_LIMIT`; no tier upgrades |
| Throughput counting | Per business number, all messages; algorithm unpublished | Outbound sends only, fixed one-second windows |
| Throughput upgrade | `131057` while the number is upgraded | Not simulated; set `throughput.level` from the console instead |
| HTTP status of refusals | Lists no HTTP status for `130429` or `131056` | `429` for `130429` and `400` for `131056`, inherited from whaloc's injection presets (§4) |
| Rate-limit headers | Not documented for `130429` | `Retry-After: 1` only; no `X-Business-Use-Case-Usage` (that stays with the `rate_limit_429` injection preset) |
| WABA and app rate limits | Graph call limits (`80007` throttling, `4` app limit) | Not simulated; use an injection rule (`spam_rate_4`, or `custom`) |
| Counters across restarts | — | Throughput and pair counters are in memory and start afresh; the window and messaging limit are read from stored messages and survive |
| Pricing and conversations | Charged per delivered template | Unchanged from §4: conversation and pricing nodes only, nothing is billed |

### Error simulation: token registry, injection rules, media TTL

Three ways to make whaloc misbehave **on purpose**. All three are off by default, none of them
is probabilistic, and each is visible from the UI — a failure a developer did not ask for is a
support question, and a failure they *did* ask for but forgot about is worse.

**Strict tokens** (`MOCKWA_TOKENS`, §1.9). Unset, whaloc is permissive and there is nothing to
list. Set to a comma-separated registry, only those tokens pass; the control plane can mark any
of them expired (`POST /api/tokens/:id/expire`, `…/restore`), which is the 401 / 190 / 463
envelope. Expiry is **persisted** — a row per expired token, keyed by a truncated SHA-256 so the
database never holds a credential — and `POST /api/reset` revives every token. The registry is
served masked (`••••••••cdef`) and the token values never leave the process.

**Injection rules.** A rule is a *target*, a *trigger* and a *response preset*, created at
runtime through the control plane and stored in the database (cleared by `POST /api/reset`).

| Part | Values |
|---|---|
| Target (endpoint class) | `messages.send` (`POST /{phoneNumberId}/messages`), `messages.status` (the **status** of an accepted send, below), `media.upload`, `media.resolve` (`GET /{mediaId}?phone_number_id=`), `media.download` (`GET /whaloc-media/{token}`), `templates.create`, `templates.list`, `graph.all` (every Graph request, the byte endpoint included) |
| Trigger | `always`; `next N` with a live countdown; `every Nth` counted off the rule's own request counter (fires on the 3rd, 6th, 9th…) |
| Preset | `rate_limit_429` (429, code `130429`, `Retry-After: <seconds>` + `X-Business-Use-Case-Usage`), `throughput_131056` (400, code `131056`, no headers), `spam_rate_4` (429, code `4`, same two headers), `server_error_500` (500, code `1`), `custom` (caller supplies http status, code, optional subcode, message, details, type), `failed_status` (only for `messages.status`, with an `errorCode` from the message error presets) |

The usage header is Meta's, keyed by business ID, with the throttled app's quota at 100 %:

```json
{"<waba-id>":[{"type":"whatsapp","call_count":100,"total_cputime":100,"total_time":100,"estimated_time_to_regain_access":15}]}
```

`estimated_time_to_regain_access` is in **minutes** while `Retry-After` is in seconds (§1.11);
both are per-rule, defaulting to 60 s / 15 min. The header is keyed by the first WABA whaloc
knows about, and left off entirely when there is none.

Evaluation happens in **one middleware on the Graph surface, before any handler** — and after
the bearer gate, so an armed `graph.all` rule can never disguise a 401. Every rule whose target
matches has its request counter advanced; the **first one in creation order that its trigger
arms** answers, and a rule shadowed by an earlier one keeps its countdown (it has not fired). A
match short-circuits with the Meta envelope, its headers and an `info` log line. The decision is
domain (`InjectionService`); only the short-circuit is Hono.

**Status injection.** A `messages.status` rule never answers a request — `graph.all` does not
match it either. It is evaluated by the message service for every send that was accepted and
that no messaging rule already failed, with the same triggers and counters: when it fires, the
send still answers 200 with its wamid, and its first status webhook is `failed` with the rule's
`errorCode` instead of `sent`. That is how an app's handling of an asynchronous failure is
tested on demand. Its only preset is `failed_status`, and `failed_status` belongs to no other
target.

**Media TTL** (`MOCKWA_MEDIA_TTL_SECONDS`, default off). An object whose age has *reached* the
TTL — the boundary is inclusive — is gone from the Graph surface: the descriptor hop answers the
missing-object envelope (**400 / code 100 / subcode 33**, §1.4, which is what consumers key
expired-media detection on) and the byte endpoint answers the same plain 404 an unknown token
gets, because that route carries no Meta envelope. Age is measured from the row's `created_at`
against the injectable clock, so it is exact in tests. The row and the bytes stay put — only a
reset deletes those — and the control plane's `GET /api/media/:id` ignores the TTL, so whaloc's
own UI can still explain what a message's media ID pointed at.

## 5. Control-plane API (`/api`) + WebSocket

REST consumed by the web UI (and by test scripts). Suggested resources (final shapes belong to `packages/shared` zod schemas — UI and server both import them):

- `GET /api/state` — WABAs (with `subscribedAt`, §2.20), phone numbers (lifecycle fields, the pending verification code and the business profile included), the app identity `subscribed_apps` reports, behavior config, webhook target status.
- `GET/POST /api/wabas`, `PATCH/DELETE /api/wabas/:id` — WABAs at runtime; a delete cascades to phone numbers (and their conversations, messages and media bytes) and templates. Deleting the last one is allowed: an empty whaloc is a legal state.
- `GET/POST /api/phone-numbers`, `PATCH/DELETE /api/phone-numbers/:id` — numbers under a WABA. Created here they are `CONNECTED`/`VERIFIED` (the "already onboarded" path, §4); `PATCH` takes `displayPhoneNumber`/`verifiedName`; a delete cascades like the above. Duplicate digits → 409.
- **Explicit IDs.** Both creates take an optional `id` (1–32 digits, §1.3), so a WABA or a phone number can be given the one an app's production configuration already names instead of a freshly minted one; omitted, whaloc mints it. Because `GET /{id}` dispatches by whichever store holds the ID (§2), an explicit ID has to be free across **every** store — WABAs, phone numbers, media and templates — and one that is taken is a 409 naming what holds it. The Graph-side `POST /{wabaId}/phone_numbers` takes no such field: it is Meta's request shape, and Meta assigns the ID.
- `GET/POST/PATCH /api/contacts` — wa_id, profile name, and the optional **BSUID** (`userId`, §1.15): validated against Meta's pattern, unique across contacts (a duplicate is a plain 409), `null` clears it. Seedable: a `MOCKWA_SEED` contact may carry `userId`, and the default seed gives both contacts one (one `ENT.` form, one without), so identity fields appear on webhooks out of the box. mockwa adds two optional, nullable **presentation** fields for the virtual phone: `role` (free text, 1–40 characters, such as `CUSTOMER` or `TECHNICIAN`) and `displayNumber` (the friendly number a phone shows for itself; `+<wa_id>` when unset). Neither reaches a webhook or the Graph API: Meta has no such fields, and the app under test must not see a difference.
- `POST /api/contacts/:waId/change-number` — `{waId, phoneNumberId?}`: the person moved. The contact's `wa_id` changes **in place** — profile name, BSUID and history follow it — and whaloc emits Meta's `user_changed_number` system event (§3) for every business number that has a conversation with the contact, or only for `phoneNumberId` when one is named. A number another contact already holds is a 409 and nothing moves; the same number is a 400. **wamids never change**, so a reaction, a reply or a read receipt naming an older message keeps resolving; the *derived* conversation IDs (`<phoneNumberId>:<waId>`) do change, which is what `contact.changed`'s `previousWaId` exists for. The system message is a webhook event only — no message row is stored for it.
- `GET /api/conversations?phoneNumberId=` / `GET /api/conversations/:id/messages` (paginated, newest last). An outbound `template` message carries `templateSnapshot: {parameterFormat, components}` — the definition the send was validated against (§2 row 5) — which the chat renders with the send's parameters substituted; it is absent on every other type and on template messages stored before whaloc kept one, which the UI renders from the template it currently knows, or as the raw send.
- `POST /api/inbound` — simulate a user message: `{phoneNumberId, from, type, ...typed payload}`; supports every inbound type: text, media (referencing an uploaded media ID or multipart upload via `POST /api/inbound-media`), interactive `button_reply`/`list_reply`, `button`, location, contacts, reaction, and **`unsupported`** — Meta's placeholder for a message this API version cannot represent (a poll, say), which goes out as `{type:"unsupported", errors:[{code:131051, title:"Message type unknown", message:"Message type unknown", error_data:{details:"Message type is currently not supported."}}], unsupported:{type:"poll_update"}}`: the v16+ error-node shape *and* the `unsupported` node naming the type Meta could not represent, which the optional `unsupportedType` picks from Meta's own list (`button`, `edit`, `order`, `poll_creation`, `poll_update`, …) and defaults to `poll_update`. It is stored as a message row so the chat shows a placeholder bubble. Every type also accepts the **context riders**, all optional and all combinable:
  - `referral` — a click-to-WhatsApp ad or post: `{source_url, source_type:"ad"|"post", source_id, headline?, body?, media_type?:"image"|"video", image_url?, video_url?, thumbnail_url?, ctwa_clid?, welcome_message?:{text}}`, written in Meta's snake_case and echoed **top-level on the message**. `welcome_message.text` is the greeting the ad pre-filled, which is how a handler tells an ad-generated opener from something the person typed.
  - `forwarded` / `frequentlyForwarded` — booleans that become `context.forwarded` / `context.frequently_forwarded`.
  - `referredProduct` — `{catalog_id, product_retailer_id}`, which rides **inside `context`**, not beside it.

  The riders merge with the `context` a `replyTo` produces rather than replacing it, so a forwarded reply about a catalog item is one `context` with `from`, `id`, `forwarded` and `referred_product` in it. Persists + emits webhook.
- `POST /api/messages/:id/status` — `{status:"read"|"delivered"|"failed", errorCode?}` manual transitions; `GET /api/message-error-presets` lists the failure presets that action accepts (code + Meta's wording), which is what the UI's "fail…" menu is built from.
- `GET /api/service-window?phoneNumberId=&waId=` — the customer service window between one business number and one contact (§4, "Messaging rules"): `{phoneNumberId, waId, isEnforced, isOpen, lastInboundAt, expiresAt, windowMs}`, the times as ISO strings or `null` when the contact never wrote. 404 for an unknown business number.
- `GET /api/messaging-rules` — the configured rules (`serviceWindowMs`, `throughput`, `pairRateLimit`, `messagingLimit`, each `null` when off) and `usage`: per WABA, the messaging limit and the unique contacts counted against it. The same configuration is in `GET /api/state` as `behavior.messaging`.
- `GET /api/typing?phoneNumberId=` — the typing indicators that are up right now (§4). Read-only: an indicator is something the *app under test* declares, so the control plane serves them (for a UI that just loaded, and for assertions) but never raises one.
- `GET /api/media/:id` — the descriptor behind a media ID (`{id, url, mimeType, sha256, fileSize}`), so the UI can render an inline preview of a message whose payload only carries the ID.
- `GET /api/uploads?handle=` — the same, for a **resumable-upload handle** (§2.21): `{handle, url, mimeType, sha256, fileSize, fileName, createdAt}`, 404 when no completed session owns it. A template's `example.header_handle` carries a handle rather than a media ID, so this is what lets the Templates view preview a media header with the picture it will actually send. The handle rides in the query string because Meta's handles are full of colons.
- `GET /api/templates?wabaId=&status=&category=&language=&name=&search=` — the same filters the Graph listing takes (§2.8; `search` is `name_or_content`), applied server-side so the UI's filter bar and a consumer's filtered listing agree. `POST /api/templates/:id/approve|reject|pause|quality` (quality → quality_update webhook).
- `GET /api/webhook-deliveries?limit=&before=` / `POST /api/webhook-deliveries/:id/redeliver` / `POST /api/webhook-deliveries/:id/cancel-retry` / `POST /api/webhook/handshake` / `POST /api/webhook/raw[?appKey=]`. Each delivery carries `appKey`, `chainId`, `nextAttemptAt` and `outcome` (`delivered`, `retrying`, `failed`, `skipped`), §3.
- `GET/POST /api/apps`, `PATCH/DELETE /api/apps/:key` — the apps of §3 ("Apps and routing"). `GET` answers the whole **routing** — `{apps, subscriptions, phoneOverrides}` — and an app reports `hasAppSecret`/`hasVerifyToken`/`hasAccessToken`, **never the values**. The default app is read-only (400 `default_app_read_only`); a duplicate ID, name or access token is a 409; deleting an app removes its subscriptions and overrides and cancels its pending retries. `PUT/DELETE /api/apps/:key/subscriptions/:wabaId` (`{overrideCallbackUri?, verifyToken?}` — omitting the override removes it), `PUT/DELETE /api/apps/:key/phone-overrides/:phoneNumberId` (`{callbackUri, verifyToken?}`), `POST /api/apps/:key/handshake`, and `GET /api/webhook-routes` (§3). Every change publishes `webhook_routing.changed`.
- `POST /api/webhook/account-update` — `{wabaId, event, phoneNumberId?, restrictionInfo?}` and `POST /api/webhook/business-capability-update` — `{wabaId, maxDailyConversationPerPhone, maxPhoneNumbersPerBusiness}`: the two account-level notices (§3), triggered from Settings per WABA the way the phone-quality one is triggered per number. Both answer with the delivery attempts, like the raw sender, and **change no whaloc state**. An unknown WABA is a 404; a `phoneNumberId` under a different WABA is a 400.
- `POST /api/phone-numbers/:id/quality` — set quality_rating/throughput + optionally emit `phone_number_quality_update`.
- `POST /api/phone-numbers/:id/business-profile` — the same profile the Graph endpoint writes (§2.19), in camelCase, with the same merge-and-clear semantics; answers with the updated number. Subscriptions and overrides (§2.20) are written by the app under test through the Graph API, or from the console through `/api/apps`.
- `GET/POST /api/injection-rules`, `DELETE /api/injection-rules/:id` — the error-injection rules (§4). No `PATCH`: a rule is three decisions and a countdown, and deleting plus re-adding leaves no question about what happened to the counters.
- `GET /api/tokens`, `POST /api/tokens/:id/expire|restore` — the `MOCKWA_TOKENS` registry (§1.9), masked. `{strict:false, data:[]}` when there is no registry, which is what the UI hides its section on.
- `POST /api/reset` — wipe all state (keep seed). Injection rules and token expiry go with it.
- `GET /api/export` — the whole state as **one downloadable JSON file** (`Content-Disposition: attachment`), so a scenario is shareable: schema version, whaloc version (the release tag the image was built from, via `MOCKWA_VERSION`; `0.0.0-dev` from source), `exportedAt`, every domain table as its **raw rows** (snake_case, JSON columns still TEXT — a snapshot is a database dump, not an API resource), and the bytes of every media object **and every completed upload session** (§2.21) **base64-inlined** beside their rows, so an imported template still previews its media header. Rows are ordered deterministically, so two exports of the same state differ only in the timestamp. The delivery log is left out unless `?include=deliveries` asks for it (it is traffic, not state, and by far the biggest table). Base64 costs a third in size over the raw bytes: acceptable for a dev tool whose media is a handful of test images, and the price of a file that restores completely on its own.
- `POST /api/import` — the mirror image, from a JSON body or a `multipart/form-data` upload (`file`). Validated in full first (zod, every row and enum) and **version-gated**: a snapshot from a newer whaloc is refused with a clear message rather than half-loaded. Then all state is replaced — timers cancelled like a reset, the database swapped in **one transaction**, stale media bytes deleted and the snapshot's written back **through the current storage backend**, so a local export imports into an S3-backed instance and vice versa (§6). Answers with a summary count, and publishes `state.imported` so connected UIs reload. **The seed does not re-run**: the snapshot *is* the state, IDs included — `POST /api/reset` remains the only way back to `MOCKWA_SEED`. Media rows are restored verbatim, digest included, so a snapshot taken before `sha256` became base64 (§1) keeps its hex digests for those rows — the snapshot *is* the state, and re-hashing somebody else's world on the way in would be a different kind of lie. Anything uploaded afterwards is base64; re-uploading the object, or exporting from a current whaloc, settles it.
- `GET /api/health` (alias `/health` at root, for Docker HEALTHCHECK).

### Virtual phone (mockwa)

A second page on the console port, **`/phone`**, plays the *user* side of WhatsApp: one contact per browser tab, chatting with the business numbers the way a person would. It adds **no state and no new behavior** — it is a view of the same conversations from the contact's side, and everything it does goes through the existing machinery, so the app under test cannot tell a phone from `POST /api/inbound`.

- **Identities.** Every contact is an identity. There is no login: in developer mode the tester picks one, and the tab is that contact until it switches. The tab's state lives in the query string (`/phone?as=<waId>&chat=<phoneNumberId>`), so several phones run side by side in separate tabs or browser contexts and a reload lands in the same place.
- `GET /api/phone/identities` — the contacts, with `role` and `displayNumber`.
- `GET /api/phone/identities/:waId/chats` — one chat per **business phone number**, history or not (so an identity can start a conversation), with the last message and `unreadCount` (business messages in `delivered`). Chats with history come first, newest activity on top.
- `GET /api/phone/identities/:waId/chats/:phoneNumberId/messages` — that conversation, the same page shape as `/api/conversations/:id/messages`.
- `POST /api/phone/identities/:waId/chats/:phoneNumberId/messages` — `POST /api/inbound`'s body; the **path** names the sender and the business, and the same fields in the body are overridden, so a phone can only speak as itself. A tapped template quick reply or interactive reply button goes out here too, quoting the message it answers.
- `POST /api/phone/identities/:waId/chats/:phoneNumberId/read` — the chat is open: every **delivered** business message moves to `read` through the status ladder, each with its own status webhook; a message still `accepted`/`sent` has not reached the phone and is left alone. The page calls it whenever a delivered business message is on screen in a visible tab. Answers `{data:{read}}`.
- WebSocket `/api/phone/identities/:waId/ws` — `/api/ws` filtered to one identity: its own `message.*`, `typing.changed` and `contact.changed` (including the move away from its old number), plus the world-wide `template.changed`, `waba.changed`, `phone_number.changed`, `state.reset` and `state.imported`. The developer streams — `webhook.delivery`, `webhook_routing.changed`, `injection.changed`, `token.changed` — never reach a phone. An unknown identity is a 404 before the upgrade.

Replies are never mockwa's: whatever a phone receives was sent by the app under test through the Graph API. With no `MOCKWA_WEBHOOK_URL`, a phone's message is stored and shown, its delivery is logged as skipped, and nothing answers it. The console's top bar names the webhook receiver on every view (`webhooks → host/path`, or `webhooks: not sent` when none is configured), linking to the Webhooks view.

Every route answers 404 for an unknown identity or business number, in the control plane's error shape. The Developer Console (`/`) and `/api/ws` are unchanged; the phone is not reachable on the Graph port (§8).

WebSocket `/api/ws`: server → client events `{type, payload}`: `message.created`, `message.status_changed` (a read receipt on an inbound message arrives this way — there is no separate `message.read`), `typing.changed` (`payload.typing.expiresAt === null` means it came down), `template.changed`, `webhook.delivery`, `contact.changed` (with `previousWaId` when the contact changed number, so a client can re-key what it derived from the old one), `waba.changed`, `phone_number.changed` (both carry `event:"created"|"updated"|"deleted"`; a phone number's rung on the ladder — a `request_code` included — arrives this way too), `injection.changed` (an `updated` event is published for every rule a request touched, which is what makes the UI's countdown live), `token.changed`, `webhook_routing.changed` (the whole routing, §3), `state.reset`, `state.imported` (the same payload as a reset — a client drops everything and reloads either way; the two are separate because one comes back to the seed and the other to somebody else's world). UI is a pure client of REST+WS — no other coupling. On shutdown (`SIGTERM`/`SIGINT`) every open WebSocket — console or phone — is sent a close frame with code `1001` (going away) and given two seconds to answer before it is cut, so an open tab never holds the process until the shutdown deadline.

## 6. Data model & persistence

**Kysely + `node:sqlite`** (built into Node 24; no native deps, no WASM). Default DB is `:memory:`; `MOCKWA_DB_PATH=/data/whaloc.db` makes state survive restarts (volume). Use Kysely's SQLite dialect surface with a thin custom driver over `node:sqlite`'s `DatabaseSync` (prefer a well-maintained npm dialect if one exists — verify on npm — else write the ~100-line driver in `packages/server/src/db/`; reuse Kysely's `SqliteAdapter`/`SqliteQueryCompiler`/`SqliteIntrospector`). Migrations run at boot (Kysely migrator, in-code migration list).

Tables (roughly): `wabas`, `phone_numbers` (`id`, waba_id, display_phone_number, verified_name, quality_rating, throughput_level), `contacts` (wa_id, profile_name, user_id — the BSUID, nullable and unique), `templates` (`id` digits, waba_id, name, language, category, parameter_format, components JSON, status, rejected_reason, quality_score), `messages` (wamid, direction, business_initiated — `1` for a template sent while the window was closed, `0` otherwise and on rows stored before M3, phone_number_id, contact, type, payload JSON, status, error JSON, biz_opaque_callback_data, template_snapshot JSON — `{parameter_format, components}` for a template send, `null` otherwise and for rows stored before it existed, timestamps, reply_to), `media` (`id` digits, phone_number_id, mime_type, sha256, file_size, storage_key, url_token), `upload_sessions` (`id`, app_id, file_name, file_type, file_length, received_bytes, handle unique, storage_key, sha256, url_token unique, timestamps — §2.21; one row is the whole life of an upload, which is why a handle survives a restart), `webhook_deliveries` (`id`, event_type, url, request_body, request_headers, response_status, response_body, error, attempt, duration_ms, created_at, app_key, chain_id, next_attempt_at — the last three `null` on rows written before apps existed, read as the default app, a chain of one and nothing pending), `apps` (`id`, name, app_secret, verify_token, callback_url, access_token unique, timestamps), `webhook_subscriptions` (waba_id, app_key, override_callback_uri, override_verify_token, subscribed_at), `phone_number_webhook_overrides` (phone_number_id, app_key, callback_uri, verify_token, updated_at), `injection_rules` (`id` time-ordered, target, trigger_kind, trigger_count, preset, retry_after_seconds, regain_access_minutes, custom JSON, error_code — the `failed_status` code, `null` otherwise, seen, matches, remaining, timestamps), `expired_tokens` (token_id = truncated SHA-256, expired_at).

**Media bytes** go through a `MediaStorage` interface (`put(stream|buffer, meta) → {storageKey, sha256, byteSize}`, `get(storageKey, {range?}) → {stream, size}`, `delete`, optional `close`), with two implementations selected by `MOCKWA_MEDIA_BACKEND`:

| Backend | Implementation | Where the bytes go |
|---|---|---|
| `local` (default) | `LocalDirStorage` | one flat directory of opaque files, rooted at `MOCKWA_MEDIA_DIR` (default `/data/media`, fallback `./data/media` outside Docker), created on the first upload |
| `s3` | `S3MediaStorage` | an S3-compatible bucket (`MOCKWA_S3_*`), via `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` |

**Nothing outside the storage module may touch the filesystem — or the bucket.** The `@aws-sdk` dependency lives in `storage/` and nowhere else, and no caller ever learns which backend it got: that is what makes a snapshot (§5) exported from a local-backed whaloc importable into an S3-backed one.

Shared contract, enforced by one vitest suite both implementations run (`storage/media-storage-contract.ts`):

- Storage keys are flat and conservative (`^[\dA-Za-z][\w.-]{0,127}$`) — no separators, nothing to traverse with — so the same key is valid on both backends and travels inside a snapshot.
- `put` measures the SHA-256 and the byte count **while the bytes stream past**, never buffering the object: the local backend pipes to a file, the S3 one hands the stream to `lib-storage`, which sends anything under one 5 MiB part as a single `PutObject` and switches to multipart above it. A failed upload leaves nothing behind under its key (the local backend waits for its write stream to close before deleting — the descriptor is opened asynchronously, and deleting before it lands leaves a zero-byte file).
- `get` honors an inclusive byte range (the consumer's `Range`, §1.7) and always reports the size of the **whole** object — read off `Content-Range` when the answer is a slice.
- A missing object is `MediaObjectNotFoundError` from `get` and a no-op for `delete`.

The S3 side of the contract suite runs against **RustFS**: in CI as a service container, locally when `WHALOC_TEST_S3_ENDPOINT` points at one. Unset, those specs skip with a message saying how to start it — a machine without Docker still gets a green `npm test`.

## 7. Configuration (environment variables only)

Parsed once at boot with zod (fail fast, print every error). Everything is an environment variable; only the seed can also come from a file (`MOCKWA_SEED_FILE`).

**Names (mockwa).** Every variable is spelled `MOCKWA_*`. The whaloc spelling `WHALOC_*` is still read as an alias, so an existing setup keeps working: `WHALOC_X` stands for `MOCKWA_X`, except `WHALOC_PORT`, which stands for `MOCKWA_GRAPH_PORT` (whaloc's single port was the one the app under test called). When both spellings are set, the `MOCKWA_*` one is used, and a boot warning names the pair if their values differ. A blank value counts as unset for either spelling. A validation error names the variable the operator actually set. `WHALOC_VERSION` (the image's version, §5) is read the same way, as an alias of `MOCKWA_VERSION`.

| Var | Default | Purpose |
|---|---|---|
| `MOCKWA_GRAPH_PORT` | `8888` | Graph API listener (the table at the top); alias `WHALOC_PORT` |
| `MOCKWA_CONSOLE_PORT` | `8025` | Console listener: control plane, WebSocket and web UI. Must differ from `MOCKWA_GRAPH_PORT` |
| `MOCKWA_HOST` | `0.0.0.0` | Bind address, for both listeners |
| `MOCKWA_PUBLIC_URL` | `http://localhost:8888` | Base for generated media URLs / paging.next |
| `MOCKWA_WEBHOOK_URL` | *(unset → webhooks disabled, warn loudly)* | Target for webhook POSTs, e.g. `http://meta-webhook-receiver:3001/meta-webhooks` |
| `MOCKWA_APP_SECRET` | *(unset → deliveries unsigned, warn)* | HMAC key for `X-Hub-Signature-256` |
| `MOCKWA_WEBHOOK_VERIFY_TOKEN` | *(unset)* | Used for the `hub.challenge` handshake action |
| `MOCKWA_VERIFY_ON_START` | `false` | Run handshake at boot |
| `MOCKWA_APP_ID` | *(derived, stable)* | The default app's ID, which `subscribed_apps` reports (§2.20). Set it to the `META_APP_ID` the app under test uses; left unset it is derived deterministically, so it survives restarts |
| `MOCKWA_APPS` | *(unset → only the default app)* | JSON: `[{"id?","name","appSecret?","verifyToken?","callbackUrl?","accessToken?","wabas?":["<wabaId>"]}]` — registered apps (§3, "Apps and routing"), inserted at boot and after a reset when missing. An omitted `id` is derived from the name; `wabas` subscribes the app to those WABAs. Names, IDs and access tokens must be unique |
| `MOCKWA_WEBHOOK_RETRY_SCHEDULE` | `10s,30s,1m,5m,15m,1h,3h,6h,12h,24h` | Delay before each retry of a non-`200` delivery, the last one repeating (§3); units `ms`, `s`, `m`, `h`, `d`. `off` = no retries |
| `MOCKWA_WEBHOOK_RETRY_MAX_AGE` | `7d` | How long after its first attempt a delivery is still retried (Meta: up to 7 days) |
| `MOCKWA_SEED` | *(built-in default seed)* | JSON: `[{"id?","name?","phoneNumbers":[{"id?","displayPhoneNumber","verifiedName?","qualityRating?","throughputLevel?"}],"contacts?":[{"waId","name","userId?","role?","displayNumber?"}],"templates?":[{"id?","name","language?","category?","parameterFormat?","components?"}]}]`; omitted IDs are generated deterministically. A seeded template is **`APPROVED` from the first instant** (no review, no webhook), with `language` defaulting to `en`, `category` to `UTILITY`, `parameterFormat` to `NAMED` and `components` to a single static BODY. Default seed: 1 WABA + 1 phone number + 2 contacts + 1 zero-parameter template (`hello_whaloc` / `en`), logged at startup |
| `MOCKWA_SEED_FILE` | *(unset)* | Path to a file holding the `MOCKWA_SEED` JSON, read once at boot — for seeds too long to keep inline in a compose file. It stands in for `MOCKWA_SEED`: setting both, an unreadable file and an empty one are all startup errors, never a silent fallback to the default seed, and an invalid seed is reported under this variable |
| `MOCKWA_STATUS_DELAYS` | `sent:0,delivered:800` | Ladder config; add `read:<ms>` to automate read |
| `MOCKWA_TEMPLATE_AUTO_APPROVE` | `2000` | ms until auto-approval; `off` = manual |
| `MOCKWA_TOKENS` | *(unset → any non-empty bearer token)* | Comma-separated bearer-token registry (§1.9, §4). Set it and only these tokens pass; blank entries are dropped, duplicates rejected. Each can be expired/restored from the control plane |
| `MOCKWA_MEDIA_TTL_SECONDS` | *(unset → media never expires)* | Whole seconds after which a media object is gone from the Graph surface (§4) |
| `MOCKWA_SERVICE_WINDOW` | `24h` | Customer service window (§4, "Messaging rules"); a duration (`30s`, `24h`) or `off` — `off` restores the pre-M3 behavior of accepting any free-form send |
| `MOCKWA_THROUGHPUT` | `off` | Messages per second per business number: `off`, `meta` (each number's `throughput.level`: 80 or 1,000) or a whole number. Over it: 429 / `130429` |
| `MOCKWA_PAIR_RATE_LIMIT` | `off` | Messages to one contact from one number: `off`, `meta` (`6s/45`) or `<interval>/<burst>`. Over it: 400 / `131056` |
| `MOCKWA_MESSAGING_LIMIT` | `off` | Unique contacts reached by business-initiated templates per WABA in a moving 24 hours: `off`/`unlimited` or a whole number (Meta's tiers: 250, 2000, 10000, 100000). Over it: `failed` / `990001` (simulator-specific, §4) |
| `MOCKWA_DB_PATH` | `:memory:` | SQLite path for persistence |
| `MOCKWA_MEDIA_BACKEND` | `local` | `local` (a directory) or `s3` (an S3-compatible bucket), §6 |
| `MOCKWA_MEDIA_DIR` | `/data/media` (image) | Media storage root, for the `local` backend |
| `MOCKWA_S3_BUCKET` | *(required with `s3`)* | Bucket the media objects live in; whaloc never creates it |
| `MOCKWA_S3_REGION` | *(required with `s3`)* | Region; any value satisfies RustFS, but the SDK insists on one |
| `MOCKWA_S3_ENDPOINT` | *(unset → AWS S3)* | Endpoint of an S3-compatible server (RustFS, R2, Ceph) |
| `MOCKWA_S3_ACCESS_KEY_ID` | *(unset → SDK default chain)* | Access key; all-or-nothing with the secret below |
| `MOCKWA_S3_SECRET_ACCESS_KEY` | *(unset → SDK default chain)* | Secret key |
| `MOCKWA_S3_FORCE_PATH_STYLE` | `true` when an endpoint is set | Path-style addressing (`<endpoint>/<bucket>/<key>`) |
| `MOCKWA_WEB_DIR` | `packages/web/dist` beside the server | Built web UI served at `/`; an absent directory just leaves `/` unrouted (dev runs the UI under Vite) |
| `MOCKWA_LOG_LEVEL` | `info` | pino level |

## 8. Architecture & repo layout

npm workspace, three packages:

```
packages/
  shared/   # zod schemas + TS types for the control-plane API and WS events (imported by server & web)
  server/   # Hono app
    src/
      config/        # env parsing (zod), typed AppConfig
      logging/       # pino setup, request logging middleware
      db/            # kysely + node:sqlite dialect, migrations, repositories
      storage/       # MediaStorage interface + local-dir implementation
      domain/        # services: messages, templates, media, contacts, statuses (ladder scheduler),
                     # webhook-emitter, id generators (wamid/media/template/fbtrace), meta-json (unicode-escaping serializer + HMAC)
      graph-api/     # Hono routers mirroring Meta (routes → zod validation → domain services), meta error helpers
      control-api/   # /api routes + WS hub
      app.ts         # compose the two Hono apps: Graph (8888) and console (8025, + static UI)
      main.ts        # entry: config → logger → db → apps → listen on both ports
  web/      # React 19 + Vite + react-router; pure CSS (no Tailwind); clsx where useful
```

`npm run dev` runs the server watcher and Vite side by side through `concurrently` (npm itself
has no --parallel).

**Separation of concerns is non-negotiable**: routes do parsing/validation/HTTP mapping only; domain services hold behavior and never import Hono; repositories own SQL; the WS hub and webhook emitter are injected into services (constructor injection, plain classes/factories — no DI framework). Everything with behavior gets unit tests (vitest); the Graph routes get integration tests through `app.request()` (Hono's built-in test client) asserting exact Meta envelopes, plus webhook-delivery tests against a local capture server.

**Error handling**: one error hierarchy in the domain (`GraphApiError` carrying code/subcode/http status/details) mapped to the Meta envelope in a single Hono `onError`; control-plane errors use a plain `{error:{message,code}}` shape. Never leak stack traces in responses; always log with pino (`err` serializer), include a request ID (`x-fb-request-id`-style) in Graph responses and logs.

### Web UI shell & routes

whaloc holds several WABAs and several numbers at runtime, so the UI's frame is a **single top bar** — brand, scope, view tabs, live indicators — over full-width content. There is no sidebar.

The scope is a **breadcrumb whose depth follows the view**, and it lives in the URL:

| View      | Scope           | Route                                                            |
| --------- | --------------- | ---------------------------------------------------------------- |
| Chats     | WABA ▾ / number ▾ | `/w/:wabaId/p/:phoneNumberId/chats[/:contactWaId]`, and `/w/:wabaId/chats` for an account with no number yet |
| Templates | WABA ▾          | `/w/:wabaId/templates`                                             |
| Webhooks  | none            | `/webhooks`                                                        |
| Settings  | none            | `/settings`                                                        |

A conversation is named by its **contact**, not by the derived `<phoneNumberId>:<waId>` ID: the number is already a segment above it, and a contact that changes number moves within the same path.

The URL is the **single source of truth**. One gate resolves the path's IDs against `GET /api/state` before a view renders, then announces the result to the store; the reducer heals the store the same way through the same pure `resolveScope`, so a `waba.changed`/`phone_number.changed` deletion cannot leave the two disagreeing. Rules:

- `/`, a bare `/chats` or `/templates`, and anything unrecognised → the scope this browser used last (`localStorage`, best-effort) else the first WABA that has a number. An old-style `/chats/<phoneNumberId>:<waId>` link is carried into its scope rather than dropped.
- A path naming a WABA or a number that is gone → the closest scope that exists, plus a toast. A number that exists under a *different* account repairs the account rather than the number.
- No WABA at all → every scoped tab is disabled and the content offers "Create your first WABA"; a WABA with no number → the Chats view offers to add one. Both open the same dialogs Settings uses.

### Runtime & tooling

- **Node 24 (LTS)**, TypeScript run natively: dev = `node --watch --experimental-transform-types --disable-warning=ExperimentalWarning src/main.ts`; prod = `tsc -p tsconfig.build.json` → plain `node dist/main.js`.
- Package manager: **npm** — the one bundled with Node 24, so a clone needs nothing installed first. No `packageManager` pin (and no corepack); `engines` states the floor (`node >=24.0.0`, `npm >=11.0.0`) and the root manifest lists the three workspaces in dependency order, since npm runs workspace scripts in that order rather than topologically.
- **Hono** + `@hono/node-server` (its v2 `upgradeWebSocket` over a `noServer` `ws` server handles `/api/ws`, so `@hono/node-ws` — still pinned to node-server v1 — is not used); request bodies are validated by parsing them with the zod schemas directly.
- **zod v4**, **pino** (JSON-only — pipe through `npx pino-pretty` for colors), **kysely**, **vitest v4**, **eslint flat config + prettier**: `strictTypeChecked` + `eslint-plugin-unicorn` (all) + prettier; `.prettierrc`: tabs, width 120, double quotes, `arrowParens:"avoid"`, `trailingComma:"all"`. tsconfig: `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `rewriteRelativeImportExtensions` (relative imports carry `.ts`), `isolatedModules`, `erasableSyntaxOnly` (no enums/namespaces — required for Node type stripping).
- React UI: React 19, react-router, plain CSS (CSS custom properties for theming; light+dark). Vite dev server proxies `/api`, `/api/ws` and `/whaloc-media` to the console port, and `/v25.0` to the Graph port.
- CI: GitHub Actions — install, lint, typecheck, test, build (all packages), docker build. Image published to `ghcr.io/dgadelha/whaloc`.

### Docker

Multi-stage: build stage (`npm ci`, build shared+server+web) → a deps stage that reruns `npm ci --omit=dev` scoped to the server workspace → runtime stage on `node:24-alpine`, non-root user, only prod deps + `dist` + web static; `EXPOSE 8888 8025`; `HEALTHCHECK` on `/health` of **both** ports (either one down is unhealthy); `VOLUME /data`. Target image well under 300 MB. Dev mode has no login, so the documented `docker run` publishes both ports to loopback only: `docker run -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 <image>`.

### Compose integration (documentation deliverable)

An application under test and mockwa, side by side — the whole shape of an integration (`docs/integrating.md` is the long form):

```yaml
services:
  app:
    build: .
    environment:
      # The version segment is mandatory: consumers append `/{id}` to this base URL.
      GRAPH_API_BASE_URL: http://mockwa:8888/v25.0
      META_APP_SECRET: dev-app-secret         # = MOCKWA_APP_SECRET
      META_WEBHOOK_VERIFY_TOKEN: dev-verify-token # = MOCKWA_WEBHOOK_VERIFY_TOKEN

  mockwa:
    image: ghcr.io/loongest/mockwa:latest
    # Loopback only: the console has no login in dev mode.
    ports: ["127.0.0.1:8025:8025"]
    environment:
      # Reachable from whoever downloads media — inside the compose network, not the host.
      MOCKWA_PUBLIC_URL: http://mockwa:8888
      MOCKWA_WEBHOOK_URL: http://app:3001/meta-webhooks
      MOCKWA_APP_SECRET: dev-app-secret
      MOCKWA_WEBHOOK_VERIFY_TOKEN: dev-verify-token
```

Three values have to agree across the pair — the app secret, the verify token and the webhook URL — and the fourth, `GRAPH_API_BASE_URL`, has to carry its version segment and name the Graph port (8888), never the console port. Everything else is independent.

---

## 9. Out of scope

**Flows** (WhatsApp Flows) are not emulated, and nothing else in this document is aspirational: everything the sections above describe is implemented.

*(Some of it arrived after the first release — phone number management (`POST /{waba}/phone_numbers`, register/verify, multi-WABA management at runtime: §2 rows 13–17, the ladder in §4, the control-plane list in §5), read receipts and typing indicators (§2 row 18, §4), the business profile and `subscribed_apps` (§2 rows 19–20), the template list filters with the `before` cursor (§2 row 8), error simulation (the strict token registry, the injection rules and the media TTL: §1.9 and §4), identity simulation (BSUIDs and the `user_changed_number` system event: §1.15 and the contact routes in §5), the S3-compatible media backend (`MOCKWA_MEDIA_BACKEND`, §6–§7), state export/import (`GET /api/export`, `POST /api/import`, §5), and the batch that closed the remaining Meta gaps — media deletion (§2.6b), the Resumable Upload API and the handles it feeds to templates and business profiles (§2.21–§2.22), `biz_opaque_callback_data` (§2.5), the inbound context riders and the `unsupported` type (§5), and the two account-level webhooks (§3) — which is why those sections read as additions to a smaller core.)*



## Production Compatibility Principle

mockwa must maximize compatibility with the official Meta WhatsApp Business Cloud API.

The primary objective is to allow applications developed and tested against mockwa to migrate to the official Meta Cloud API with minimal application-code changes.

Requirements:

- Preserve official request and response structures for supported endpoints.
- Preserve webhook payload formats, signature verification and relevant event semantics.
- Simulate message templates, conversation windows, delivery states and common API errors accurately.
- Use official Meta documentation and verified fixtures as the source of truth.
- Keep simulator-only operations on a separate Control API, never mixed into the Meta-compatible Graph API.
- Document all known compatibility gaps explicitly.
- Include contract tests to detect regressions in Meta API compatibility.

**Acceptance target:** A reference application must be able to switch between mockwa and the official Meta Cloud API using configuration changes, subject to actual Meta account setup, approved templates and production-specific requirements.

Do not implement Workbench-specific or GotUnit-specific behavior inside mockwa.