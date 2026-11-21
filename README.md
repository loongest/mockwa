# WaSandbox

[![CI](https://github.com/loongest/wasandbox/actions/workflows/ci.yml/badge.svg)](https://github.com/loongest/wasandbox/actions/workflows/ci.yml)
[![Docker](https://github.com/loongest/wasandbox/actions/workflows/docker.yml/badge.svg)](https://github.com/loongest/wasandbox/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

WaSandbox is a local simulator of the **Meta WhatsApp Cloud API** (Graph API v25.0). Your app talks
to it instead of `graph.facebook.com`, and it talks back to your app the way Meta does. You can
build and test a WhatsApp integration with no Meta app, no business number and no public tunnel.

## What it does

WaSandbox plays Meta's side of the integration for the parts of the Cloud API it supports, in one
Docker image:

- **The Graph API calls a typical integration makes**: sending the common message types, media,
  templates, phone numbers, the business profile and `subscribed_apps`, with Meta's envelopes
  and error codes. [API reference](docs/api-reference.md) lists exactly what is covered;
  anything else is not served.
- **Signed webhooks back to your app**: inbound messages, statuses and template events, signed
  with `X-Hub-Signature-256` over the exact bytes sent. Failed deliveries are retried for up to
  7 days, as on Meta, on a schedule of WaSandbox's own.
- **A virtual phone** where you are the WhatsApp user: chat with your app as one or more people.
- **A console** to watch and steer it all: chats, templates, the webhook log, every Graph request
  your app made, and a clock you can move.
- **Test tools**: a virtual clock, deterministic error injection, Meta's sending rules, and
  scenario files you can run from CI.

It is **deterministic by default**: nothing fails or changes state by chance, and every failure
is one you asked for. A run repeats exactly when its inputs do: the same seed, the same steps in
the same order, the virtual clock (on the real clock, IDs and times differ), and an app under
test that behaves the same way.

## Why use it

- Test sends, replies, read receipts and failures without touching production or a shared sandbox.
- Reproduce edge cases on purpose: an expired token, a rate limit, a rejected template, a closed
  24-hour window, a user who changed number.
- Run the whole path offline in CI, with the same seeded IDs on every machine.

WaSandbox is a simulator, not Meta. Where it has to invent behavior Meta does not document, it says
so; see [Differences from the real Meta Cloud API](docs/SPEC.md#differences-from-the-real-meta-cloud-api).

## Two ports

| Port   | Who uses it | What is there                                        |
| ------ | ----------- | ---------------------------------------------------- |
| `8888` | Your app    | The Graph API (`/v25.0/…`) and media bytes           |
| `8025` | You, tests  | The console, the virtual phone, `/api` and `/api/ws` |

Your app should only ever call 8888.

## Where to read next

| I want to…                                        | Read                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Start an instance and do a first send and receive | [Getting started](docs/getting-started.md)                       |
| Set ports, seeds, storage, tokens or limits       | [Configuration](docs/configuration.md)                           |
| Find my way around the console and the phone      | [Using the console](docs/usage.md)                               |
| Test my own app: clock, errors, scenarios         | [Testing your app](docs/testing.md)                              |
| Look up a route, a port or how auth works         | [API reference](docs/api-reference.md)                           |
| Connect my webhook receiver                       | [Webhooks](docs/webhooks.md)                                     |
| Run a public demo behind HTTPS                    | [Deployment](docs/deployment.md), [access rules](docs/access.md) |
| Work on WaSandbox itself                          | [Development](docs/development.md)                               |
| Know exactly how it must behave                   | [SPEC](docs/SPEC.md), the behavioral contract                    |

## Relation to whaloc

WaSandbox is a fork of [whaloc](https://github.com/dgadelha/whaloc) by Douglas Gadêlha. It keeps
whaloc's engine and adds what a simulator needs: two ports, the virtual phone, several apps with
webhook retries, Meta's sending rules, a virtual clock, scenarios, a public demo mode and its
hardening. The code still says "whaloc" in many places. The project was called mockwa before
WaSandbox: every `MOCKWA_*` and `WHALOC_*` variable is still read as an alias of its
`WASANDBOX_*` name, and the container keeps a `mockwa` command next to `wasandbox`.

## Acknowledgments

The engine, the Meta fixtures, the signing and the console are whaloc's work, and its copyright
notice stays in [LICENSE](LICENSE).

whaloc owes its shape to [fdarian/whap](https://github.com/fdarian/whap), an MIT-licensed
WhatsApp Cloud API mock that got there first: the split between a control plane and a UI that
is a pure client of it, the WebSocket event bus, and its approach to `X-Hub-Signature-256`.
Meta escapes every code point above U+007F as `\uXXXX` before hashing, and signs exactly the
bytes it sends. whaloc's `packages/server/src/domain/meta-json.ts` is a port of whap's
`src/server/middleware/hmac-signature.ts`, and whap's test vectors are carried over unchanged.
Thanks to [@fdarian](https://github.com/fdarian).

## License

[MIT](LICENSE). The WhatsApp Cloud API is Meta's; WaSandbox is an independent reimplementation for
local development, not affiliated with or endorsed by Meta. The specs vendored under
`docs/meta-openapi/` are Meta's own, published under the
[Meta Platform Terms](https://developers.facebook.com/terms) and kept for reference; the MIT
license covers WaSandbox's code and documentation, not them.
