# Pointing an app at mockwa

Connecting an app to mockwa takes two settings that agree with each other. This page used to hold
the whole guide; its parts now live on the pages below.

## The short version

1. **Your app calls mockwa** instead of `graph.facebook.com`: set its Graph base URL to mockwa's
   Graph port **with a version segment**, such as `http://mockwa:8888/v25.0`.
2. **mockwa calls your app**: set `MOCKWA_WEBHOOK_URL` to your receiver, and `MOCKWA_APP_SECRET`
   and `MOCKWA_WEBHOOK_VERIFY_TOKEN` to the values your receiver uses.
3. **Check it**: send a message as a user, then read **Requests** and **Webhooks** in the console.

Everything else your app does (replying, reacting, reading) is driven from the console or from
tests through `/api` on port 8025. Your app only ever knows port 8888.

## Where each part is now

| You want                                                                                   | Read                                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| A Compose file with mockwa next to your app, and which value matches which                 | [Getting started → Connect your own app](getting-started.md#connect-your-own-app)       |
| A first round trip, step by step, with expected results                                    | [Getting started](getting-started.md#do-a-first-round-trip)                             |
| The seeded IDs (WABA `666635535888644`, number `573542517421694`, template `hello_whaloc`) | [Configuration → The default seed](configuration.md#the-default-seed)                   |
| The handshake, signatures, several apps, retries                                           | [Webhooks](webhooks.md)                                                                 |
| Media downloads, `MOCKWA_PUBLIC_URL`, handles, the registration ladder                     | [API reference → How the Graph API behaves](api-reference.md#how-the-graph-api-behaves) |
| What survives a restart, a reset or an import                                              | [Configuration → What survives what](configuration.md#what-survives-what)               |
| The 24-hour window, rate limits, injected errors, the clock                                | [Testing your app](testing.md)                                                          |
| What the Requests and Webhooks pages show                                                  | [Using the console](usage.md)                                                           |
| Setting up Workbench or GotUnit                                                            | [Workbench](integrations/workbench.md), [GotUnit](integrations/gotunit.md)              |

## Compatibility notes

- **Any Graph version works.** mockwa serves the same routes under every `/v<major>.<minor>`, so
  use the version your app uses with Meta.
- **The access token is not checked** unless `MOCKWA_TOKENS` is set (required in public mode).
- **The seeded IDs are a contract.** They are the same on every machine, after every reset and
  across versions; a change to them would be deliberate and documented. A template is matched by
  **name and language**, so the seeded `hello_whaloc` (`en`, no parameters) only fits an app that
  sends exactly that. Workbench and GotUnit need their own seed files.
- **A stale image looks like missing data.** The default seed is built into the image, so an old
  image can answer `132001` for the seeded template, or `400` / `100` / `33` for a seeded ID. If
  seeded entities seem to be gone, rebuild the image first.
- **mockwa does not reply for your app.** Without an app that answers webhooks, a user's message
  is stored and shown, and nothing comes back.
