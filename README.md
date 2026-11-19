# mockwa

[![CI](https://github.com/loongest/mockwa/actions/workflows/ci.yml/badge.svg)](https://github.com/loongest/mockwa/actions/workflows/ci.yml)
[![Docker](https://github.com/loongest/mockwa/actions/workflows/docker.yml/badge.svg)](https://github.com/loongest/mockwa/actions/workflows/docker.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **mockwa is a fork of [whaloc](https://github.com/dgadelha/whaloc)** (MIT, © Douglas Gadêlha — see
> [LICENSE](LICENSE)). It keeps whaloc's engine and adds what a WhatsApp Cloud API _simulator_
> needs. So far: two ports — **8888** for the Graph API, **8025** for the console — and
> `MOCKWA_*` configuration, with every `WHALOC_*` variable still accepted as an alias (M0); and a
> **virtual phone** at `http://localhost:8025/phone` to chat with your app as named users (M1,
> see [Virtual phone](#virtual-phone)); Meta's webhook model with several apps and retries (M2);
> the sending rules (M3); a virtual clock and scenarios (M4); and a console that runs on simulator
> time, with Clock, Scenarios and Graph request log views (M5, see [A five-minute tour](#a-five-minute-tour)).
> The rest of this README describes whaloc's behavior, which mockwa keeps; "whaloc" below means the
> engine mockwa inherited.

whaloc is a local emulator of the **Meta WhatsApp Cloud API (Graph API v25.0)** in a single
Docker image. It plays Meta's whole side of a WhatsApp integration — accepting sends, minting
Meta-shaped `wamid`s, walking messages up the status ladder, moderating templates, storing media
and **POSTing signed webhooks back to your app** — so an application that talks to the Cloud API
runs entirely offline: no Meta app, no business number, no public tunnel, no shared sandbox that
somebody else's test just reset. Point your app's `GRAPH_API_BASE_URL` at whaloc, open the web
UI, and be the WhatsApp user on the other side of the conversation.

It is **deterministic by default**: nothing fails, drops or changes state on its own, and
everything interesting — a read receipt, a rate limit, an expired token, a template rejection,
a number change — happens because you asked for it, from the UI or from a test.

What is in the box:

- **The Graph surface your app already calls** — messages of every type, media upload, deletion
  and the two-hop download with `Range`, the resumable Upload API that mints real
  `header_handle`s, templates with Meta's filters and cursors, phone-number management, the
  business profile, `subscribed_apps` — answering with Meta's exact envelopes, `fbtrace_id` and
  error codes.
- **Signed webhooks, and the log to prove it.** Inbound messages, statuses, template and quality
  events, all `X-Hub-Signature-256`-signed over the exact bytes sent. Every attempt is stored,
  inspectable and redeliverable.
- **A chat-style web UI** where you act as the WhatsApp user: reply, react, send media and
  location, mark delivered/read, fail a message with a real Meta error code, approve or reject a
  template as a moderator would.
- **Deterministic error simulation** — a bearer-token registry whose tokens you can expire,
  injection rules (`always`, `next N`, `every Nth`) with Meta's rate-limit envelopes and
  throttling headers, and media that expires on a TTL.
- **Real edges to test against**: the phone-number registration ladder (a deregistered number
  answers `133010`), business-scoped user IDs and `user_changed_number`, media in a directory or
  in **S3**, and whole-state **export/import** so a reproduction is one JSON file.
- **A control-plane API + WebSocket** for tests, so everything the UI can do, a script can do.
- Configured **entirely through environment variables**, seeded deterministically: the same IDs
  on every machine, every run.

Three surfaces on **two ports** — one engine, one process:

| Port   | Surface                       | Mount                                | Purpose                                                                 |
| ------ | ----------------------------- | ------------------------------------ | ----------------------------------------------------------------------- |
| `8888` | Graph API mock                | `/v25.0/…` (any `/v<major>.<minor>`) | The endpoints the app under test calls                                  |
| `8025` | Control-plane API + WebSocket | `/api/…`, `/api/ws`                  | Inspect state and simulate the user side, from the UI or tests          |
| `8025` | Web UI                        | `/` (static React bundle)            | Chat-style UI: be the WhatsApp user, moderate templates, watch webhooks |
| `8025` | Virtual phone                 | `/phone`                             | One WhatsApp user per browser tab, chatting with your app               |

Each port answers `404` for the other's routes, so the app under test only ever sees a
Meta-shaped surface. Both answer `/health`.

Full behavioral contract: [docs/SPEC.md](docs/SPEC.md). Wiring it into your own compose stack:
[docs/integrating.md](docs/integrating.md).

**Contents** — [Quickstart](#quickstart) · [Configuration](#configuration) ·
[Graph API coverage](#graph-api-coverage) · [Identities](#identities-and-number-changes) ·
[Error simulation](#error-simulation) · [Control plane](#control-plane) · [Webhooks](#webhooks) ·
[Web UI](#web-ui) · [Development](#development) · [Contributing](#contributing) ·
[Acknowledgments](#acknowledgments) · [License](#license)

## Quickstart

```sh
docker run --rm -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -e MOCKWA_WEBHOOK_URL=http://host.docker.internal:3001/meta-webhooks \
  -e MOCKWA_APP_SECRET=dev-app-secret \
  -e MOCKWA_WEBHOOK_VERIFY_TOKEN=dev-verify-token \
  -e MOCKWA_VERIFY_ON_START=true \
  ghcr.io/loongest/mockwa:latest
```

The publish workflow pushes the image to `ghcr.io/loongest/mockwa` (and to Docker Hub when that
is configured, see `.github/workflows/docker.yml`) when a `v*` release tag is pushed — never from
an ordinary commit. Until a release exists, build it locally:
`docker build -t mockwa .` and run `mockwa` in place of the image name.

The ports are published to loopback only: the console has no login, so keep it off the network
unless you trust it. Open <http://localhost:8025> for the UI and point the app under test at
`GRAPH_API_BASE_URL=http://localhost:8888/v25.0` (from another container on the same compose
network: `http://mockwa:8888/v25.0`). Seeded IDs are **derived deterministically** — the same on
every machine, every run, and treated as a stable contract — so the commands below work verbatim
against a fresh whaloc; they are also logged at boot (`seed applied`) and shown, with copy
buttons, in the UI's **Settings** view.

Sending a message needs nothing but a bearer token — any non-empty one is accepted:

```sh
curl -X POST http://localhost:8888/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"olá"}}'
```

The answer is `200` with a wamid, but on a fresh mockwa that text then **fails** with `131047`:
the contact has not written, so the 24-hour customer service window is closed (see **Messaging
rules**). Simulate an inbound message first, or send a template, which is always allowed.

The seed also ships one **approved, zero-parameter template**, `hello_whaloc`, so a
`type: "template"` send works on a cold whaloc too — nothing to create, nothing to approve:

```sh
curl -X POST http://localhost:8888/v25.0/573542517421694/messages \
  -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
  -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"template","template":{"name":"hello_whaloc","language":{"code":"en"}}}'
```

`MOCKWA_SEED` can carry as many templates as you like (`templates: [{name, language?, category?,
parameterFormat?, components?}]` per WABA, see [SPEC §7](docs/SPEC.md)); every one of them is
`APPROVED` from the first instant, because a seed describes templates that exist already.

The repository ships a **standalone demo** — whaloc plus a webhook receiver that verifies
`X-Hub-Signature-256` and logs every delivery:

```sh
docker compose up            # UI on :8025, Graph API on :8888
docker compose logs -f webhook-echo
```

See [docker-compose.yml](docker-compose.yml); it is also the shortest example of the environment
a real integration needs, and [docs/integrating.md](docs/integrating.md) is the long form —
pointing your own app at whaloc, which values have to match which, and a smoke test. Short
setups for two specific apps live next to it: [Workbench](docs/integrations/workbench.md) and
[GotUnit](docs/integrations/gotunit.md). The image is
published by [`.github/workflows/docker.yml`](.github/workflows/docker.yml) **only from a `v*` tag**
(the semver ladder, `sha-<short>` and `latest`, `linux/amd64` + `linux/arm64`; pull requests and
pushes to `main` build and test the image but publish nothing) with
full SLSA provenance and an SBOM attached to the image index, plus GitHub-signed build
attestations — verifiable with
`gh attestation verify oci://ghcr.io/loongest/mockwa:latest --owner loongest`.

### A five-minute tour

Six steps, from nothing to a scenario report. They use the seeded IDs, so they work verbatim.

**Two ports, two jobs.** `8888` is the **Graph port**: your app calls it in place of
`graph.facebook.com`, and nothing else lives there. `8025` is the **control-plane port**: the
console, the virtual phone, `/api` and `/api/ws`. Your app should only ever know about 8888.

**Which image.** The Clock, Scenarios and Requests views arrived in M5, and no release containing
them has been published yet: images are published only from a `v*` release tag, so
`ghcr.io/loongest/mockwa:latest` may be older and lack them. Until such a release exists, build
the image from this checkout and use that local tag (or, while reviewing, the review image you were given):

```sh
docker build -t mockwa:local .
```

Once a release that includes M5 is published, `ghcr.io/loongest/mockwa:<version>` works the same
way in every command below.

1. **Start the image** on a virtual clock, so time moves only when you say so:

   ```sh
   docker run --rm --name mockwa-tour -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
     -e MOCKWA_CLOCK=virtual -e MOCKWA_CLOCK_START=2026-06-01T08:00:00Z \
     mockwa:local
   ```

2. **Receive a message** as the seeded contact Ana, which opens her 24-hour window:

   ```sh
   curl -s -X POST http://localhost:8025/api/inbound -H 'Content-Type: application/json' \
     -d '{"phoneNumberId":"573542517421694","from":"5571990000001","type":"text","text":{"body":"hi"}}'
   ```

3. **Send a reply** through the Graph port, the call your app makes:

   ```sh
   curl -s -X POST http://localhost:8888/v25.0/573542517421694/messages \
     -H 'Authorization: Bearer dev-token' -H 'Content-Type: application/json' \
     -d '{"messaging_product":"whatsapp","to":"5571990000001","type":"text","text":{"body":"hello Ana"}}'
   ```

   The console's **Requests** tab now shows that call (token masked), and **Chats** shows the
   conversation with a "Service window open until …" badge and the time left.

4. **Open the Virtual Phone** for Ana: the **Open phone** link in the chat header, or
   <http://localhost:8025/phone?as=5571990000001&chat=573542517421694>. Type a reply there; with
   `MOCKWA_WEBHOOK_URL` set it goes to your app as a signed webhook.

5. **Advance time** in the **Clock** tab (+24h), or:

   ```sh
   curl -s -X POST http://localhost:8025/api/clock/advance -H 'content-type: application/json' -d '{"by":"24h"}'
   ```

   The window badge turns to "closed" at the 24-hour boundary in every open tab, because the console
   reads the simulator clock, not your computer's. A new message from Ana reopens it.

6. **Run a scenario** in the **Scenarios** tab: pick `service-window.json`, press **Check**, then
   **Run…**. A run **resets the instance** first (the tab warns you). The report lists each step,
   shows expected and observed values for a failed expectation, and downloads as JUnit XML.

Good to know:

- **Real vs virtual.** `MOCKWA_CLOCK=real` (the default) follows the wall clock; the Clock tab's
  controls are then locked. `virtual` stands still until you move it.
- **Your app keeps its own clock.** Moving mockwa's clock does not move your app's. Webhook
  timestamps show simulator time; your app's own "now" does not.
- **State is in memory** unless `MOCKWA_DB_PATH` points at a file (see below). A reset, a scenario
  run or a restart without a file database starts over from the seed.

### State and the `/data` volume

The default database is `:memory:` — every restart starts from the seed. Mount a volume and set
`MOCKWA_DB_PATH` to keep WABAs, conversations, templates and media across restarts:

```sh
docker run -d --name mockwa -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -v mockwa-data:/data -e MOCKWA_DB_PATH=/data/mockwa.db \
  ghcr.io/loongest/mockwa:latest
```

`/data` is a declared volume and media bytes live in `/data/media` either way. The container runs
as the unprivileged `node` user (uid 1000), which a fresh named volume inherits; a **bind** mount
keeps the host's ownership, so `chown 1000:1000` the host directory (or accept read-only media).

### Media storage: a directory, or S3

By default the bytes behind every uploaded image, video and document go to `MOCKWA_MEDIA_DIR`.
Set `MOCKWA_MEDIA_BACKEND=s3` and they go to an **S3-compatible bucket** instead — RustFS, R2,
Ceph or AWS itself — which is what you want when whaloc runs more than once against the same
state, or when a container that may be recreated must not take the media with it.

```yaml
services:
  # The console is at http://localhost:9001/rustfs/console/.
  rustfs:
    image: rustfs/rustfs:1.0.0
    environment:
      RUSTFS_ACCESS_KEY: whaloc
      RUSTFS_SECRET_KEY: whaloc-secret
    ports: ["9000:9000", "9001:9001"]
    volumes: ["rustfs-data:/data"]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9000/health"]
      interval: 2s
      retries: 30

  # whaloc never creates the bucket; this makes it once and exits (a rerun is harmless).
  rustfs-bucket:
    image: amazon/aws-cli
    depends_on:
      rustfs: { condition: service_healthy }
    environment:
      AWS_ACCESS_KEY_ID: whaloc
      AWS_SECRET_ACCESS_KEY: whaloc-secret
      AWS_DEFAULT_REGION: us-east-1
    command: --endpoint-url http://rustfs:9000 s3 mb s3://whaloc-media

  mockwa:
    image: ghcr.io/loongest/mockwa:latest
    depends_on:
      rustfs-bucket: { condition: service_completed_successfully }
    ports: ["127.0.0.1:8888:8888", "127.0.0.1:8025:8025"]
    environment:
      MOCKWA_MEDIA_BACKEND: s3
      MOCKWA_S3_ENDPOINT: http://rustfs:9000
      MOCKWA_S3_BUCKET: whaloc-media
      MOCKWA_S3_REGION: us-east-1
      MOCKWA_S3_ACCESS_KEY_ID: whaloc
      MOCKWA_S3_SECRET_ACCESS_KEY: whaloc-secret

volumes:
  rustfs-data:
```

Notes worth knowing:

- **The bucket has to exist.** whaloc reads and writes objects; it does not manage buckets.
- Leave both key variables unset and the AWS SDK's **default credential chain** applies (a
  profile, an instance role, `AWS_*` variables) — setting only one of them is an error, not a
  request for the chain.
- `MOCKWA_S3_FORCE_PATH_STYLE` defaults to `true` as soon as an endpoint is configured, because
  that is how RustFS and friends address a bucket; AWS itself gets virtual-host style.
- Object keys are the same flat, opaque names the local backend uses as filenames, so the two
  backends are interchangeable — including through an **export/import** (see below).
- Everything else is unchanged: the two-hop download, `Range` requests, the ~100 MiB cap and
  `MOCKWA_MEDIA_TTL_SECONDS` all behave identically. Only where the bytes rest differs.

### State snapshots: export and import

A whaloc's whole world fits in one JSON file — every WABA, phone number (pending verification
codes and business profiles included), contact, template, conversation, message, media row **and
the media bytes themselves**, base64-inlined. Send the file to a colleague and the whaloc it
lands in is the one it left, which is what makes a reproduction shareable.

```sh
curl -sOJ http://localhost:8025/api/export                        # whaloc-snapshot-<ts>.json
curl -s 'http://localhost:8025/api/export?include=deliveries' -o snapshot.json
curl -sX POST http://localhost:8025/api/import \
  -F file=@snapshot.json                                          # or: -H 'Content-Type: application/json' --data-binary @snapshot.json
```

Both are in **Settings → Danger zone** too: an Export button (the browser saves the file) and an
Import picker behind a confirmation.

- **An import replaces everything**, and the seed is **not** re-applied afterwards: the snapshot
  _is_ the state, IDs and all. `POST /api/reset` is still the way back to `MOCKWA_SEED`.
- It is **validated before anything is deleted**, and refuses a snapshot written by a newer
  whaloc (there is a schema version in the envelope) rather than half-loading it. The database
  swap itself is one transaction.
- The bytes go back in **through whichever storage backend is configured now**, so a snapshot
  taken from a local-backed whaloc restores into an S3-backed one and the other way round.
- The **delivery log is left out** unless `?include=deliveries` asks for it: it is traffic rather
  than state, and by far the biggest table.
- Base64 costs about a third in size over the raw bytes. That is the deliberate trade — media in
  a whaloc is a handful of test images, and a snapshot that only half-restores is worse than a
  large one. Skip a huge media library rather than expecting a 500 MB file to be pleasant.
- Rows come out in a deterministic order, so two exports of the same state differ only in their
  `exportedAt`.

## Configuration

Environment variables only, parsed once at boot: an invalid environment prints **every** problem
and exits. Every variable is spelled `MOCKWA_*`; the whaloc spelling `WHALOC_*` still works as an
alias (`MOCKWA_PORT` means `MOCKWA_GRAPH_PORT`). If both are set, `MOCKWA_*` wins and the boot log
warns when the two values differ. Blank values count as unset (an empty `MOCKWA_WEBHOOK_URL=` in a compose file disables
webhooks rather than failing), and values are trimmed.

| Var                                        | Default                                              | Purpose                                                                                             |
| ------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `MOCKWA_GRAPH_PORT`                        | `8888`                                               | Graph API port (legacy alias: `MOCKWA_PORT`); the `HEALTHCHECK` follows it                          |
| `MOCKWA_CONSOLE_PORT`                      | `8025`                                               | Console port: UI, `/api`, `/api/ws`; must differ from the Graph port                                |
| `MOCKWA_HOST`                              | `0.0.0.0`                                            | Bind address                                                                                        |
| `MOCKWA_PUBLIC_URL`                        | `http://localhost:8888`                              | Base for generated media URLs and `paging.next` — must be reachable **by whoever downloads media**  |
| `MOCKWA_WEBHOOK_URL`                       | _unset → webhooks disabled (warns)_                  | Target for webhook POSTs, e.g. `http://meta-webhook-receiver:3001/meta-webhooks`                    |
| `MOCKWA_APP_SECRET`                        | _unset → deliveries unsigned (warns)_                | HMAC key for `X-Hub-Signature-256`                                                                  |
| `MOCKWA_WEBHOOK_VERIFY_TOKEN`              | _unset_                                              | Token echoed in the `hub.challenge` handshake                                                       |
| `MOCKWA_VERIFY_ON_START`                   | `false`                                              | Run that handshake at boot                                                                          |
| `MOCKWA_APP_ID`                            | _derived from the name, stable across restarts_      | The app ID `subscribed_apps` reports — set it to the app's `META_APP_ID` when that matters          |
| `MOCKWA_APPS`                              | _unset → only the default app_                       | JSON list of extra apps with their own URL, secret, verify token and WABAs (see **Webhooks**)       |
| `MOCKWA_WEBHOOK_RETRY_SCHEDULE`            | `10s,30s,1m,5m,15m,1h,3h,6h,12h,24h`                 | Delay before each retry of a non-`200` delivery, the last repeating; `off` disables retries         |
| `MOCKWA_WEBHOOK_RETRY_MAX_AGE`             | `7d`                                                 | How long a delivery keeps being retried, as on Meta                                                 |
| `MOCKWA_SEED`                              | 1 WABA + 1 phone number + 2 contacts + 1 template    | JSON array of WABAs (see [SPEC §7](docs/SPEC.md)); omitted IDs are derived deterministically        |
| `MOCKWA_SEED_FILE`                         | _unset_                                              | Path to a file with the `MOCKWA_SEED` JSON, for long seeds; setting both is refused                 |
| `MOCKWA_CLOCK`                             | `real`                                               | `real` or `virtual`: one clock you move through `/api/clock` (see **Virtual clock and scenarios**)  |
| `MOCKWA_CLOCK_START`                       | `2026-01-01T00:00:00.000Z`                           | Where the virtual clock starts, and where a reset puts it                                           |
| `MOCKWA_STATUS_DELAYS`                     | `sent:0,delivered:800`                               | Status ladder timing in ms; add `read:<ms>` to automate read receipts                               |
| `MOCKWA_TEMPLATE_AUTO_APPROVE`             | `2000`                                               | ms until a new template is approved; `off` leaves it `PENDING` for the UI                           |
| `MOCKWA_TOKENS`                            | _unset → any non-empty bearer token is accepted_     | Comma-separated bearer-token registry; set it and only these tokens pass (see **Error simulation**) |
| `MOCKWA_MEDIA_TTL_SECONDS`                 | _unset → media never expires_                        | Seconds after which an uploaded media object is gone from the Graph surface                         |
| `MOCKWA_SERVICE_WINDOW`                    | `24h`                                                | Customer service window; a duration or `off` (see **Messaging rules**)                              |
| `MOCKWA_THROUGHPUT`                        | `off`                                                | Messages per second per number: `off`, `meta` (80 or 1,000 by `throughput.level`) or a number       |
| `MOCKWA_PAIR_RATE_LIMIT`                   | `off`                                                | Sends to one contact: `off`, `meta` (`6s/45`) or `<interval>/<burst>`                               |
| `MOCKWA_MESSAGING_LIMIT`                   | `off`                                                | Unique contacts per WABA reached by business-initiated templates in 24 hours, or `off`              |
| `MOCKWA_DB_PATH`                           | `:memory:`                                           | SQLite file for persistence, e.g. `/data/whaloc.db`                                                 |
| `MOCKWA_MEDIA_BACKEND`                     | `local`                                              | `local` (a directory) or `s3` (an S3-compatible bucket, see **Media storage**)                      |
| `MOCKWA_MEDIA_DIR`                         | `/data/media` in the image, `./data/media` otherwise | Media storage root, for the `local` backend                                                         |
| `MOCKWA_S3_BUCKET`                         | _required when the backend is `s3`_                  | Bucket the media objects live in — whaloc never creates it                                          |
| `MOCKWA_S3_REGION`                         | _required when the backend is `s3`_                  | Region; anything satisfies RustFS, but the SDK insists on having one                                |
| `MOCKWA_S3_ENDPOINT`                       | _unset → AWS S3_                                     | Endpoint of an S3-compatible server (RustFS, R2, Ceph…)                                             |
| `MOCKWA_S3_ACCESS_KEY_ID`                  | _unset → the SDK's default credential chain_         | Access key; all-or-nothing with the secret below                                                    |
| `MOCKWA_S3_SECRET_ACCESS_KEY`              | _unset → the SDK's default credential chain_         | Secret key                                                                                          |
| `MOCKWA_S3_FORCE_PATH_STYLE`               | `true` whenever an endpoint is set                   | Path-style addressing (`<endpoint>/<bucket>/<key>`), which is what RustFS serves                    |
| `MOCKWA_WEB_DIR`                           | `packages/web/dist`, beside the server               | Built UI served at `/`; an absent directory just leaves `/` unrouted                                |
| `MOCKWA_LOG_LEVEL`                         | `info`                                               | pino level (`fatal`…`trace`, `silent`)                                                              |
| `MOCKWA_MODE`                              | `dev`                                                | `dev` or `public` (anonymous visitors, see **Public demo mode**)                                    |
| `MOCKWA_ADMIN_TOKEN`                       | _unset_                                              | Admin token (16+ characters). Required in public mode; in dev mode it puts the console behind it    |
| `MOCKWA_PUBLIC_IDENTITIES`                 | a `CUSTOMER` and a `TECHNICIAN`                      | JSON `[{"role","name"}]` (1–4): the identities each visitor gets                                    |
| `MOCKWA_PUBLIC_WA_ID_PREFIX`               | `999`                                                | First digits of visitor numbers (15 digits in all)                                                  |
| `MOCKWA_PUBLIC_SESSION_TTL`                | `30m`                                                | Idle time before a visitor's session and data are removed                                           |
| `MOCKWA_PUBLIC_MESSAGES_PER_MINUTE`        | `20`                                                 | Messages per minute per visitor session                                                             |
| `MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE`     | `60`                                                 | Messages per minute per client address                                                              |
| `MOCKWA_PUBLIC_MEDIA_MAX_BYTES`            | `1048576`                                            | Largest visitor upload (JPEG, PNG, WebP or PDF)                                                     |
| `MOCKWA_PUBLIC_MEDIA_PER_SESSION`          | `10`                                                 | Uploads per visitor session                                                                         |
| `MOCKWA_PUBLIC_SESSIONS_PER_IP`            | `3`                                                  | Live visitor sessions per client address                                                            |
| `MOCKWA_PUBLIC_MAX_SESSIONS`               | `500`                                                | Live visitor sessions in total                                                                      |
| `MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE` | `10`                                                 | New visitor sessions per client address per minute                                                  |
| `MOCKWA_TRUSTED_PROXIES`                   | _unset_                                              | Exact IPs of reverse proxies whose `X-Forwarded-*` headers are believed                             |
| `MOCKWA_ALLOWED_ORIGINS`                   | _unset → the listener's own origin_                  | Extra origins allowed to write with a visitor or admin cookie                                       |
| `MOCKWA_COOKIE_SECURE`                     | `auto`                                               | `auto` (Secure over HTTPS), `always` or `never`                                                     |

## Graph API coverage

Every route is mounted under **any** `/v<major>.<minor>` prefix, takes any non-empty
`Authorization: Bearer` token, and answers failures with Meta's error envelope (including
`fbtrace_id`; an unknown object ID is a `400` with `code: 100, error_subcode: 33`, which is what
consumers key media-expiry and deregistration detection on).

| Route                                                    | Notes                                                                                                                                                                                                                         |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /{id}`                                              | Dispatches by store: phone number (lifecycle fields included), WABA, template, or media descriptor (with `?phone_number_id=`); honors `fields`                                                                                |
| `POST /{phone-number-id}/messages`                       | `text`, `template`, `image`, `video`, `audio`, `document`, `sticker`, `interactive`, `location`, `reaction`, `contacts`; addressed by `to` (MSISDN) or `recipient` (BSUID); optional `biz_opaque_callback_data` (≤ 512 chars) |
| `POST /{phone-number-id}/messages` (`status:"read"`)     | The read receipt Meta overloads the send path with → `{"success":true}`; marks that **inbound** message read, and `typing_indicator` raises a typing indicator with it                                                        |
| `POST /{phone-number-id}/media`                          | Streamed multipart upload → `{"id":"<digits>"}`, ~100 MiB cap                                                                                                                                                                 |
| `DELETE /{media-id}`                                     | Deletes the object and its bytes → `{"success":true}`; afterwards the ID is `400` / `100` / `33` and the byte URL 404s, so "this media is gone" is one call away                                                              |
| `GET /whaloc-media/{token}`                              | The byte endpoint the descriptor points at: `Range` → `206` + `Content-Range`, never a redirect                                                                                                                               |
| `POST /{app-id}/uploads`                                 | Opens a resumable upload → `{"id":"upload:<opaque>"}`; `file_length`/`file_type`/`file_name` from the query string or the body                                                                                                |
| `POST /upload:{opaque}`                                  | Sends bytes at `file_offset` → `{"h":"<handle>"}` once the session is full, otherwise the offset it is now at                                                                                                                 |
| `GET /upload:{opaque}`                                   | `{"id":…,"file_offset":N}` — a truthful offset, so an interrupted upload knows where to resume                                                                                                                                |
| `GET /whaloc-upload/{token}`                             | The bytes behind a completed handle, with the same `Range` rules as the media one                                                                                                                                             |
| `POST /{waba-id}/message_templates`                      | Creates `PENDING`, then the approval flow (§4)                                                                                                                                                                                |
| `GET /{waba-id}/message_templates`                       | `fields`, `limit`, `after`, `before`; filters `name`, `name_or_content`, `status`, `category`, `language`; `paging.next`/`paging.previous` only when that page exists                                                         |
| `DELETE /{waba-id}/message_templates?name=&hsm_id=`      | Deletes every language; unknown → `404` envelope                                                                                                                                                                              |
| `POST /{template-id}`                                    | Edit; back to `PENDING`, re-runs approval                                                                                                                                                                                     |
| `GET /{waba-id}/phone_numbers`                           | Listing with `paging`; honors `fields`                                                                                                                                                                                        |
| `POST /{waba-id}/phone_numbers`                          | Adds an **unverified** number → `{"id":"<digits>"}`; malformed → `400`, digits already in use (any WABA) → `409`                                                                                                              |
| `POST /{phone-number-id}/request_code`                   | "Texts" a 6-digit code — derived from the ID, so it is stable and never expires; readable in the UI, never in a Graph response                                                                                                |
| `POST /{phone-number-id}/verify_code`                    | Confirms it (`VERIFIED`, and `UNVERIFIED` → `PENDING`); a wrong or absent code is the `(#100)` envelope                                                                                                                       |
| `POST /{phone-number-id}/register`                       | `CONNECTED` — the number can send from here on; an unverified one is `133006`                                                                                                                                                 |
| `POST /{phone-number-id}/deregister`                     | `DISCONNECTED`; sends answer `133010` until it is registered again                                                                                                                                                            |
| `GET\|POST /{phone-number-id}/whatsapp_business_profile` | The profile a number publishes: `about`, `address`, `description`, `email`, `websites` (max 2), `vertical`, `profile_picture_url`. A `POST` merges, an empty value clears                                                     |
| `POST\|GET\|DELETE /{waba-id}/subscribed_apps`           | Subscribe whaloc's own app to a WABA's webhooks, read it back, unsubscribe. One implicit app; delivery does not depend on it                                                                                                  |

Template sends are validated against the stored components — a parameter-count mismatch is the
real `132000`, a template that is not `APPROVED` (or does not exist) is `132001`.

**`biz_opaque_callback_data`** is stored on the send and comes back on **every** status webhook for
that message — `sent`, `delivered`, `read`, `failed`, whether the ladder or a button raised it — as
`statuses[].biz_opaque_callback_data`. It is never echoed on the send response, because Meta does
not echo it there either.

### Resumable uploads and handles

Meta's Upload API is where a real `header_handle` comes from, and whaloc runs the same three calls:

```sh
BASE=http://localhost:8888/v25.0
AUTH="Authorization: Bearer dev-token"
APP=$(curl -s http://localhost:8025/api/state | jq -r .app.id)

SESSION=$(curl -s -X POST -H "$AUTH" \
  "$BASE/$APP/uploads?file_length=$(wc -c < logo.png)&file_type=image/png&file_name=logo.png" | jq -r .id)

HANDLE=$(curl -s -X POST -H "$AUTH" -H "file_offset: 0" \
  --data-binary @logo.png "$BASE/$SESSION" | jq -r .h)

curl -s -H "$AUTH" "$BASE/$SESSION"      # {"id":"upload:…","file_offset":12345}
```

The handle then goes wherever Meta takes one:

- **`profile_picture_handle`** on the business profile. A whaloc **media ID** still works there
  too — one call instead of three, and it is what the UI and the older docs use.
- **`components[].example.header_handle[]`** on a template. whaloc resolves it at create and edit
  time (an unknown handle is `(#100)`, not a header pointing at nothing) and the Templates view
  renders the header with the picture that was actually uploaded.

The `file_offset` an interrupted upload reports is truthful, and a chunk that does not land on it is
refused rather than silently overwritten. `:appId` takes whaloc's own app ID or any digit-only one —
an app under test has its own `META_APP_ID`, whaloc has one app either way, and refusing would be an
obstacle with nothing behind it.

A read receipt (`{"messaging_product":"whatsapp","status":"read","message_id":"wamid…"}`) moves
the user's message to `read` and emits **no** webhook — Meta reports statuses for outbound
messages only. Adding `"typing_indicator":{"type":"text"}` marks it read _and_ puts a typing
bubble in the UI, which comes down after Meta's 25-second window or as soon as the next outbound
message goes out. Both live in memory: a restart drops them, like every other timer.

**Only a `CONNECTED` phone number can send** (error `133010` otherwise), which is how a
deregistered number is reproduced. Seeded numbers — and numbers created through the control plane
or the UI — are `CONNECTED` and verified from the start, so nothing that worked before the
registration ladder existed has to change; only a number created through
`POST /{waba-id}/phone_numbers` walks it. The ladder is documented in
[SPEC §4](docs/SPEC.md).

Flows are out of scope.

## Identities and number changes

A contact is a phone number, and may **also** be a business-scoped user ID (BSUID) — Meta's
`BR.ENT.4KgQ2wJ8` / `US.4KgQ2wJ8` form. Give one to a contact in Settings (or through
`POST/PATCH /api/contacts`, `userId`) and whaloc reports it everywhere Meta does:

| Where            | Field                                                          |
| ---------------- | -------------------------------------------------------------- |
| Inbound webhooks | `contacts[].user_id` and `messages[].from_user_id`             |
| Status webhooks  | `statuses[].recipient_user_id`                                 |
| Sends            | `POST /{phone-number-id}/messages` with `recipient: "<BSUID>"` |

Each of them rides **alongside** `wa_id` / `from` / `recipient_id`, and each is absent for a
contact without a BSUID. A BSUID is unique across contacts. The default seed ships one on each
contact — `BR.ENT.AnaSouza01` and `BR.BrunoLima01`, one of each shape the pattern allows — and a
`MOCKWA_SEED` contact can set its own via `userId`.

A send addressed by `recipient` is **resolved** to the contact that owns that BSUID, and the
answer echoes what was asked with the number behind it:

```json
{ "contacts": [{ "input": "BR.ENT.4KgQ2wJ8", "wa_id": "5571988887777" }] }
```

An unknown BSUID is the missing-object envelope (`400` / `100` / `33`) rather than an invented
contact: the ID says nothing about a phone number, so the conversation such a contact got would
never have received anything. A `recipient` that is not BSUID-shaped is still treated exactly
like a `to`.

**When a person changes number**, use "Number…" in Settings (or "Changed number…" in a chat
header, or `POST /api/contacts/{waId}/change-number`). The contact's `wa_id` changes in place —
name, BSUID and full history follow it — and whaloc sends Meta's system notice to every business
number that has a conversation with the contact:

```json
{
	"from": "5571988887777",
	"type": "system",
	"system": {
		"body": "User Carla Dias changed from 5571988887777 to 5571977776666",
		"wa_id": "5571977776666",
		"new_wa_id": "5571977776666",
		"type": "user_changed_number"
	}
}
```

Like Meta's, the notice carries **no `contacts[]` array** — the new `wa_id` is inside `system`,
which is where a consumer has to read it. The new number appears under both spellings because
Meta's webhook version decides which one it
sends, and consumers read `wa_id ?? new_wa_id`. Wamids do not change, so replies, reactions and
read receipts naming older messages keep working — but the **derived conversation ID** does
(`<phoneNumberId>:<waId>`), so anything holding one has to follow the `previousWaId` the
`contact.changed` event carries. The UI does; the open chat moves with the person.

## Messaging rules

mockwa follows four of Meta's sending rules. Only the first is on by default, because every app
meets it on its first day in production; the other three are opt-in.

| Rule                    | Variable (default)               | What happens                                                                                                                                                            |
| ----------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer service window | `MOCKWA_SERVICE_WINDOW` (`24h`)  | A free-form message to a contact who has not written in the last 24 hours is accepted (200), then gets a `failed` status webhook with `131047`. Templates always go out |
| Throughput              | `MOCKWA_THROUGHPUT` (`off`)      | Too many sends per second from one number: `429`, code `130429`, `Retry-After: 1`                                                                                       |
| Pair rate limit         | `MOCKWA_PAIR_RATE_LIMIT` (`off`) | Too many sends to one contact: `400`, code `131056`                                                                                                                     |
| Messaging limit         | `MOCKWA_MESSAGING_LIMIT` (`off`) | A template to a new contact while the window is closed, over the limit: `failed`, mockwa's own code `990001`                                                            |

The window opens when the contact writes (`POST /api/inbound`, or the virtual phone) and closes
exactly 24 hours after their latest message. The chat header in the console shows it, and so
does the control plane:

```sh
curl -s 'http://localhost:8025/api/service-window?phoneNumberId=<id>&waId=<wa_id>'
curl -s http://localhost:8025/api/messaging-rules
```

To close one window **now**, use the chat header's **Expire now** button or:

```sh
curl -s -X POST http://localhost:8025/api/service-window/expire -H 'content-type: application/json' \
  -d '{"phoneNumberId":"<id>","waId":"<wa_id>"}'
```

Its scope is exactly one pair: this business number and this contact. The clock does not move,
other contacts keep their windows, and the contact's next message reopens it (even on a frozen
virtual clock). A window that is already closed is left alone. A reset or an import clears every
"expired by hand" mark, and snapshots do not carry them.

To reach a boundary without waiting, shorten it: `MOCKWA_SERVICE_WINDOW=30s`. To get the
behavior from before this feature, where any message goes out, set `MOCKWA_SERVICE_WINDOW=off`.
Meta documents the messaging limit but **no error code** for going over it, so mockwa uses a
code of its own, `990001`, titled `[mockwa] Messaging limit reached (simulated)`. Do not build
production logic on that code: Meta will never send it. Where mockwa differs from Meta is listed
in
[SPEC §4, "Differences from the real Meta Cloud API"](docs/SPEC.md).

## Error simulation

Everything whaloc does wrong, it does **on purpose**. All three switches below are off by
default, none of them is probabilistic, and each is visible in the UI — a failure nobody asked
for is a support question, and one somebody asked for and then forgot about is worse, so an
armed rule puts a pulsing badge in the top bar.

### Strict tokens

Set `MOCKWA_TOKENS` to a comma-separated list and the Graph surface accepts **only** those
bearer tokens; anything else is `401` with the same `code: 190` envelope a missing token gets
(Meta does not tell a caller which mistake it made, and neither does whaloc). Leave it unset —
the default — and any non-empty token works, exactly as before.

Each registered token can then be **expired** from Settings, or from the control plane:

```sh
curl -s http://localhost:8025/api/tokens                      # masked: {"strict":true,"data":[…]}
curl -sX POST http://localhost:8025/api/tokens/<id>/expire    # → 401 / 190 / subcode 463
curl -sX POST http://localhost:8025/api/tokens/<id>/restore
```

The expired-session envelope is Meta's `error_subcode: 463`, which is what a consumer keys
"refresh my token" on. Expiry survives a restart with `MOCKWA_DB_PATH`; `POST /api/reset` brings
every token back. The token values never leave the process — the API serves them masked, and
what is stored is a truncated SHA-256, so a `whaloc.db` on a volume holds no credential.

### Injection rules

A rule says **where** to fail, **when**, and **with which envelope**. Rules live in the database,
are managed from Settings or `POST /api/injection-rules`, and are cleared by `POST /api/reset`.

| Part    | Values                                                                                                                                                |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target  | `messages.send`, `messages.status`, `media.upload`, `media.resolve`, `media.download`, `templates.create`, `templates.list`, `graph.all`              |
| Trigger | `{"kind":"always"}`, `{"kind":"next","count":N}` (with a live countdown), `{"kind":"every","nth":N}` (fires on the Nth, 2Nth… request that rule sees) |
| Preset  | `rate_limit_429` · `throughput_131056` · `spam_rate_4` · `server_error_500` · `custom` · `failed_status` (only for `messages.status`)                 |

```sh
curl -sX POST http://localhost:8025/api/injection-rules -H 'Content-Type: application/json' \
  -d '{"target":"messages.send","trigger":{"kind":"next","count":3},
       "preset":"rate_limit_429","retryAfterSeconds":42,"regainAccessMinutes":7}'
```

The next three sends then answer `429`:

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

with the two headers a consumer's backoff reads — `Retry-After: 42` in **seconds**, and

```
X-Business-Use-Case-Usage: {"<waba-id>":[{"type":"whatsapp","call_count":100,"total_cputime":100,
  "total_time":100,"estimated_time_to_regain_access":7}]}
```

whose `estimated_time_to_regain_access` is in **minutes**. The fourth send succeeds. The other
presets are `throughput_131056` (`400`, the business/consumer pair limit, no headers),
`spam_rate_4` (`429`, code `4`, the same two headers), `server_error_500` (`500`, code `1`) and
`custom`, where you write the envelope yourself (`{"custom":{"httpStatus":400,"code":131047,
"message":"(#131047) Re-engagement message"}}`).

Rules are evaluated in one middleware **before every handler** and **after** the bearer gate, so
an armed `graph.all` rule can never disguise a `401`. Each matching rule counts the request; the
first one whose trigger arms it answers, and a rule shadowed by an earlier one keeps its
countdown untouched. Every injection is logged at `info` with the rule that caused it.

A `messages.status` rule fails the **status**, not the request: the send still answers `200`
with a wamid, and its status webhook is `failed` with the code you pick, instead of `sent`. Use
it to test how your app handles a message that fails after it was accepted:

```sh
curl -sX POST http://localhost:8025/api/injection-rules -H 'Content-Type: application/json' \
  -d '{"target":"messages.status","trigger":{"kind":"next","count":1},
       "preset":"failed_status","errorCode":131026}'
```

### Media expiry

`MOCKWA_MEDIA_TTL_SECONDS=5` makes an uploaded object disappear from the Graph surface five
seconds later — the boundary is inclusive. The descriptor hop answers the missing-object envelope
(`400`, `code: 100`, `error_subcode: 33`), which is exactly what consumers key expired-media
detection on, and the byte endpoint answers the plain `404` it gives an unknown token, because
that route carries no Meta envelope. The row and the bytes are still there: whaloc's own
`GET /api/media/{id}` keeps describing them, so the UI can still show what a message pointed at.

## Virtual clock and scenarios

> Simulator-only: Meta has no clock you can move. This exists so tests can cover minutes, days
> and the 7-day retry horizon without waiting.

### The virtual clock

Start mockwa with `MOCKWA_CLOCK=virtual` and time stands still until you move it. Every timer
(status rungs, template auto-approval, typing dismissal, webhook retries) and every timestamp
(messages, statuses, webhooks, the 24-hour window, rate limits) uses this one clock.

```bash
docker run --rm -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -e MOCKWA_CLOCK=virtual -e MOCKWA_CLOCK_START=2026-06-01T08:00:00Z \
  -e MOCKWA_WEBHOOK_URL=http://host.docker.internal:3001/webhook \
  ghcr.io/loongest/mockwa:latest
```

```bash
curl -s localhost:8025/api/clock                                    # now, and what is pending
curl -s -X POST localhost:8025/api/clock/advance -H 'content-type: application/json' -d '{"by":"5m"}'
curl -s -X POST localhost:8025/api/clock/set -H 'content-type: application/json' -d '{"to":"2026-06-02T08:00:00Z"}'
curl -s -X POST localhost:8025/api/clock/run-next                   # jump to the next event
```

An advance answers `{from, to, fired, clock}`: every event that ran, in order, each at its own
due time, and what is still pending. It returns once that work (and the webhooks it sent) is
done, so you can assert right after it. Good to know:

- Events due at the same instant run in the order they were scheduled.
- Time never goes backwards; `POST /api/reset` puts it back at `MOCKWA_CLOCK_START`.
- On the virtual clock, generated IDs are **deterministic**: the same steps after a reset give
  the same wamids, the same webhook bytes and the same signatures.
- With a file database the clock's position and pending webhook retries survive a restart.
  Status rungs and template auto-approvals in flight do not (they are in memory, as before).
- HTTP timeouts stay in real time, and **your app's clock does not move** with mockwa's. Webhook
  timestamps show virtual time.

The console's **Clock** tab shows the mode, the simulator time, the start and the pending events,
and moves the clock (advance by a duration, move to a date and time, run to the next event). It
lists what each move ran, with any error, and locks itself while a move is running. In real mode
the controls are locked and say why. Every time the console shows — message days, list times,
the window badge — is simulator time, in your browser's time zone (named in the top bar's clock
badge). It updates live however the clock moved: the console, `/api/clock`, the CLI, a scenario
or a reset.

### Scenarios

A scenario is a JSON file: a world (numbers, people with roles, apps, templates, failure rules,
a start time) and steps (`send`, `tap`, `expect`, `advance`). mockwa resets into the world and
runs the steps against your app. Two examples live in `examples/scenarios/`; the full format is
in [SPEC §4 "Scenarios"](docs/SPEC.md).

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

Run it with the CLI. In the image it is on the `PATH` (mount your files, for example
`-v "$PWD/scenarios:/scenarios:ro"`); from a checkout use `npm run mockwa --`:

```bash
docker exec my-mockwa mockwa scenario run /scenarios/menu-tap.json --url http://127.0.0.1:8025 --junit /tmp/report.xml
```

```text
PASS menu tap  [/scenarios/menu-tap.json]  (virtual clock 2026-05-04T09:00:00.000Z → 2026-05-05T09:00:00.000Z)
  ✓ 1. Ana sends "menu"  (4 ms)  @ 2026-05-04T09:00:00.000Z
  ...
1 scenario(s): 1 passed, 0 failed
```

A failed expectation stops the run, names the step and prints what was expected next to what was
observed; the steps after it are skipped. Exit codes: `0` all passed, `1` a scenario failed, `2`
a bad file, bad arguments or an unreachable instance. **A run resets the instance**, so `--url`
is always required. `within` is how long (in real time) an `expect` waits for your app; the
default is 5 seconds.

The console's **Scenarios** tab does the same as the CLI: load a file, paste JSON or pick a
shipped example; **Check** validates it without touching any state and lists what is wrong;
**Run…** warns that the instance will be reset, then shows each step (passed, failed or skipped),
the expected and observed values of a failed expectation, and a **Download JUnit XML** button
for that run.

## Graph request log

Every request your app makes to the **Graph port** (8888) is logged: successes and rejections
alike — a template that does not exist, a send blocked by a rule, an injected failure, a 404.
The console's **Requests** tab lists them live; click one for the detail.

Each entry records: simulator time, duration, method, path, query, status, the Meta error code
if any, the phone number ID (when the path starts with one) and the app the token belongs to.
The detail adds the request headers and body and the response body.

What is kept, and what is not:

- **Secrets are masked.** The bearer token is shown as dots and its last few characters only;
  any header, query or JSON key that looks like a secret (`token`, `secret`, `password`,
  `signature`, `api_key`, …) is replaced by `[masked]`; a media-URL token in a path keeps only its last few characters.
- **Bounded.** The newest 500 requests are kept; bodies are cut at 16,384 characters and marked
  as truncated.
- **A body that cannot be masked is not stored.** A request body that does not parse — malformed
  JSON, free text, or a bare JSON string or number — could hold a credential anywhere, so only its content type, size and the
  reason are kept (`kind: "omitted"`). The answer your app gets is unchanged.
- **Binary is never stored as text.** A media upload is described (content type, size, the form
  fields and file names) but its bytes are not kept.
- **Reset clears it**, and it is **not part of a state export**. Download it on its own:
  `GET /api/graph-requests/export` (also the **Download JSON** button), or clear it with
  `DELETE /api/graph-requests`.
- Calls to the control-plane port (8025) are not logged: this log is about your app.

## Control plane

`/api` is whaloc's own API — the web UI and test scripts drive the "user side" through it. It has
**no authentication** (the Graph surface next door accepts any bearer token), so do not expose the
port to a network you do not trust. Request and response schemas live in
`packages/shared/src/control-plane/`, imported by both the server and the UI.

| Endpoint                                                               | What it does                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /health`, `GET /api/health`                                       | Liveness (the root alias is what the Docker `HEALTHCHECK` hits)                                                                                                                                                                                                                                                                                  |
| `GET /api/state`                                                       | WABAs, phone numbers (with their lifecycle and any pending verification code), configured behavior, webhook target status                                                                                                                                                                                                                        |
| `GET /api/clock`, `POST /api/clock/advance\|set\|run-next`             | The virtual clock: where it is, what is pending, and moving it (see **Virtual clock and scenarios**)                                                                                                                                                                                                                                             |
| `POST /api/scenarios/validate\|run`                                    | Check or run a scenario file; `?format=junit` for a JUnit report                                                                                                                                                                                                                                                                                 |
| `POST /api/service-window/expire`                                      | Close one contact's customer service window now (see **Messaging rules**)                                                                                                                                                                                                                                                                        |
| `GET /api/graph-requests`, `GET /api/graph-requests/{id}`              | The Graph request log, newest first (`?limit=&before=&phoneNumberId=`), and one entry in full (see **Graph request log**)                                                                                                                                                                                                                        |
| `GET /api/graph-requests/export`, `DELETE /api/graph-requests`         | Download the whole log as JSON; clear it                                                                                                                                                                                                                                                                                                         |
| `POST /api/reset`                                                      | Wipe every table **and** the stored media, then re-apply the seed                                                                                                                                                                                                                                                                                |
| `GET /api/export?include=deliveries`                                   | The whole state as one downloadable JSON file, media bytes included (see **State snapshots**)                                                                                                                                                                                                                                                    |
| `POST /api/import`                                                     | Replace all state with such a file — JSON body or a `multipart/form-data` upload                                                                                                                                                                                                                                                                 |
| `GET/POST /api/contacts`, `PATCH /api/contacts/{waId}`                 | The WhatsApp users on the other side, with their optional business-scoped user ID                                                                                                                                                                                                                                                                |
| `POST /api/contacts/{waId}/change-number`                              | The person moved: the contact and its history follow, and `user_changed_number` goes out                                                                                                                                                                                                                                                         |
| `GET /api/conversations?phoneNumberId=`                                | One row per contact, with the last message                                                                                                                                                                                                                                                                                                       |
| `GET /api/conversations/{id}/messages`                                 | Paginated history, newest last                                                                                                                                                                                                                                                                                                                   |
| `POST /api/inbound`                                                    | Simulate a user message: text, media, `interactive` replies, `button`, location, contacts, reaction, `unsupported`; plus the context riders (`referral`, `forwarded`, `frequentlyForwarded`, `referredProduct`)                                                                                                                                  |
| `POST /api/inbound-media`                                              | Multipart upload used by an inbound media message                                                                                                                                                                                                                                                                                                |
| `GET /api/media/{id}`                                                  | The descriptor behind a media ID, so the UI can preview it                                                                                                                                                                                                                                                                                       |
| `GET /api/uploads?handle=`                                             | The same for a resumable-upload handle, which is what a template's `example.header_handle` carries                                                                                                                                                                                                                                               |
| `POST /api/messages/{id}/status`                                       | Manual `delivered` / `read` / `failed` (with an error preset)                                                                                                                                                                                                                                                                                    |
| `GET /api/message-error-presets`                                       | The failure codes that action accepts, with Meta's wording                                                                                                                                                                                                                                                                                       |
| `GET /api/typing?phoneNumberId=`                                       | The typing indicators the app under test currently has up (read-only — only it can raise one)                                                                                                                                                                                                                                                    |
| `GET /api/templates?status=&category=&language=&name=&search=`         | Templates with their status and quality score, narrowed by the same filters the Graph listing takes                                                                                                                                                                                                                                              |
| `POST /api/templates/{id}/approve\|reject\|pause\|disable\|quality`    | The moderation whaloc performs on Meta's behalf; each transition emits its webhook                                                                                                                                                                                                                                                               |
| `POST /api/phone-numbers/{id}/quality`                                 | Set quality/throughput, optionally emitting `phone_number_quality_update`                                                                                                                                                                                                                                                                        |
| `POST /api/phone-numbers/{id}/business-profile`                        | The business profile, as Settings edits it (camelCase; a blank field clears it)                                                                                                                                                                                                                                                                  |
| `GET/POST /api/injection-rules`, `DELETE /api/injection-rules/{id}`    | Deterministic error injection: target, trigger, preset (see **Error simulation**)                                                                                                                                                                                                                                                                |
| `GET /api/tokens`, `POST /api/tokens/{id}/expire\|restore`             | The `MOCKWA_TOKENS` registry, masked; expire one to get `401` / `190` / subcode `463`                                                                                                                                                                                                                                                            |
| `GET/POST /api/wabas`, `PATCH\|DELETE /api/wabas/{id}`                 | WABAs at runtime; `POST` takes an optional `id` so the account can match a production one; a delete cascades to phone numbers, messages, media and templates                                                                                                                                                                                     |
| `GET/POST /api/phone-numbers`, `PATCH\|DELETE /api/phone-numbers/{id}` | Numbers under a WABA — created here they are `CONNECTED` and can send immediately; `POST` takes an optional `id` too                                                                                                                                                                                                                             |
| `GET /api/webhook-deliveries?limit=&before=`                           | The delivery log, newest first                                                                                                                                                                                                                                                                                                                   |
| `POST /api/webhook-deliveries/{id}/redeliver`                          | Send a stored body again, to the app's current URL, re-signed now                                                                                                                                                                                                                                                                                |
| `POST /api/webhook-deliveries/{id}/cancel-retry`                       | Stop retrying that delivery's chain                                                                                                                                                                                                                                                                                                              |
| `GET/POST /api/apps`, `PATCH\|DELETE /api/apps/{key}`                  | Apps and their routing; secrets are write-only (`hasAppSecret`, never the value); the default app is read-only                                                                                                                                                                                                                                   |
| `PUT\|DELETE /api/apps/{key}/subscriptions/{wabaId}`                   | Subscribe an app to a WABA, with an optional WABA override (`overrideCallbackUri`, `verifyToken`)                                                                                                                                                                                                                                                |
| `PUT\|DELETE /api/apps/{key}/phone-overrides/{phoneNumberId}`          | An app's override for one number                                                                                                                                                                                                                                                                                                                 |
| `POST /api/apps/{key}/handshake`, `GET /api/webhook-routes`            | Check an app's URL with `hub.challenge`; ask where an event would go and why                                                                                                                                                                                                                                                                     |
| `POST /api/webhook/handshake`, `POST /api/webhook/raw`                 | Run the `hub.challenge` handshake; send arbitrary (still signed) JSON                                                                                                                                                                                                                                                                            |
| `POST /api/webhook/account-update`                                     | Emit `account_update` for a WABA: `VERIFIED_ACCOUNT`, `DISABLED_UPDATE`, `ACCOUNT_RESTRICTION` (with `restriction_info`), `ACCOUNT_DELETED`, `ACCOUNT_VIOLATION` — an event only, no state change                                                                                                                                                |
| `POST /api/webhook/business-capability-update`                         | Emit `business_capability_update` with `max_daily_conversation_per_phone` and `max_phone_numbers_per_business` — likewise an event only                                                                                                                                                                                                          |
| `GET /api/ws`                                                          | WebSocket: `message.created`, `message.status_changed`, `typing.changed`, `template.changed`, `webhook.delivery`, `contact.changed`, `waba.changed`, `phone_number.changed`, `injection.changed`, `token.changed`, `webhook_routing.changed`, `clock.changed`, `service_window.changed`, `graph_request.logged`, `state.reset`, `state.imported` |

## Webhooks

whaloc delivers webhooks to `MOCKWA_WEBHOOK_URL` with `Content-Type: application/json`,
`User-Agent: facebookexternalua` and — when `MOCKWA_APP_SECRET` is set — `X-Hub-Signature-256`.
The body is serialized once with Meta's `\uXXXX` escaping and **those exact bytes are what is
signed and sent**, so a receiver that verifies the signature the way Meta documents it accepts
whaloc's payloads unchanged. `docs/fixtures/webhooks/` holds the captured Meta samples the
payload builders are tested against.

The events it can send: inbound messages of every type (including `unsupported`, and with the
click-to-WhatsApp `referral` and the forwarded/`referred_product` context riders), statuses,
`user_changed_number`, `message_template_status_update`, `message_template_quality_update`,
`phone_number_quality_update`, `account_update`, `business_capability_update`, and anything at all
through `POST /api/webhook/raw`.

The last two are **account-level and emission-only**: sending `ACCOUNT_RESTRICTION` does not put
whaloc into a restricted state, and the capability numbers are not a quota. What they exist for is
your webhook handler — inventing state Meta would then contradict (a whaloc that refused to send
"because it is restricted") would cost more than it buys. Trigger them per WABA in **Settings →
Accounts**, or from the control plane.

### Several apps, overrides and routing

One WABA can feed several Meta apps, and mockwa plays them all (SPEC §3, "Apps and routing"):

- The **default app** is the one the environment describes (`MOCKWA_WEBHOOK_URL`,
  `MOCKWA_APP_SECRET`, `MOCKWA_WEBHOOK_VERIFY_TOKEN`). A single-URL setup works as before.
- **More apps** come from `MOCKWA_APPS` or from **Settings → Apps & webhooks**. Each has its own
  callback URL, App Secret and Verify Token, and gets its own copy of every webhook of the WABAs it
  is subscribed to, **signed with its own secret**:

  ```yaml
  MOCKWA_APPS: >-
    [{"name":"Billing","appSecret":"billing-secret","verifyToken":"billing-verify",
      "callbackUrl":"http://billing:3001/webhook","accessToken":"billing-token",
      "wabas":["102290129340398"]}]
  ```

- **Overrides** work as on Meta: `POST /{waba}/subscribed_apps` with `override_callback_uri` and
  `verify_token`, or `POST /{phone-number}` with `webhook_configuration`. A number's override wins
  over its WABA's, which wins over the app's URL. Overrides move `messages` (and the other
  overridable fields); **template and account webhooks always go to the app's own URL**. The
  Graph call acts on the app whose `accessToken` it sends, otherwise on the default app.
- `GET /api/webhook-routes?wabaId=&phoneNumberId=&field=messages` tells you where an event would go
  right now, and why.

### Retries

As on Meta, **only an HTTP `200` counts as delivered**. A `500`, a `404`, even a `204`, a refused
connection or a timeout is retried, slower each time, for up to 7 days: 10 s, 30 s, 1 m, 5 m,
15 m, 1 h, 3 h, 6 h, 12 h, then every 24 h (`MOCKWA_WEBHOOK_RETRY_SCHEDULE`,
`MOCKWA_WEBHOOK_RETRY_MAX_AGE`; `MOCKWA_WEBHOOK_RETRY_SCHEDULE=off` turns retries off). A retry
sends the same bytes with the same signature, so your handler can deduplicate.

The retry queue lives in SQLite. **With a file database a pending retry survives a restart** and
goes out when it is due. The Webhooks view shows each attempt's app, its status, and when the next
retry is due, with a **Cancel retry** button.

To watch it happen, make the example echo app fail on purpose:

```sh
curl -X PUT localhost:3001/fail -d '{"status":500,"count":2}'   # the next 2 deliveries get a 500
curl -X DELETE localhost:3001/fail                              # back to normal
```

### Other behaviors

- **Every attempt is logged**, browsable through `GET /api/webhook-deliveries`. Retries are
  separate rows of one chain (`chainId`), with `attempt` counting up.
- **An app without a URL gets skipped deliveries that are still logged** — the row carries the
  payload and headers that would have gone out (`skipped: true`, empty `url`), so the UI is useful
  before an integration exists. `POST /api/webhook-deliveries/:id/redeliver` sends a stored body
  to the app's current URL, re-signed with its current secret.
- **Status and template timers live in memory.** A pending status ladder or template approval is
  dropped on restart (SPEC §4). Webhook retries are the exception: they are stored.
- **`POST /api/reset` is a full wipe**: every table is emptied _and the stored media files are
  deleted_, then `MOCKWA_SEED` is applied again. Seeded IDs are derived deterministically, so
  they survive the reset and a configured `GRAPH_API_BASE_URL` keeps working. `POST /api/import`
  is the same wipe **without** the re-seed — see **State snapshots**.

## Web UI

The React bundle is served at `/` by the same port as everything else, with a SPA fallback that
never shadows `/api`, `/v*.*`, `/whaloc-media` or `/health`. Seven views, all live over `/api/ws`
and none of them polling.

One **top bar** frames them: the brand, the scope, the tabs, the simulator clock and the live indicators, with
the content full width underneath. The scope is a breadcrumb — **WABA ▾ / number ▾** — and it
goes exactly as deep as the view needs it: Chats is scoped to a number, Templates to an account,
Webhooks, Requests, Clock, Scenarios and Settings to nothing at all. Each segment is a menu of what exists, ending in the
action that creates the next one ("Create WABA…", "Add number…" — the same dialogs Settings
uses), so a whaloc with nothing in it can be filled in from the bar.

The scope lives in the **URL**, so a deep link and a reload land where you left off:

| View      | Route                                                                                     |
| --------- | ----------------------------------------------------------------------------------------- |
| Chats     | `/w/{waba-id}/p/{phone-number-id}/chats/{contact-wa-id}` (the last two segments optional) |
| Templates | `/w/{waba-id}/templates`                                                                  |
| Webhooks  | `/webhooks`                                                                               |
| Requests  | `/requests`                                                                               |
| Clock     | `/clock`                                                                                  |
| Scenarios | `/scenarios`                                                                              |
| Settings  | `/settings`                                                                               |

`/` and the bare `/chats` and `/templates` redirect into the scope this browser used last (or the
first WABA that has a number). A path naming a WABA or a number that is gone — deleted here, in
another tab, or by a reset — redirects to the closest scope that still exists and says so, and a
deletion arriving over the WebSocket moves the URL the same way.

- **Chats** — the conversations of a phone number, rendered like a messenger with day separators
  and status ticks. The header carries the contact's BSUID when it has one, and the
  "Changed number…" action that emits Meta's `user_changed_number` (the open conversation follows
  the person). The composer acts as the **WhatsApp user**: text, media (uploaded, then
  rendered inline), location, reactions, interactive button/list replies, template button
  payloads, contact cards, and an **unsupported** message (Meta's `131051` placeholder for a poll
  or whatever WhatsApp ships next). A collapsed **Extras** panel under the type tabs adds the
  context riders to any of them — forwarded, frequently forwarded, a click-to-WhatsApp `referral`
  and a `referred_product` — and survives a type switch, because it describes how the message
  arrived rather than what is in it. An interactive menu the app under test sent can be answered
  in place: tapping a reply button or a list row sends that `button_reply` / `list_reply` with its
  ID, quoting the menu, and a `cta_url` button opens its link. A template's quick-reply button
  answers the same way: the tap sends the `button` message with the payload the send gave it. Each outbound message has the manual half of the status ladder on
  it — mark delivered, mark read, or fail with one of the error presets. The other direction
  shows what the app under test did: a faint double check on the user's message once it called
  the read receipt, and a typing bubble (also `typing…` in the conversation list) while it has a
  typing indicator up. The header also shows the service window by simulator time (with
  **Expire now**) and an **Open phone** link that opens the Virtual Phone as exactly this
  contact in this business chat, in a new tab.
- **Templates** — the review a Meta moderator would perform: approve, reject with
  `rejection_info`, pause, disable, push a quality update; with the components JSON beside a
  rendered preview that marks every `{{placeholder}}` and renders a media header from the
  `example.header_handle` it was created with. The filter bar (search, status, category)
  narrows the list **server-side**, through the same filters the Graph listing takes.
- **Webhooks** — the delivery log, expandable into the exact signed bytes, the outcome in words
  (delivered, retrying, failed, skipped), and what is known about the signature: mockwa says
  "signature generated" when it signed the body, never "verified" — only your receiver knows
  whether it checked it. Each row also shows the app each copy
  went to, when the next retry is due (with **Cancel retry**), redeliver, the `hub.challenge`
  handshake, and a raw payload sender.
- **Requests** — the Graph request log (see **Graph request log**): every call your app made to
  8888 with its status and error code, expandable into masked headers and bodies.
- **Clock** — the simulator clock and its controls (see **Virtual clock and scenarios**).
- **Scenarios** — check and run a scenario, read its step report, download JUnit XML.
- **Settings → Apps & webhooks** — starts with three steps in plain words: which apps
  get a webhook (the WABA's subscribers), where each copy goes (phone-number override, then WABA
  override, then the app's callback URL), and which app a Graph call counts as (the one whose
  token it carries). Then the apps, which WABAs each is subscribed to, which credentials
  are set (never their values), a handshake per app, and the WABA and phone-number overrides.
- **Settings** — the WABA and phone-number IDs (with copy buttons, since a `GRAPH_API_BASE_URL`
  call needs them), grouped by account: add, rename and delete WABAs, add, edit and delete phone
  numbers (destructive actions are confirmed and say what goes with them), status and
  verification badges, and — while a Graph `request_code` is outstanding — the verification code
  whaloc would have texted, ready to copy into `verify_code`. Each number also carries the
  **business profile** the Graph endpoint publishes, editable in place, and each WABA says
  whether an app has subscribed to its webhooks and carries the **account webhooks** card
  (`account_update` with its five events and `restriction_info`, `business_capability_update` with
  its two limits) — both emissions only. Plus quality/throughput editing, contacts, the
  behavior the environment configured, **error injection** (arm a rule, watch its countdown, delete
  it), the **access tokens** section when `MOCKWA_TOKENS` is set, and a danger zone holding the
  **state snapshot** controls (export the whole world to a file, import one back) next to the
  reset. Contacts are edited in place — profile name, role and business-scoped user ID — and each one
  can change number.

### Virtual phone

`http://localhost:8025/phone` is a second page on the console port: WhatsApp from the **user's**
side, one contact per browser tab. The developer console is unchanged next to it.

1. Pick who you are. Every contact is an identity, shown with its name, its **role** (for example
   `CUSTOMER` or `TECHNICIAN`) and its number. There is no login in developer mode.
2. Open a business chat. Every business phone number is listed, so a new identity can start a
   conversation.
3. Type and send. Your message goes to your app as a normal signed inbound webhook. Your app's
   replies through the Graph API (8888) appear live, with timestamps; your own messages show
   their ticks.
4. Tap a template's quick reply or an interactive reply button to answer it: the reply webhook
   quotes the message, exactly like a real tap.

Every reply comes from **your app**, never from mockwa: a phone's message is a signed webhook to
`MOCKWA_WEBHOOK_URL`, and what comes back is whatever your app sends through the Graph API. With
no receiver configured, messages are stored and shown, nothing answers them, and the delivery log
says the payload was not sent. The console's top bar always names the receiver (or says
"webhooks: not sent"). The `echo: …` replies in the examples come from
[`examples/echo-app`](examples/echo-app/server.mjs), a separate process the end-to-end tests start.

While a chat is open in a visible tab, business messages are marked **read** as soon as they are
delivered, and your app receives each `read` status webhook. Open more tabs (or browser
profiles) to run several phones at once: each tab keeps its own identity in its URL
(`/phone?as=<wa_id>&chat=<phone-number-id>`) and only hears its own conversations.

Roles and friendly numbers come from the seed (`"role"` and `"displayNumber"` on a contact, see
[`e2e/fixtures/m1-seed.json`](e2e/fixtures/m1-seed.json)) or from **Settings → Contacts**. They are
display-only: no webhook or Graph response carries them.

While any injection rule can still fire, the top bar carries a pulsing "N rules injecting errors"
badge that links straight to the rule doing it — a forgotten rule should cost seconds, not an
afternoon.

### Public demo mode

`MOCKWA_MODE=public` lets anonymous visitors try your app through the Virtual Phone, each in
their own private corner of one shared instance. Everything stays local unless you put it behind
a proxy yourself; the full contract is [SPEC §5](docs/SPEC.md#public-demo-mode-m6) and the
route-by-route inventory is [docs/access.md](docs/access.md).

```sh
docker run --rm -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -e MOCKWA_MODE=public \
  -e MOCKWA_ADMIN_TOKEN=change-me-to-something-long \
  -e MOCKWA_TOKENS=my-app-token \
  -e MOCKWA_WEBHOOK_URL=http://host.docker.internal:3001/webhook \
  -e MOCKWA_APP_SECRET=my-app-secret \
  --add-host=host.docker.internal:host-gateway \
  ghcr.io/loongest/mockwa:latest
```

[`examples/public-demo`](examples/public-demo/docker-compose.yml) runs the same thing with the
echo app as the app under test.

What a visitor sees, at `http://127.0.0.1:8025/phone`:

1. **Start demo.** The visitor gets fresh phone numbers of its own (by default a `CUSTOMER` and a
   `TECHNICIAN`, starting with `999`). Nobody else's numbers or chats are ever shown.
2. **Chat.** Messages, images and PDFs go to your app as normal signed webhooks; your app's
   replies (and its buttons) arrive live.
3. **Limits** are explained in place: too many messages, a file too large or of the wrong kind.
4. **Expiry.** After 30 minutes without activity (or on "Leave demo") the session ends and its
   numbers, messages and uploads are deleted. The page says so and offers a new demo.

What changes for the other two audiences:

- **Your app** talks to the Graph API (8888) exactly as before, but only with a token from
  `MOCKWA_TOKENS` (required in public mode). Webhook URLs come only from the configuration:
  `override_callback_uri` is refused.
- **You, the admin**, reach the console at `http://127.0.0.1:8025/admin` (sign in with
  `MOCKWA_ADMIN_TOKEN`) or call the API with `Authorization: Bearer <token>`. Without it, every
  console API answers `401` and every console page `404` — visitors cannot reach state, export,
  logs, settings, apps, templates, rules, the clock, scenarios or reset.

Public mode runs on the real clock (`MOCKWA_CLOCK=virtual` is refused) and still keeps one
SQLite database for everyone. Visitor sessions survive a restart; rate-limit windows and admin
sign-ins do not.

**HTTP or HTTPS.** mockwa itself speaks plain HTTP. Cookies are HttpOnly and SameSite=Strict;
with `MOCKWA_COOKIE_SECURE=auto` they are marked `Secure` only when the request came over HTTPS,
so a local `http://127.0.0.1` demo works. Behind an HTTPS reverse proxy, list the proxy's address
in `MOCKWA_TRUSTED_PROXIES` (so its `X-Forwarded-For` and `X-Forwarded-Proto` are believed, and
per-visitor limits see real client addresses) and, unless it forwards `X-Forwarded-Host`, put the
public origin in `MOCKWA_ALLOWED_ORIGINS`. Public hosting itself is beyond this release.

## Development

Requires **Node 24**.

```sh
npm install       # or `npm ci`, to install exactly what package-lock.json pins
npm run dev       # server on :8888 + :8025 (native TypeScript, watch mode) + Vite on :5173
```

With `npm run dev` the UI is served by Vite on <http://localhost:5173>, which proxies `/api`,
`/api/ws` and `/whaloc-media` to the console port and `/v*.*` to the Graph port; the server's own `/` stays unrouted until
`npm run build` produces a bundle for it.

| Script              | What it does                                           |
| ------------------- | ------------------------------------------------------ |
| `npm run dev`       | Server watcher and Vite dev server, in parallel        |
| `npm run build`     | `tsc` for shared/server, `vite build` for web          |
| `npm test`          | vitest, per package (see the S3 note below)            |
| `npm run lint`      | ESLint (typescript-eslint strict + unicorn + prettier) |
| `npm run typecheck` | `tsc --noEmit`, per package                            |
| `npm run format`    | Prettier over the repo                                 |
| `npm start`         | Runs the built server (`npm run build` first)          |

Anything can also be run for one package with `--workspace`, e.g.
`npm run test:watch --workspace @mockwa/web`. Order matters in exactly one place: `shared` has to
be built before `server` and `web`, because a build resolves it to `dist/` — the root `build`
script therefore names the three in order rather than leaving it to npm, which runs workspace
scripts in manifest order and not topologically.

The S3 media backend is tested against a **real** S3-compatible server, so those specs are
opt-in: with `WHALOC_TEST_S3_ENDPOINT` unset they skip themselves (with a line saying so) and
`npm test` is green on a machine without Docker. CI runs them against a `rustfs` service
container; locally it takes one command:

```sh
docker run -d --name whaloc-rustfs -p 9000:9000 \
  -e RUSTFS_ACCESS_KEY=whaloc -e RUSTFS_SECRET_KEY=whaloc-secret rustfs/rustfs:1.0.0
WHALOC_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm test --workspace @mockwa/server
```

The bucket (`whaloc-test`) is created by the spec itself. RustFS's image serves `/data` from its
default `CMD`, which is what a GitHub Actions service container needs, since those cannot pass a
command.

| Package           | What it is                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| `packages/shared` | zod schemas and types shared by the server and the web UI               |
| `packages/server` | Hono app: Graph API mock, control-plane API + WebSocket, static UI host |
| `packages/web`    | React 19 + Vite UI, a pure client of the control-plane API              |

The server runs its TypeScript sources directly (`node --experimental-transform-types`), so the
code must stay erasable: no enums, namespaces or parameter properties, and relative imports keep
their `.ts` extension. Workspace packages are consumed from source in dev and test through the
`development` export condition, and from `dist/` in a build. The image needs no such flag — it
runs the `tsc` output — only `--disable-warning=ExperimentalWarning`, because `node:sqlite` is
still flagged in Node 24.

```sh
docker build -t whaloc:local .          # non-root, HEALTHCHECK on /health
docker compose up                       # the demo above, against the published image
```

The end-to-end checks drive a **built image** from the outside, with
[`examples/echo-app`](examples/echo-app/server.mjs) as the app under test (it verifies every
signature and replies through 8888). CI (`.github/workflows/docker.yml`) runs four instances.
**Every suite needs its targets named explicitly** — `GRAPH_URL`, `CONSOLE_URL`, `ECHO_URL` for
M0, the `M1_*`, `M2_*` and `M3_*` ones for the others, and the container a restart check may
stop — with no defaults, so a suite can never reach a mockwa you are using: a missing or portless
one stops it before its first request (`npm run test:e2e-targets` proves that). To run the
virtual-phone suite locally against a dedicated container seeded from `e2e/fixtures/m1-seed.json`:

```sh
docker build -t mockwa:local .
PORT=3102 APP_SECRET=m1-app-secret VERIFY_TOKEN=m1-verify-token \
  GRAPH_API_BASE_URL=http://127.0.0.1:47888/v25.0 node examples/echo-app/server.mjs &
docker run -d --name mockwa-test-m1 --add-host=host.docker.internal:host-gateway \
  -p 127.0.0.1:47888:8888 -p 127.0.0.1:47025:8025 \
  -v "$PWD/e2e/fixtures/m1-seed.json:/seed/m1-seed.json:ro" -e MOCKWA_SEED_FILE=/seed/m1-seed.json \
  -e MOCKWA_WEBHOOK_URL=http://host.docker.internal:3102/webhook -e MOCKWA_APP_SECRET=m1-app-secret \
  -e MOCKWA_WEBHOOK_VERIFY_TOKEN=m1-verify-token mockwa:local
M1_CONSOLE_URL=http://127.0.0.1:47025 M1_ECHO_URL=http://127.0.0.1:3102 \
  npx playwright test -c e2e/playwright.config.mjs --project m1-phone   # PLAYWRIGHT_CHANNEL=chrome for local Chrome
```

The S3 client is the one heavy dependency in the image (about 26 MB of the total): it ships
either way, because which media backend runs is an environment variable and not a build flag.

## Contributing

Issues and pull requests are welcome. Three things keep whaloc trustworthy, and a change is
measured against them:

- **[docs/SPEC.md](docs/SPEC.md) is the behavioral contract.** Meta-facing behavior — envelopes,
  error codes, webhook shapes, pagination semantics — should match what Meta actually does, and
  the captured samples and fixtures under `docs/fixtures/` are the evidence. A faithful quirk
  beats a tidy invention.
- **Deterministic by default.** Nothing fails, drops or changes state randomly; every failure is
  asked for. A feature that needs chance should be an explicit, inspectable rule instead.
- **Seeded IDs are a stable contract.** Downstream setups pin them (see the note on
  `DEFAULT_SEED`); changing a seed's natural keys changes the derived IDs and breaks those setups
  silently.

`npm install && npm test` is the whole loop (see [Development](#development)); `npm run lint`,
`npm run typecheck` and `npm run format:check` are what CI runs. New behavior comes with tests —
route-level through `app.request()`, webhook payloads asserted against fixtures.

## Acknowledgments

mockwa is a fork of [**dgadelha/whaloc**](https://github.com/dgadelha/whaloc), MIT-licensed:
the engine, the Meta fixtures, the signing and the console are whaloc's work, and its copyright
notice stays in [LICENSE](LICENSE). The acknowledgment below is whaloc's own.

whaloc owes its shape to [**fdarian/whap**](https://github.com/fdarian/whap), an MIT-licensed
WhatsApp Cloud API mock that got there first: the split between a control plane and a UI that is
a pure client of it, the WebSocket event bus behind that, and — most concretely — its approach to
Meta's `X-Hub-Signature-256`. Meta escapes every code point above U+007F as `\uXXXX` _before_
hashing and signs exactly the bytes it sends, which is the kind of detail you discover by losing
an afternoon to it. whap had already lost that afternoon; whaloc's
`packages/server/src/domain/meta-json.ts` is a port of its
`src/server/middleware/hmac-signature.ts` (`Bun.CryptoHasher` swapped for `node:crypto`), and
whap's test vectors are carried over unchanged in the spec beside it.

whaloc diverges deliberately: a web UI instead of a TUI, Meta-faithful error envelopes
everywhere, deterministic behavior with no random failures, media, and configuration through the
environment only. Thanks to [@fdarian](https://github.com/fdarian) all the same.

The WhatsApp Cloud API is Meta's; whaloc is an independent reimplementation for local
development, unaffiliated with and unendorsed by Meta. The specs vendored under
`docs/meta-openapi/` are Meta's own, published under the
[Meta Platform Terms](https://developers.facebook.com/terms) and kept here for reference; the MIT
license below covers whaloc's code and documentation, not them.

## License

[MIT](LICENSE).
