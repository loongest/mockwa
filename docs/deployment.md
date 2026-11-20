# Deploying mockwa

How to run mockwa somewhere other than your own laptop: a team instance in dev mode, or a public
demo behind an HTTPS reverse proxy. The behavioral contract is [SPEC](SPEC.md); who may reach
which route is [docs/access.md](access.md). Everything here was verified locally against the
built image; mockwa itself has not been run on a public host.

## Build the image

Releases are published only from `v*` tags (see README → Quickstart). Until the release you
want exists, build the image from a checkout:

```sh
docker build -t mockwa:local .
```

The image runs as the unprivileged `node` user, declares `/data` as a volume, listens on 8888
(Graph) and 8025 (console), and has a `HEALTHCHECK` on `/health`.

## Dev mode (one team, trusted network)

Dev mode (`MOCKWA_MODE=dev`, the default) is a simulator for developers: anyone who reaches the
console can read and change everything. Keep it on `127.0.0.1` or a private network. If more
people than you can reach it, set `MOCKWA_ADMIN_TOKEN` (16+ characters): the whole console
listener, the developer phone included, then needs that token (bearer header, or the `/admin`
sign-in).

## Public mode behind an HTTPS reverse proxy

```text
  browser ──HTTPS──▶ reverse proxy ──HTTP──▶ mockwa :8025   (phone, /admin, console)
                                             mockwa :8888 ◀──HTTP── app under test (private network)
                                               │
                                               └──webhooks──▶ app under test
```

mockwa speaks plain HTTP and never terminates TLS. The proxy is responsible for:

1. **TLS.** Serve HTTPS only and redirect HTTP to it.
2. **Only the console listener is public.** Proxy to port 8025. Never expose 8888: the Graph
   listener is for the app under test, on a private network.
3. **WebSockets.** Pass `Upgrade` and `Connection` through for `/api/phone/identities/*/ws` (the
   visitor phone) and `/api/ws` (the admin console), with a read timeout of a few minutes.
4. **Forwarded headers.** Set `X-Forwarded-For` (append the client's address), and
   `X-Forwarded-Proto: https`. Optionally `X-Forwarded-Host`.
5. **Body size.** A cap a little above `MOCKWA_PUBLIC_MEDIA_MAX_BYTES` (1 MB by default) is
   enough; mockwa refuses anything larger itself, but the proxy can stop it earlier.
6. **Optional:** restrict `/admin` and the admin-only paths to your own network; mockwa already
   requires the admin token for them.

### Trusted proxy configuration

mockwa believes `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` **only** when the
TCP peer is an exact address in `MOCKWA_TRUSTED_PROXIES`. From any other peer these headers are
ignored, so a visitor cannot choose its own address to dodge the per-address limits.

- Set `MOCKWA_TRUSTED_PROXIES` to the proxy's address **as mockwa sees it** (the container's
  peer address, not the public IP). Only exact IPv4/IPv6 addresses, no ranges. In Docker
  Compose, give the proxy a fixed address on a defined subnet (example below).
- The client address is the right-most `X-Forwarded-For` entry that is not itself a trusted
  proxy. With one proxy that appends the real peer, that is the real client, whatever the
  client sent.
- If the entry is missing, every visitor appears to come from the proxy's address and the
  default limits (3 live sessions per address) refuse almost everyone. If the entry is wrong
  (a range that includes visitors, or the proxy does not append), visitors can choose their
  address. Check with the admin request log after deploying.
- `MOCKWA_COOKIE_SECURE=auto` (default) marks cookies `Secure` when the trusted proxy says
  `X-Forwarded-Proto: https`. Behind HTTPS you can also set `always`.
- The CSRF and WebSocket origin check compares `Origin` with the origin the browser used. If the
  proxy does not forward `X-Forwarded-Host`, put the public origin in `MOCKWA_ALLOWED_ORIGINS`
  (for example `https://demo.example.com`).

### Example: Docker Compose with Caddy

```yaml
services:
  proxy:
    image: caddy:2
    ports: ["443:443", "80:80"]
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data"]
    networks: { edge: { ipv4_address: 172.30.0.10 } }

  mockwa:
    image: mockwa:local
    volumes: ["mockwa-data:/data"]
    environment:
      MOCKWA_MODE: public
      MOCKWA_DB_PATH: /data/mockwa.db
      MOCKWA_ADMIN_TOKEN: ${MOCKWA_ADMIN_TOKEN}
      MOCKWA_TOKENS: ${MOCKWA_APP_TOKEN}
      MOCKWA_WEBHOOK_URL: http://app:3000/webhook
      MOCKWA_APP_SECRET: ${MOCKWA_APP_SECRET}
      MOCKWA_WEBHOOK_VERIFY_TOKEN: ${MOCKWA_VERIFY_TOKEN}
      MOCKWA_TRUSTED_PROXIES: 172.30.0.10
      MOCKWA_ALLOWED_ORIGINS: https://demo.example.com
      MOCKWA_COOKIE_SECURE: always
    networks: [edge, private]
    stop_grace_period: 15s

  app: # the app under test: calls http://mockwa:8888, receives webhooks
    networks: [private]

networks:
  edge: { ipam: { config: [{ subnet: 172.30.0.0/24 }] } }
  private: { internal: true }

volumes: { mockwa-data: {}, caddy-data: {} }
```

```text
# Caddyfile — Caddy sets X-Forwarded-For to the client it saw and X-Forwarded-Proto/-Host by default,
# and passes WebSocket upgrades through.
demo.example.com {
	request_body {
		max_size 2MB
	}
	reverse_proxy mockwa:8025
}
```

With nginx, the equivalent location needs `proxy_http_version 1.1`, `proxy_set_header Upgrade
$http_upgrade`, `proxy_set_header Connection $connection_upgrade`, `proxy_set_header
X-Forwarded-For $proxy_add_x_forwarded_for`, `proxy_set_header X-Forwarded-Proto $scheme`,
`proxy_read_timeout 300s` and `client_max_body_size 2m`.

## Admin access

- `MOCKWA_ADMIN_TOKEN` (16+ characters; use a long random value) is required in public mode.
  Scripts send it as `Authorization: Bearer …`; people sign in at `/admin`, which sets an
  HttpOnly, SameSite=Strict cookie for 12 hours (held in memory: a restart signs everyone out).
- 10 wrong tokens from one address in 15 minutes lock that address out for the rest of the
  window (`429 admin_auth_rate_limited`), even with the right token. The failure records of an
  address are dropped once its window has passed, whether or not it ever comes back.
- Rotating the token means restarting with a new value.

## Graph credentials

`MOCKWA_TOKENS` is the registry of bearer tokens the app under test may use (required in public
mode); any other token gets Meta's `401` error. Tokens and secrets never reach the process log,
and the Graph request log stores each token masked to its last four characters (`access_token`
query values too).

A state export (`GET /api/export`, admin only) is a whole mockwa: it **includes app
secrets, verify tokens and media URL tokens** so that an import restores a working instance.
Treat an export file as a secret.

## Webhook configuration

Webhooks go only to configured URLs: `MOCKWA_WEBHOOK_URL` and the apps in `MOCKWA_APPS`. In
public mode nothing at runtime can add a destination (the Graph overrides answer `400`, the
control plane `403 webhook_destinations_locked`). Set `MOCKWA_APP_SECRET` so every delivery is
signed, and verify `X-Hub-Signature-256` in the app over the raw body.

## Storage and persistence

- Set `MOCKWA_DB_PATH=/data/mockwa.db` and mount a volume on `/data`; the default `:memory:`
  forgets everything on restart. Media bytes live in `/data/media`, or in S3 with
  `MOCKWA_MEDIA_BACKEND=s3`.
- Back up the volume while the container is stopped (SQLite file plus media directory).
- A bind mount keeps the host's ownership: `chown 1000:1000` it.

## Limits

The defaults suit a small public demo. All are per instance.

| Variable                                   | Default | Meaning                                    |
| ------------------------------------------ | ------- | ------------------------------------------ |
| `MOCKWA_PUBLIC_SESSION_TTL`                | `30m`   | Idle time before a session and its data go |
| `MOCKWA_PUBLIC_MAX_SESSIONS`               | `500`   | Live sessions in total                     |
| `MOCKWA_PUBLIC_SESSIONS_PER_IP`            | `3`     | Live sessions per client address           |
| `MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE` | `10`    | New sessions per address per minute        |
| `MOCKWA_PUBLIC_MESSAGES_PER_MINUTE`        | `20`    | Messages per session per minute            |
| `MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE`     | `60`    | Messages per address per minute            |
| `MOCKWA_PUBLIC_MEDIA_MAX_BYTES`            | `1 MB`  | Largest upload                             |
| `MOCKWA_PUBLIC_MEDIA_PER_SESSION`          | `10`    | Uploads per session                        |

Fixed limits: 8 live sockets per session (counted before the upgrade completes, so a burst
cannot exceed it), 32 KB per visitor JSON body, 4 KB per sign-in body, 4,096 characters per
text message.

Many visitors behind one NAT (an office, a classroom) share an address; raise the per-address
limits for such an event rather than trusting more proxies.

### Load-test quotas

The 200-visitor load test (`e2e/m7-load.mjs`) runs every visitor from one machine, so one source
address. It raises only the per-address limits, on its own test container:
`MOCKWA_PUBLIC_SESSIONS_PER_IP=250`, `MOCKWA_PUBLIC_SESSION_CREATES_PER_MINUTE=250` and
`MOCKWA_PUBLIC_IP_MESSAGES_PER_MINUTE=3000`; the per-session limits stay at their defaults.
The default per-address limits are verified separately by `e2e/m7-hardening.mjs`. Never use the
load-test values on a public instance.

The run passes only if every measured send got its reply (no send error, timeout, unanswered
send, late or duplicate reply, or dropped socket), no visitor saw another's data, p95 stays under
1 s, memory stays flat and everything the visitors held is gone within 3 minutes of leaving; it
exits non-zero otherwise. The report it writes keeps the raw outcome of every send, and
`node e2e/load-verdict.mjs <report.json>` judges it again.

## Cleanup

A session ends after its idle TTL, when the visitor leaves, and on reset or import. Ending one
deletes its identities, messages, uploads, stored bytes and the webhook and request-log rows that
mention its numbers, and closes its sockets with code 4401. A webhook or Graph request still in
flight when its visitor leaves is not logged when it completes, and its failure queues no retry.
A sweep runs every quarter TTL, at most every minute (so every minute with the default 30-minute
TTL), and at boot. Each sweep trims the finished webhook deliveries to the newest 2,000; between
two sweeps the table grows by up to one minute of traffic (about 7,000 rows at 40 messages a
second). Expired admin sign-ins and failure windows are dropped by the next authentication
check, at most once a minute. `GET /api/public/stats` (admin) shows the live counts, the
admin side's included.

## Graceful shutdown

On `SIGTERM` or `SIGINT` (for example `docker stop`), mockwa stops accepting connections,
closes every WebSocket with `1001 Going Away` and closes the database, within 10 seconds.
Give the container a stop grace period above that (`stop_grace_period: 15s`; `docker stop`
waits 10 s by default). Webhook retries that are due later are stored and resumed after a
restart.

## Known limitations

- **Timers are not persisted.** The status ladder (`sent` → `delivered` → `read`), template
  auto-approval and typing indicators run on in-process timers; a restart drops the pending
  ones. Webhook retries are stored and survive.
- **In-memory windows.** Rate limits, the admin lockout and admin sign-ins reset on restart.
- **One instance.** There is no clustering; one process holds every session and socket.
- **S3 storage** is covered by opt-in tests that need an isolated S3-compatible endpoint
  (`WHALOC_TEST_S3_ENDPOINT`); they are skipped otherwise.
- **No TLS** in mockwa itself, and no audit log beyond the per-request log line.
- **Public mode is not deterministic:** visitor numbers are random and the clock is real.
