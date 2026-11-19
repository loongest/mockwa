# Workbench → mockwa

How to point Workbench's WhatsApp OTP sender at mockwa instead of Meta. This is configuration
only: no Workbench code changes are needed for the send path, and none are part of this guide.
Real connection testing against Workbench is a later, separate step.

All values below are **test placeholders**. Never put a real Meta access token in a mockwa
setup: mockwa accepts any non-empty token.

## What Workbench sends

Workbench calls `POST {base-url}/{api-version}/{phone-number-id}/messages` with a bearer token and
an approved template that has **one body text parameter**, the code:

```json
{
	"messaging_product": "whatsapp",
	"recipient_type": "individual",
	"to": "<destination>",
	"type": "template",
	"template": {
		"name": "workbench_otp",
		"language": { "code": "en" },
		"components": [{ "type": "body", "parameters": [{ "type": "text", "text": "123456" }] }]
	}
}
```

It does not receive webhooks, so mockwa's webhook settings can stay unset.

## 0. Get an image that has this guide's features

Images are published only from a `v*` release tag, and no release containing M5 (the Requests
view this guide uses) exists yet, so do not assume `ghcr.io/loongest/mockwa:latest` has it. Build
the image from a mockwa checkout and use the local tag (while reviewing, the review image you were given works
in its place):

```sh
git clone https://github.com/loongest/mockwa.git && cd mockwa
docker build -t mockwa:local .
```

Run the commands below from that checkout, because they mount a seed file from it. Once a
release that includes M5 is published, `ghcr.io/loongest/mockwa:<version>` can replace
`mockwa:local`.

## 1. Start mockwa with a matching template

mockwa only sends a template it knows, by **name + language**, with the **same number of
parameters**. The default seed's `hello_whaloc` takes none, so start mockwa with
[`examples/integrations/workbench-seed.json`](../../examples/integrations/workbench-seed.json):
it keeps the default WABA and phone number (so the IDs below stay the same) and adds
`workbench_otp` / `en` with one positional `{{1}}`, plus a test contact `60123000001`.

```sh
docker run --rm --name mockwa-workbench -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -v "$PWD/examples/integrations/workbench-seed.json:/seed.json:ro" \
  -e MOCKWA_SEED_FILE=/seed.json \
  mockwa:local
```

The template's category is `AUTHENTICATION` to match production; mockwa only uses the category as
a label, so it does not change how the send is checked.

## 2. Workbench environment

| Variable                               | Value for mockwa                                        |
| -------------------------------------- | ------------------------------------------------------- |
| `WORKBENCH_OTP_WHATSAPP_ENABLED`       | `true`                                                  |
| `WORKBENCH_OTP_WHATSAPP_BASE_URL`      | `http://localhost:8888` (in compose: `http://mockwa:8888`) — **no** version here |
| `WORKBENCH_OTP_WHATSAPP_API_VERSION`   | `v21.0` (any `vNN.N` works; mockwa answers every version) |
| `WORKBENCH_OTP_WHATSAPP_PHONE_NUMBER_ID` | `573542517421694`                                     |
| `WORKBENCH_OTP_WHATSAPP_ACCESS_TOKEN`  | `test-workbench-token` (any non-empty placeholder)      |
| `WORKBENCH_OTP_WHATSAPP_TEMPLATE_NAME` | `workbench_otp`                                         |
| `WORKBENCH_OTP_WHATSAPP_TEMPLATE_LANGUAGE` | `en`                                                |

Use the **Graph port, 8888**. Port 8025 is the console; Workbench never calls it.

## 3. Check it

1. Trigger an OTP in Workbench.
2. Open <http://localhost:8025/requests>: the `POST /v21.0/573542517421694/messages` call is there
   with its status, the token masked, and the body Workbench sent.
3. Open **Chats**: the template message is in the conversation with the recipient, and the
   **Open phone** link shows it from the user's side.

What a failure looks like, so you know where to look:

| Symptom in Requests                    | Cause                                                                 |
| -------------------------------------- | --------------------------------------------------------------------- |
| `400`, error code `132001`             | template name or language does not match the seed                     |
| `400`, error code `132000`             | parameter count does not match the template's `{{n}}` placeholders    |
| `400`, error code `100`                | the phone number ID is wrong                                          |
| nothing logged                         | Workbench is calling the wrong host or port (8025 instead of 8888)    |

## Work left on the Workbench side

- Point the environment above at mockwa in Workbench's dev or test profile.
- Seed the recipient Workbench will use, or use any number: a template is sent whether or not the
  contact has written before.
- Workbench's read timeout is 5 s; mockwa answers a send right away, so it is not a concern.
- Real end-to-end testing with Workbench is a later step.
