# Configuration

Every setting mockwa has, its default, the rules for combining them, and where state is kept.
mockwa is configured **only through environment variables**, read once at boot.

**On this page:** [How variables are read](#how-variables-are-read) ·
[Ports and addresses](#ports-and-addresses) · [Webhooks and apps](#webhooks-and-apps) ·
[Seed data](#seed-data) · [Time and the status ladder](#time-and-the-status-ladder) ·
[Graph tokens and media expiry](#graph-tokens-and-media-expiry) · [Messaging rules](#messaging-rules) ·
[Storage](#storage) · [Console, logs and access](#console-logs-and-access) ·
[Public mode limits](#public-mode-limits) · [The default seed](#the-default-seed) ·
[What survives what](#what-survives-what)

## How variables are read

- **Names.** Every variable is spelled `MOCKWA_*`. The whaloc spelling `WHALOC_*` is still read as
  an alias: `WHALOC_WEBHOOK_URL` means `MOCKWA_WEBHOOK_URL`, and so on.
- **One renamed alias.** `WHALOC_PORT` means `MOCKWA_GRAPH_PORT`, because whaloc's one port was the
  one apps called. There is **no** `MOCKWA_PORT`: it is ignored like any unknown name.
- **Both spellings set.** The `MOCKWA_*` value wins. When the two values differ, the boot log warns.
- **Blank values count as unset**, and values are trimmed. An empty `MOCKWA_WEBHOOK_URL=` in a
  Compose file turns webhooks off instead of failing.
- **Unknown names are ignored.** A typo does not fail the boot; check the boot log's
  configuration summary.
- **An invalid environment stops the boot.** mockwa prints `mockwa cannot start, the environment
is invalid:` with **every** problem, then exits.
- **Warnings do not stop it.** For example: no `MOCKWA_WEBHOOK_URL` (webhooks are not sent), no
  `MOCKWA_APP_SECRET` (deliveries are unsigned), `MOCKWA_S3_*` set with the `local` backend.
- **Secrets are never logged.** The boot summary says `set` or `unset` for each secret and counts
  tokens instead of printing them.

Durations are a whole number with a unit: `500ms`, `30s`, `5m`, `2h`, `7d`.

## Ports and addresses

| Variable              | Default                 | What it does                                                                                  |
| --------------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `MOCKWA_GRAPH_PORT`   | `8888`                  | Port of the Graph API listener. Legacy alias: `WHALOC_PORT`                                   |
| `MOCKWA_CONSOLE_PORT` | `8025`                  | Port of the console listener (UI, phone, `/api`, `/api/ws`). Must differ from the Graph port  |
| `MOCKWA_HOST`         | `0.0.0.0`               | Address both listeners bind to                                                                |
| `MOCKWA_PUBLIC_URL`   | `http://localhost:8888` | Base of every media URL and of `paging.next`. It must be reachable by whoever downloads media |

These are the ports **inside** the container. Docker's `-p 127.0.0.1:18888:8888` changes only the
host side; the container still listens on 8888, and another container in the same Compose
network still uses `http://<service>:8888`. Change `MOCKWA_*_PORT` only when the container port
itself must move. The image's `HEALTHCHECK` reads `MOCKWA_GRAPH_PORT` (or `WHALOC_PORT`) and
`MOCKWA_CONSOLE_PORT`, so set the console port under its `MOCKWA_*` name.

`MOCKWA_PUBLIC_URL` is a common mistake: from your computer `http://localhost:8888` works, but an
app in another container downloads media from `http://mockwa:8888`. The console loads previews
from its own origin, so previews keep working even when this value is wrong for your app.

## Webhooks and apps

| Variable                        | Default                              | What it does                                                                                                |
| ------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `MOCKWA_WEBHOOK_URL`            | unset: webhooks are not sent (warns) | The default app's webhook receiver, an `http(s)` URL                                                        |
| `MOCKWA_APP_SECRET`             | unset: deliveries unsigned (warns)   | HMAC key of `X-Hub-Signature-256`                                                                           |
| `MOCKWA_WEBHOOK_VERIFY_TOKEN`   | unset                                | Token sent in the `hub.challenge` handshake                                                                 |
| `MOCKWA_VERIFY_ON_START`        | `false`                              | Run the handshake once at boot (needs the verify token)                                                     |
| `MOCKWA_APP_ID`                 | derived, stable                      | The app ID `subscribed_apps` reports; 1–32 digits. Set it to your app's Meta app ID when your app checks it |
| `MOCKWA_APPS`                   | unset: only the default app          | JSON list of more apps, each with its own URL, secret, verify token, access token and WABAs                 |
| `MOCKWA_WEBHOOK_RETRY_SCHEDULE` | `10s,30s,1m,5m,15m,1h,3h,6h,12h,24h` | Delay before each retry; the last one repeats. `off` turns retries off                                      |
| `MOCKWA_WEBHOOK_RETRY_MAX_AGE`  | `7d`                                 | How long a delivery keeps being retried                                                                     |

A `MOCKWA_APPS` entry is
`{"id"?, "name", "appSecret"?, "verifyToken"?, "callbackUrl"?, "accessToken"?, "wabas"?: ["<waba id>"]}`.
Names, IDs and access tokens must be unique. An omitted `id` is derived from the name. Apps from
this variable are added at boot and after every reset when they are missing.

How webhooks are signed, routed and retried: [Webhooks](webhooks.md).

## Seed data

| Variable           | Default                                  | What it does                                       |
| ------------------ | ---------------------------------------- | -------------------------------------------------- |
| `MOCKWA_SEED`      | 1 WABA, 1 number, 2 contacts, 1 template | JSON array of WABAs to create at boot and on reset |
| `MOCKWA_SEED_FILE` | unset                                    | Path to a file holding the same JSON               |

- Set **one** of the two. Setting both is refused, so nothing is preferred silently.
- An empty or unreadable seed file is refused too, instead of falling back to the default seed.
- A seed **replaces** the default seed; it does not add to it.
- IDs a seed leaves out are derived from its natural keys, so they are stable.
- Seeded numbers start `CONNECTED` and verified. Seeded templates start `APPROVED`.

A working example, with the shape from [SPEC §7](SPEC.md#7-configuration-environment-variables-only):

```json
[
	{
		"name": "Test Shop",
		"phoneNumbers": [{ "displayPhoneNumber": "+60 3-2000 0001", "verifiedName": "Test Shop" }],
		"contacts": [{ "waId": "60123000001", "name": "Test User", "role": "CUSTOMER" }],
		"templates": [
			{
				"name": "my_template",
				"language": "en",
				"category": "UTILITY",
				"parameterFormat": "POSITIONAL",
				"components": [{ "type": "BODY", "text": "Hi {{1}}" }]
			}
		]
	}
]
```

Each WABA needs at least one phone number. Fields you may add:

| Where        | Field                              | Value                                                       |
| ------------ | ---------------------------------- | ----------------------------------------------------------- |
| WABA         | `id`                               | Digits. Left out, a stable ID is derived from the seed      |
| Phone number | `id`                               | Digits. Left out, a stable ID is derived from the seed      |
| Phone number | `qualityRating`, `throughputLevel` | `GREEN`, `YELLOW`, `RED` or `UNKNOWN`; `STANDARD` or `HIGH` |
| Contact      | `userId`                           | A BSUID such as `US.4KgQ2wJ8`                               |
| Contact      | `displayNumber`                    | How the number is shown, such as `+60 12-300 0001`          |

[`examples/integrations/`](../examples/integrations/) has two complete seed files.

## Time and the status ladder

| Variable                       | Default                    | What it does                                                                    |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `MOCKWA_CLOCK`                 | `real`                     | `real` follows the wall clock; `virtual` moves only when you move it            |
| `MOCKWA_CLOCK_START`           | `2026-01-01T00:00:00.000Z` | Where a virtual clock starts, and where a reset puts it. Needs a time zone      |
| `MOCKWA_STATUS_DELAYS`         | `sent:0,delivered:800`     | Status ladder timing in ms. Add `read:<ms>` to send read receipts automatically |
| `MOCKWA_TEMPLATE_AUTO_APPROVE` | `2000`                     | ms until a new template is approved; `off` leaves it `PENDING`                  |

The status delays are **steps, not times since the send**: each one counts from the previous
status. With `sent:0,delivered:800,read:1000`, `read` comes 1,800 ms after the send. Using the
clock in tests: [Testing → Move time](testing.md#move-time-with-the-virtual-clock).

## Graph tokens and media expiry

| Variable                   | Default                           | What it does                                                  |
| -------------------------- | --------------------------------- | ------------------------------------------------------------- |
| `MOCKWA_TOKENS`            | unset: any non-empty token passes | Comma-separated bearer tokens. When set, only these pass      |
| `MOCKWA_MEDIA_TTL_SECONDS` | unset: media never expires        | Seconds after which uploaded media is gone from the Graph API |

With `MOCKWA_TOKENS` set, a `MOCKWA_APPS` entry's `accessToken` passes only if it is in this list
too. Tokens may not repeat. More in [Testing → Expire or reject tokens](testing.md#expire-or-reject-tokens).

## Messaging rules

| Variable                 | Default | Values                                                                         |
| ------------------------ | ------- | ------------------------------------------------------------------------------ |
| `MOCKWA_SERVICE_WINDOW`  | `24h`   | A duration, or `off`                                                           |
| `MOCKWA_THROUGHPUT`      | `off`   | `off`, `meta` (per number: 80/s, or 1,000/s at `HIGH`), or messages per second |
| `MOCKWA_PAIR_RATE_LIMIT` | `off`   | `off`, `meta` (`6s/45`), or `<interval>/<burst>` such as `2s/3`                |
| `MOCKWA_MESSAGING_LIMIT` | `off`   | `off` (or `unlimited`), or a number of unique contacts per 24 hours            |

What each rule does, and which parts are Meta's and which are mockwa's:
[Testing → Messaging rules](testing.md#check-the-messaging-rules).

## Storage

| Variable                      | Default                                         | What it does                                               |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| `MOCKWA_DB_PATH`              | `:memory:`                                      | SQLite file. In memory, every restart starts from the seed |
| `MOCKWA_MEDIA_BACKEND`        | `local`                                         | `local` (a directory) or `s3` (an S3-compatible bucket)    |
| `MOCKWA_MEDIA_DIR`            | `/data/media` in the image, else `./data/media` | Media root for the `local` backend                         |
| `MOCKWA_S3_BUCKET`            | required for `s3`                               | The bucket. mockwa never creates it                        |
| `MOCKWA_S3_REGION`            | required for `s3`                               | Any value works for RustFS; the SDK needs one              |
| `MOCKWA_S3_ENDPOINT`          | unset: AWS S3                                   | Endpoint of an S3-compatible server (RustFS, R2, Ceph, …)  |
| `MOCKWA_S3_ACCESS_KEY_ID`     | unset: the SDK's default credentials            | Set both keys or neither                                   |
| `MOCKWA_S3_SECRET_ACCESS_KEY` | unset: the SDK's default credentials            | Set both keys or neither                                   |
| `MOCKWA_S3_FORCE_PATH_STYLE`  | `true` when an endpoint is set                  | `<endpoint>/<bucket>/<key>` addressing                     |

### Keep state on a volume

The image declares `/data` as a volume and runs as the `node` user (uid 1000).

```sh
docker run -d --name mockwa -p 127.0.0.1:8888:8888 -p 127.0.0.1:8025:8025 \
  -v mockwa-data:/data -e MOCKWA_DB_PATH=/data/mockwa.db \
  mockwa:local
```

A new named volume gets the right owner. A **bind** mount keeps the host's ownership, so run
`chown 1000:1000` on the host directory first. Back up while the container is stopped: copy the
SQLite file and the media directory together.

### Store media in S3

```yaml
services:
  rustfs:
    image: rustfs/rustfs:1.0.0
    environment:
      RUSTFS_ACCESS_KEY: whaloc
      RUSTFS_SECRET_KEY: whaloc-secret
    volumes: ["rustfs-data:/data"]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:9000/health"]
      interval: 2s
      retries: 30

  # mockwa never creates the bucket; this makes it once and exits.
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
    image: mockwa:local
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

Only where the bytes rest changes: downloads, `Range`, the upload cap and media expiry behave the
same. Object keys are the same opaque names the `local` backend uses, so a snapshot moves between
the two backends.

## Console, logs and access

| Variable                 | Default                        | What it does                                                                                     |
| ------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------ |
| `MOCKWA_WEB_DIR`         | the built UI beside the server | Where the console bundle is served from; an absent directory leaves `/` unrouted                 |
| `MOCKWA_LOG_LEVEL`       | `info`                         | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`                                   |
| `MOCKWA_MODE`            | `dev`                          | `dev` or `public` (anonymous visitors on the virtual phone)                                      |
| `MOCKWA_ADMIN_TOKEN`     | unset                          | At least 16 characters. Required in public mode; in dev mode it puts the whole console behind it |
| `MOCKWA_TRUSTED_PROXIES` | unset                          | Exact IP addresses of reverse proxies whose `X-Forwarded-*` headers are believed                 |
| `MOCKWA_ALLOWED_ORIGINS` | unset: the listener's own      | More browser origins allowed to write with a visitor or admin cookie                             |
| `MOCKWA_COOKIE_SECURE`   | `auto`                         | `auto` (Secure over HTTPS), `always` or `never`                                                  |

**Public mode refuses to start** unless all of these hold:

- `MOCKWA_ADMIN_TOKEN` is set (16+ characters);
- `MOCKWA_TOKENS` is set, so the Graph API does not accept any token;
- `MOCKWA_CLOCK` is `real`.

A short admin token is refused in dev mode too. Who can reach what in each mode:
[API reference → Authentication](api-reference.md#authentication) and [access rules](access.md).
Running a public instance behind HTTPS: [Deployment](deployment.md).

## Public mode limits

These apply only when `MOCKWA_MODE=public`.

| Variable                                   | Default                         | What it limits                                         |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------ |
| `MOCKWA_PUBLIC_IDENTITIES`                 | a `CUSTOMER` and a `TECHNICIAN` | JSON `[{"role","name"}]`, 1–4 entries, roles unique    |
| `MOCKWA_PUBLIC_WA_ID_PREFIX`               | `999`                           | First digits of visitor numbers (15 digits in all)     |
| `MOCKWA_PUBLIC_SESSION_TTL`                | `30m`                           | Idle time before a visitor's session and data are gone |
| `MOCKWA_PUBLIC_MESSAGES_PER_MINUTE`        | `20`                            | Messages per session per minute                        |
| `MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE`     | `60`                            | Messages per client address per minute                 |
| `MOCKWA_PUBLIC_MEDIA_MAX_BYTES`            | `1048576`                       | Largest upload (JPEG, PNG, WebP or PDF)                |
| `MOCKWA_PUBLIC_MEDIA_PER_SESSION`          | `10`                            | Uploads per session                                    |
| `MOCKWA_PUBLIC_SESSIONS_PER_IP`            | `3`                             | Live sessions per client address                       |
| `MOCKWA_PUBLIC_MAX_SESSIONS`               | `500`                           | Live sessions in total                                 |
| `MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE` | `10`                            | New sessions per client address per minute             |

## The default seed

Without `MOCKWA_SEED` or `MOCKWA_SEED_FILE`, mockwa creates:

| What         | Value                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| WABA         | `666635535888644`, "whaloc Test Business"                                                                  |
| Phone number | `573542517421694`, `+55 11 91234-5678`, `CONNECTED`, quality `GREEN`, throughput `STANDARD`                |
| Contacts     | `5571990000001` Ana Souza (BSUID `BR.ENT.AnaSouza01`), `5571990000002` Bruno Lima (BSUID `BR.BrunoLima01`) |
| Template     | `355867425910125`: `hello_whaloc`, language `en`, `UTILITY`, `APPROVED`, **no parameters**                 |

These IDs are derived from the seed's names and digits, and are a **stable contract**: the same on
every machine, after every reset, and across versions. Tests in this repository pin them. The
boot log prints them (`seed applied`), and the console's **Settings** view shows them with copy
buttons.

A template is found by **name and language**, not by ID. An app whose template has a different
name, language or number of parameters needs its own seed: the default `hello_whaloc` takes no
parameters, so a send with one parameter fails with `132000`.

## What survives what

"File database" means `MOCKWA_DB_PATH` points at a file on a volume.

| What                                                      | Restart, file database     | Restart, `:memory:` | `POST /api/reset`          | `POST /api/import`                          | In a snapshot (export)          |
| --------------------------------------------------------- | -------------------------- | ------------------- | -------------------------- | ------------------------------------------- | ------------------------------- |
| WABAs, numbers, contacts, templates, messages             | kept                       | lost, seed again    | wiped, seed again          | replaced by the snapshot                    | yes                             |
| Media rows and bytes                                      | kept (bytes on the volume) | rows lost           | wiped                      | replaced                                    | yes, bytes base64-inlined       |
| Apps, subscriptions, overrides (secrets included)         | kept                       | lost                | wiped, `MOCKWA_APPS` again | replaced                                    | yes                             |
| Injection rules, expired-token marks                      | kept                       | lost                | wiped                      | replaced                                    | yes                             |
| Webhook delivery log                                      | kept                       | lost                | wiped                      | replaced (empty unless the snapshot has it) | only with `?include=deliveries` |
| Pending webhook retries                                   | kept, resumed when due     | lost                | dropped                    | cancelled                                   | no                              |
| Virtual clock position                                    | kept                       | back to start       | back to start              | unchanged                                   | no                              |
| Status ladder, template auto-approval, typing timers      | **lost**                   | lost                | dropped                    | dropped                                     | no                              |
| Throughput and pair-rate counters                         | lost                       | lost                | cleared                    | cleared                                     | no                              |
| Service windows closed by hand ("Expire now")             | kept                       | lost                | cleared                    | cleared                                     | no                              |
| Graph request log                                         | kept                       | lost                | wiped                      | kept                                        | no (export it on its own)       |
| Public mode: visitor sessions and their data              | kept                       | lost                | ended                      | ended                                       | no                              |
| Public mode: rate-limit windows, admin sign-ins, lockouts | lost (memory only)         | lost                | admin side unchanged       | admin side unchanged                        | no                              |

So a snapshot is a picture of the **data**, for sharing a reproduction. It is not a full backup of
a running instance: it has no clock position, no pending retries or timers, no request log and no
sign-ins. To back up an instance, stop it and copy its volume.

A reset, an import and a scenario run all **replace everything**. Do not run them against an
instance someone else is using.
