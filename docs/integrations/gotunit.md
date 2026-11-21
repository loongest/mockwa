# GotUnit → WaSandbox

How to point GotUnit's WhatsApp OTP sender at WaSandbox instead of Meta. This is configuration only:
no GotUnit code changes are needed for the send path, and none are part of this guide. Real
connection testing against GotUnit is a later, separate step.

All values below are **test placeholders**. Never put a real Meta access token in a WaSandbox
setup: WaSandbox accepts any non-empty token.

## What GotUnit sends

GotUnit calls `POST {base-url}/{api-version}/{phone-number-id}/messages` with a bearer token and a
template. The recipient is a Malaysian number in E.164 without the `+` (for example
`60123000001`). The body parameters depend on `WABA_TEMPLATE_MODE`:

| Mode              | Template (default name / language)                     | Body parameters                   |
| ----------------- | ------------------------------------------------------ | --------------------------------- |
| `PRODUCTION_AUTH` | `ren_otp` / `en_US`                                    | 1: the code                       |
| `META_TEST`       | `jaspers_market_order_confirmation_v1` / `en_US`       | 3: `GotUnit`, the code, a date    |

With `WABA_PROVIDER=meta-test` (or `META_TEST` mode) every send goes to `TEST_NUMBER` instead of
the requested recipient. GotUnit does not receive webhooks, so WaSandbox's webhook settings can stay
unset.

## 0. Get an image that has this guide's features

Images are published only from a `v*` release tag, and no release containing M5 (the Requests
view this guide uses) exists yet, so do not assume `ghcr.io/loongest/wasandbox:latest` has it. Build
the image from a WaSandbox checkout and use the local tag (while reviewing, the review image you were given works
in its place):

```sh
git clone https://github.com/loongest/wasandbox.git && cd wasandbox
docker build -t wasandbox:local .
```

Run the commands below from that checkout, because they mount a seed file from it. Once a
release that includes M5 is published, `ghcr.io/loongest/wasandbox:<version>` can replace
`wasandbox:local`.

## 1. Start WaSandbox with matching templates

WaSandbox only sends a template it knows, by **name + language**, with the **same number of
parameters**. Start it with
[`examples/integrations/gotunit-seed.json`](../../examples/integrations/gotunit-seed.json): it
keeps the default WABA and phone number (so the IDs below stay the same) and adds both templates
above with positional `{{n}}` placeholders, plus a test contact `60123000001`.

```sh
docker run --rm --name wasandbox-gotunit -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -v "$PWD/examples/integrations/gotunit-seed.json:/seed.json:ro" \
  -e WASANDBOX_SEED_FILE=/seed.json \
  wasandbox:local
```

`ren_otp` is seeded as `AUTHENTICATION` to match production; WaSandbox only uses the category as a
label, so it does not change how the send is checked.

## 2. GotUnit environment

| Variable                 | Value for WaSandbox                                                   |
| ------------------------ | ------------------------------------------------------------------ |
| `WABA_PROVIDER`          | `meta` (or `meta-test` to send everything to `TEST_NUMBER`)        |
| `WABA_API_BASE_URL`      | `http://localhost:8888` (in compose: `http://wasandbox:8888`) — **no** version here |
| `WABA_API_VERSION`       | `v25.0`                                                            |
| `WABA_PHONE_NUMBER_ID`   | `573542517421694`                                                  |
| `WABA_ACCESS_TOKEN`      | `test-gotunit-token` (any non-empty placeholder)                   |
| `TEST_NUMBER`            | `+60123000001` (only used by `meta-test` / `META_TEST`)            |
| `WABA_TEMPLATE_MODE`     | `PRODUCTION_AUTH` (or `META_TEST`)                                 |
| `WABA_TEMPLATE_NAME`     | `ren_otp` (or `jaspers_market_order_confirmation_v1`)              |
| `WABA_TEMPLATE_LANGUAGE` | `en_US`                                                            |

Use the **Graph port, 8888**. Port 8025 is the console; GotUnit never calls it.

## 3. Check it

1. Trigger an OTP in GotUnit.
2. Open <http://localhost:8025/requests>: the `POST /v25.0/573542517421694/messages` call is there
   with its status, the token masked, and the body GotUnit sent.
3. Open **Chats**: the template message is in the conversation with the recipient, and the
   **Open phone** link shows it from the user's side.

What a failure looks like, so you know where to look:

| Symptom in Requests        | Cause                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| `400`, error code `132001` | template name or language does not match the seed                  |
| `400`, error code `132000` | parameter count does not match the template (check the mode)       |
| `400`, error code `100`    | the phone number ID is wrong                                       |
| nothing logged             | GotUnit is calling the wrong host or port (8025 instead of 8888)   |

GotUnit logs a rejected send with `httpStatus`, `metaErrorCode` and `metaErrorSubcode`; they are
the same values the Requests view shows.

## Work left on the GotUnit side

- Point the environment above at WaSandbox in GotUnit's dev profile.
- Keep `WABA_TEMPLATE_MODE` and `WABA_TEMPLATE_NAME` in step: the mode decides how many
  parameters are sent, the name decides which template has to accept them.
- Real end-to-end testing with GotUnit is a later step.
