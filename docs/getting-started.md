# Getting started

Start a local mockwa, send a message as a WhatsApp user, watch an app answer, and send one back
as the app. It takes about ten minutes, most of it the first image build.

**On this page:** [Before you start](#before-you-start) · [Get an image](#get-an-image) ·
[Do a first round trip](#do-a-first-round-trip) · [Look at it in the browser](#look-at-it-in-the-browser) ·
[Send as your app](#send-as-your-app) · [Clean up](#clean-up) ·
[Connect your own app](#connect-your-own-app) · [If something is wrong](#if-something-is-wrong)

## Before you start

You need:

- Docker.
- A checkout of this repository: `git clone https://github.com/loongest/mockwa.git && cd mockwa`.
- Free host ports 8888, 8025 and 3001 (check with `lsof -i :8888 -i :8025 -i :3001`, which prints
  nothing when they are free). If one is taken, change the left side of its `-p` below (for
  example `-p 127.0.0.1:18888:8888`) and use that port in every URL on this page.
- No containers or network already named `mockwa-quickstart…`; this page creates and later
  removes exactly those.

Run every command from the root of the checkout.

## Get an image

Images are published only when a `v*` release tag is pushed, so do not assume
`ghcr.io/loongest/mockwa:latest` exists or has the features described here. Build the image from
your checkout:

```sh
docker build -t mockwa:local .
```

Expected result: the build finishes without an error, and `docker image ls mockwa` lists the
`local` tag. Once a release
you want is published, `ghcr.io/loongest/mockwa:<version>` works in place of `mockwa:local`.

## Do a first round trip

mockwa never answers a message by itself. Every reply comes from an app that receives the
webhook and calls the Graph API. Here that app is [`examples/echo-app`](../examples/echo-app/server.mjs),
which replies `echo: <your text>`.

1. Create a network so the two containers can reach each other by name:

   ```sh
   docker network create mockwa-quickstart
   ```

2. Start the example app. It checks every webhook signature with `APP_SECRET` and replies through
   mockwa's Graph port. Its port 3001 is also published on `127.0.0.1`, so you can make it fail on
   purpose later ([Webhooks → Retries](webhooks.md#retries)):

   ```sh
   docker run -d --name mockwa-quickstart-echo --network mockwa-quickstart \
     -p 127.0.0.1:3001:3001 -v "$PWD/examples/echo-app:/app:ro" -w /app \
     -e PORT=3001 -e APP_SECRET=dev-app-secret -e VERIFY_TOKEN=dev-verify-token \
     -e GRAPH_API_BASE_URL=http://mockwa-quickstart:8888/v25.0 \
     node:24-alpine node server.mjs
   ```

3. Start mockwa, pointing its webhooks at the app. The secret and verify token must be the same
   values the app uses:

   ```sh
   docker run -d --name mockwa-quickstart --network mockwa-quickstart \
     -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
     -e MOCKWA_WEBHOOK_URL=http://mockwa-quickstart-echo:3001/webhook \
     -e MOCKWA_APP_SECRET=dev-app-secret \
     -e MOCKWA_WEBHOOK_VERIFY_TOKEN=dev-verify-token \
     -e MOCKWA_VERIFY_ON_START=true \
     mockwa:local
   ```

4. Check that it is up and that the app accepted the webhook handshake:

   ```sh
   curl -s http://localhost:8888/health
   docker logs mockwa-quickstart 2>&1 | grep -E "seed applied|handshake"
   ```

   Expected result: `{"status":"ok",…}`, a `seed applied` line with the IDs below, and
   `webhook handshake succeeded`.

5. Send a message as the seeded contact Ana. This is what a WhatsApp user does; it goes to the
   console port (8025):

   ```sh
   curl -s -X POST http://localhost:8025/api/inbound -H 'Content-Type: application/json' \
     -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"hello"}}'
   ```

   Expected result: `201` with the stored message (`"direction":"inbound"`).

6. A moment later, read the conversation:

   ```sh
   curl -s 'http://localhost:8025/api/conversations?phoneNumberId=573542517421694'
   ```

   Expected result: Ana's conversation, whose `lastMessage` is the app's
   `"body":"echo: hello"`, with `"direction":"outbound"`.

7. Check the webhooks mockwa sent:

   ```sh
   curl -s 'http://localhost:8025/api/webhook-deliveries?limit=5'
   ```

   Expected result: one row for Ana's message and one per status of the reply (`sent`, then
   `delivered` about 800 ms later), each with `"responseStatus":200` and
   `"outcome":"delivered"`.

### The seeded IDs

A fresh instance always has the same IDs, on every machine and after every reset:

| What         | ID                                                              |
| ------------ | --------------------------------------------------------------- |
| WABA         | `666635535888644`                                               |
| Phone number | `573542517421694` (`+55 11 91234-5678`)                         |
| Template     | `355867425910125`: `hello_whaloc`, language `en`, no parameters |
| Contacts     | `5571990000001` (Ana Souza), `5571990000002` (Bruno Lima)       |

[Configuration → The default seed](configuration.md#the-default-seed) has the details.

## Look at it in the browser

- <http://localhost:8025> is the console. **Chats** shows Ana's conversation with status ticks
  and a "service window open" badge; **Webhooks** shows each delivery; **Requests** shows the
  Graph calls the app made.
- <http://localhost:8025/phone?as=5571990000001&chat=573542517421694> is the virtual phone as
  Ana. Type a message and press send; the app's `echo: …` reply appears within a second.

[Using the console](usage.md) explains every view.

## Send as your app

Your app calls the Graph port (8888) with a bearer token. With the default configuration any
non-empty token is accepted.

Ana wrote in the last 24 hours, so a free-form text to her goes out:

```sh
curl -s -X POST http://localhost:8888/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"Hi Ana"}}'
```

Expected result: `200` with `"messages":[{"id":"wamid.…","message_status":"accepted"}]`.

Bruno has never written, so his 24-hour window is closed. The same text to him is also accepted
with `200`, and then **fails** with error `131047`, as on Meta. A template is not held back by the
window:

```sh
curl -s -X POST http://localhost:8888/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000002","type":"template","template":{"name":"hello_whaloc","language":{"code":"en"}}}'
```

Expected result: `200`, then the template reaches `delivered`.

## Clean up

This page created two containers, one network, and one Docker volume:

- **The database** is in memory (`MOCKWA_DB_PATH` is unset), so it goes with the container.
- **Media files** are not. The image declares `VOLUME /data` and keeps media in `/data/media`, so
  Docker gave `mockwa-quickstart` an anonymous volume for them. A plain `docker rm` leaves that
  volume behind.

Remove the containers **with `-v`**, which also removes the anonymous volumes of those two
containers and nothing else. Your other volumes, and the checkout mounted into the example app,
are not touched:

```sh
docker rm -f -v mockwa-quickstart mockwa-quickstart-echo
docker network rm mockwa-quickstart
```

Expected result: the three names are printed back. `docker ps -a --filter name=mockwa-quickstart`
and `docker network ls --filter name=mockwa-quickstart` then list nothing. Keep `mockwa:local`
for the other pages; remove it with `docker rmi mockwa:local` when you no longer need it. Do not
use `docker volume prune` or `docker system prune` for this: they remove other projects' data
too.

## Connect your own app

Replace the example app with yours. Two directions have to agree:

1. **Your app calls mockwa** instead of `graph.facebook.com`. Set its Graph base URL to mockwa's
   Graph port **with a version segment**, such as `http://mockwa:8888/v25.0`. Cloud API clients
   add `/{id}/messages` to the base URL and never insert a version, so a base URL without one
   asks for paths mockwa does not serve. Any `/v<major>.<minor>` works.
2. **mockwa calls your app's webhook receiver** instead of Meta. Set the values in this table.

| mockwa                        | Your app                                       | Why it must match                                                       |
| ----------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `MOCKWA_WEBHOOK_URL`          | The receiver's address, as mockwa can reach it | Where every webhook goes. In Compose, the service name, not `localhost` |
| `MOCKWA_APP_SECRET`           | The Meta app secret the receiver verifies with | The key of `X-Hub-Signature-256`                                        |
| `MOCKWA_WEBHOOK_VERIFY_TOKEN` | The receiver's verify token                    | Compared in the `hub.challenge` handshake                               |
| `MOCKWA_PUBLIC_URL`           | Whatever downloads media                       | The host in every media URL mockwa hands out                            |
| `MOCKWA_APP_ID`               | The app's Meta app ID (optional)               | Only what `GET /{waba}/subscribed_apps` reports                         |

The access token your app sends does not matter unless you turn on the token registry
([Testing → Expire or reject tokens](testing.md#expire-or-reject-tokens)).

A Compose file with mockwa next to your app:

```yaml
services:
  app:
    build: .
    environment:
      GRAPH_API_BASE_URL: http://mockwa:8888/v25.0 # the version segment is required
      META_APP_SECRET: dev-app-secret
      META_WEBHOOK_VERIFY_TOKEN: dev-verify-token
    healthcheck:
      # Proves the receiver answers the handshake before mockwa starts.
      test:
        [
          "CMD",
          "wget",
          "-qO-",
          "http://localhost:3001/meta-webhooks?hub.mode=subscribe&hub.verify_token=dev-verify-token&hub.challenge=ok",
        ]
      interval: 30s
      start_period: 60s
      start_interval: 2s

  mockwa:
    image: mockwa:local
    ports: ["127.0.0.1:8888:8888", "127.0.0.1:8025:8025"]
    environment:
      MOCKWA_PUBLIC_URL: http://mockwa:8888 # your app downloads media from inside the network
      MOCKWA_WEBHOOK_URL: http://app:3001/meta-webhooks
      MOCKWA_APP_SECRET: dev-app-secret
      MOCKWA_WEBHOOK_VERIFY_TOKEN: dev-verify-token
      MOCKWA_VERIFY_ON_START: "true"
      # MOCKWA_DB_PATH: /data/mockwa.db # keep state across restarts
    volumes: ["mockwa-data:/data"]
    depends_on:
      app: { condition: service_healthy }

volumes:
  mockwa-data:
```

The names your app uses (`GRAPH_API_BASE_URL`, `META_APP_SECRET`, …) are examples; use your
app's own. Inside the network mockwa is `mockwa:8888` and `mockwa:8025`; from your computer it is
whatever host ports you published.

The boot handshake is a single attempt. Without the health gate, an app that is slow to start
makes mockwa log `webhook handshake failed` once, and nothing else is wrong. You can run the
handshake again at any time ([Webhooks → Run the handshake](webhooks.md#run-the-handshake)).

Set it for every service of yours that calls the Graph API: the API, workers, media downloaders.

Guides for two specific apps: [Workbench](integrations/workbench.md) and
[GotUnit](integrations/gotunit.md).

### The Compose demo in this repository

`docker compose up` in the checkout builds mockwa and starts it with a small receiver,
`webhook-echo`, that checks signatures and **logs** each delivery. It does not reply, so a
message from the phone gets no answer. Watch it with `docker compose logs -f webhook-echo`. For
replies, use the example app as above, or [`examples/public-demo`](../examples/public-demo/docker-compose.yml).

## If something is wrong

| What you see                                                | Likely cause                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `mockwa cannot start, the environment is invalid:` + a list | A variable is wrong; every problem is listed. See [Configuration](configuration.md) |
| `webhook handshake failed` at boot                          | The receiver was not up yet, or the verify token differs                            |
| The app's reply never comes                                 | No app is connected, or it calls the wrong host or port; check **Requests**         |
| `404` for every Graph call                                  | The app calls port 8025, or its base URL has no version segment                     |
| A text send `200`, then `failed` with `131047`              | The contact has not written in 24 hours; send a template or an inbound first        |
| `132001` on a template send                                 | No approved template with that name and language                                    |
| Seeded IDs answer `400` / code `100` / subcode `33`         | A stale or different image, or a custom seed; rebuild and check `seed applied`      |
