# Access inventory

Who may reach what on a mockwa instance, route by route. This is the reference for public demo
mode (`MOCKWA_MODE=public`, [SPEC §5](SPEC.md#public-demo-mode-m6)) and the starting point for the
broader hardening review planned for M7. When a route is added, it goes in this table in the same
change; `packages/server/src/control-api/access.ts` (`audienceOf`) is the code that enforces it.

## Audiences

| Audience           | Who                                                                    | Credential                                                                                                       |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **App under test** | The application being tested, server to server                         | A bearer token from `MOCKWA_TOKENS`, on the Graph listener only. Public mode requires the registry               |
| **Admin**          | The person running the instance                                        | `Authorization: Bearer <MOCKWA_ADMIN_TOKEN>`, or the `mockwa_admin` cookie from signing in at `/admin`           |
| **Visitor**        | An anonymous browser using the public Virtual Phone                    | The `mockwa_visitor` cookie (HttpOnly) plus the `X-CSRF-Token` header on every write, from the listener's origin |
| **Open**           | Anyone: health checks, the sign-in page, the phone's mode probe        | None                                                                                                             |

In **dev mode** (the default) nothing below is gated unless `MOCKWA_ADMIN_TOKEN` is set: then
every console-listener path that is not *open* needs the admin, the developer phone included.
In **public mode** the visitor paths are open to sessions, and everything else on the console
listener is the admin's.

## Console listener (`MOCKWA_CONSOLE_PORT`, 8025)

| Path                                                            | Methods             | Dev mode           | Public mode                                       | Notes                                                                                       |
| --------------------------------------------------------------- | ------------------- | ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/health`, `/api/health`                                        | GET                 | open               | open                                              | Docker HEALTHCHECK                                                                          |
| `/admin`                                                        | GET                 | open (with token)  | open                                              | No-script sign-in form; strict CSP. Only mounted when an admin token is set                 |
| `/api/admin/login`, `/api/admin/logout`                         | POST                | open (with token)  | open                                              | Same-origin form or JSON; sets / clears `mockwa_admin` (12 h, in memory)                    |
| `/api/phone/config`                                             | GET                 | open               | open                                              | `{data:{mode}}`, so the phone page knows which flow to show                                 |
| `/api/public/session`                                           | GET, POST, DELETE   | not mounted (404†) | visitor                                           | Start (origin-checked), read, leave (CSRF)                                                  |
| `/api/phone/identities`                                         | GET                 | admin†             | visitor: own identities only                      |                                                                                             |
| `/api/phone/clock`                                              | GET                 | admin†             | visitor                                           | The instance clock (always real in public mode)                                             |
| `/api/phone/identities/:waId/chats`                             | GET                 | admin†             | visitor, `:waId` must be the session's            | Otherwise 404 `unknown_contact`                                                             |
| `/api/phone/identities/:waId/chats/:phoneNumberId/messages`     | GET, POST           | admin†             | visitor, own `:waId`; CSRF on POST                | POST: text, image, document, interactive, button, location, reaction only                   |
| `/api/phone/identities/:waId/chats/:phoneNumberId/read`         | POST                | admin†             | visitor, own `:waId`; CSRF                        |                                                                                             |
| `/api/phone/identities/:waId/chats/:phoneNumberId/media`        | POST                | admin†             | visitor, own `:waId`; CSRF; size, type, count     | Multipart `file`; JPEG, PNG, WebP or PDF by content, not by name                            |
| `/api/phone/identities/:waId/media/:mediaId`                    | GET                 | admin†             | visitor, own `:waId`; only media it may see       | Answers a relative `/whaloc-media/…` URL                                                    |
| `/api/phone/identities/:waId/ws`                                | GET (upgrade)       | admin†             | visitor, own `:waId`; Origin required; 8 per session | Own `message.*`, `typing.changed`, `contact.changed` only. Closed with 4401 when the session ends |
| `/phone`, `/phone/*`, the phone bundle's assets                   | GET                 | admin†             | visitor (no session needed to load the page)      | Assets from the Vite manifest closure of `phone.html`; strict CSP on the page               |
| `/whaloc-media/:token`                                          | GET                 | admin†             | visitor: own uploads and media in own chats only  | `Content-Security-Policy: default-src 'none'; sandbox`, `nosniff`, `no-store`               |
| `/whaloc-uploads/:token`                                        | GET                 | admin†             | admin                                             |                                                                                             |
| `/`, console routes, the console bundle, `/.vite/*`             | GET                 | admin†             | admin; **404** without                            | The admin bundle is never served to a visitor                                               |
| `/api/ws`                                                       | GET (upgrade)       | admin†             | admin; **401** without                            | The unrestricted stream                                                                     |
| every other `/api/*`                                            | all                 | admin†             | admin; **401** without                            | State, export, import, reset, contacts, conversations, inbound, media, templates, request log, webhook log, apps, tokens, injection and messaging rules, clock, scenarios, WABAs, phone numbers |

† In dev mode "admin" means: open when no `MOCKWA_ADMIN_TOKEN` is set (the M0–M5 behaviour),
gated by it when one is. A signed-in (cookie) admin may only write, or open a socket, from the
listener's own origin or `MOCKWA_ALLOWED_ORIGINS`; a bearer-token request is a script and has no
origin to check.

## Graph listener (`MOCKWA_GRAPH_PORT`, 8888)

| Path                         | Who                                        | Public-mode difference                                                                                        |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `/v{major}.{minor}/*`        | App under test (bearer token)              | Only `MOCKWA_TOKENS` pass (required at boot). `override_callback_uri` and `webhook_configuration` URLs are refused (400): webhook destinations come from configuration |
| `/whaloc-media/:token`       | Whoever holds the URL                      | None. The token is the credential; a visitor only ever learns the tokens of media it may see                  |
| `/whaloc-uploads/:token`     | Whoever holds the URL                      | None                                                                                                          |
| `/health`                    | open                                       | None                                                                                                          |

The console listener serves no Graph route and the Graph listener serves no console route; each
answers 404 for the other's paths.

## Webhook destinations

Outbound webhooks go only to URLs from configuration: `MOCKWA_WEBHOOK_URL` and the apps in
`MOCKWA_APPS`. In public mode nothing at runtime may introduce another URL — not the Graph
overrides, and not the control plane, admin included (`POST /api/apps` with a `callbackUrl`,
`PATCH /api/apps/:key` setting one, a subscription or phone-number override, or a handshake
against an arbitrary URL answer `403 webhook_destinations_locked`). Visitors never see a URL.

## Refusals a visitor can meet

| Status | `error.code`                                                                                  | When                                                                                         |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`, `unsupported_type`                                                         | A body that does not validate, text over 4096 characters, a message type a demo phone does not send |
| 401    | `session_required`, `session_expired`                                                         | No session, or one that ended (idle TTL, left, reset, import)                                |
| 403    | `origin_refused`, `csrf_failed`                                                               | A write or socket from another origin, without `Origin`, or without the session's CSRF token |
| 404    | `unknown_contact`, `unknown_message`, `unknown_media`                                         | Any identity, message or media that is not the session's — never "forbidden", so nothing is confirmed to exist |
| 413    | `media_too_large`                                                                             | An upload over `MOCKWA_PUBLIC_MEDIA_MAX_BYTES`                                               |
| 415    | `unsupported_media_type`                                                                      | Not a JPEG, PNG, WebP or PDF by its bytes                                                    |
| 429    | `message_rate_limited`, `media_quota_exceeded`, `session_rate_limited`, `session_quota_exceeded`, `demo_full`, `socket_quota_exceeded` | A limit; `Retry-After` (seconds) when waiting helps                       |

## Known limits of this boundary (for M7)

- Rate-limit windows and admin cookie sessions live in memory: a restart resets the windows and
  signs admins out. Visitor sessions are in SQLite and survive a restart.
- The per-address limits rely on the socket peer address, or `X-Forwarded-For` from an exact
  address in `MOCKWA_TRUSTED_PROXIES`. Without the right proxy entry every visitor behind a proxy
  shares one address.
- There is no TLS termination in mockwa; HTTPS (and `Secure` cookies under `auto`) comes from a
  trusted proxy's `X-Forwarded-Proto`, or `MOCKWA_COOKIE_SECURE=always`.
- A 200-visitor load test, a CSP for the admin console, and audit logging are M7 work.
