# Development

How to work on mockwa itself: set it up, run it, test it, find your way in the code, and how a
release is published. To use mockwa for your own app, start at [Getting started](getting-started.md).
The rules for changing the code are in [AGENTS.md](../AGENTS.md); the behavior it must have is
[SPEC](SPEC.md).

**On this page:** [Set up](#set-up) · [Run it from source](#run-it-from-source) ·
[Run the checks](#run-the-checks) · [Test S3 storage](#test-s3-storage) ·
[Run the end-to-end suites](#run-the-end-to-end-suites) · [Find your way in the code](#find-your-way-in-the-code) ·
[Build the image](#build-the-image) · [How a release is published](#how-a-release-is-published) ·
[Contribute](#contribute)

## Set up

You need Node 24 and npm (no pnpm, yarn or corepack), and Docker for the image and the
end-to-end suites.

```sh
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins.

## Run it from source

```sh
npm run dev
```

This starts the server on 8888 and 8025 (TypeScript run directly, in watch mode) and Vite on
<http://localhost:5173>. Open the UI on 5173: Vite proxies `/api`, `/api/ws` and `/whaloc-media`
to the console port and `/v*.*` to the Graph port. The server's own `/` serves the UI only after
`npm run build`.

## Run the checks

| Script                 | What it does                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `npm test`             | vitest in every package, then the end-to-end target checks (no instance needed)       |
| `npm run lint`         | ESLint (typescript-eslint strict, unicorn, prettier), `e2e/` and `examples/` included |
| `npm run typecheck`    | `tsc --noEmit` per package                                                            |
| `npm run format:check` | Prettier (Markdown and YAML included)                                                 |
| `npm run build`        | `shared`, then `server`, then `web`                                                   |
| `npm start`            | Runs the built server                                                                 |
| `npm run mockwa -- …`  | The `mockwa` scenario command, from source                                            |

CI runs lint, typecheck, test and build; run `format:check` too before you push. Scope any script
to one package with `--workspace`, for example `npm run test:watch --workspace @mockwa/web`.

`.prettierignore` leaves out `docs/`, so `format:check` does not check the pages in it. Format a
page you edit with `npx prettier --ignore-path /dev/null --write docs/<page>.md`.

## Test S3 storage

The S3 tests need a real S3-compatible server, so they are opt-in: without
`WHALOC_TEST_S3_ENDPOINT` they skip themselves and say so. CI runs them against RustFS. Locally:

```sh
docker run -d --name whaloc-rustfs -p 9000:9000 \
  -e RUSTFS_ACCESS_KEY=whaloc -e RUSTFS_SECRET_KEY=whaloc-secret rustfs/rustfs:1.0.0
WHALOC_TEST_S3_ENDPOINT=http://127.0.0.1:9000 npm test --workspace @mockwa/server
```

The tests create their own bucket (`whaloc-test`).

## Run the end-to-end suites

The suites in `e2e/` drive a **built image** from outside, with
[`examples/echo-app`](../examples/echo-app/server.mjs) as the app under test.
`.github/workflows/docker.yml` shows how CI starts each image.

Every suite needs its targets named explicitly (`GRAPH_URL`, `CONSOLE_URL`, `ECHO_URL`, the
`M1_*` … `M7_*` variables, and any container a restart check may stop). There are no defaults, so
a suite can never reach a mockwa you are using: a missing or portless target stops it before its
first request. `npm run test:e2e-targets` checks that guard.

Use a dedicated container, free ports and your own echo app. For example, the virtual-phone
suite:

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
  npx playwright test -c e2e/playwright.config.mjs --project m1-phone
```

Set `PLAYWRIGHT_CHANNEL=chrome` to use your local Chrome. Remove the container and stop the echo
app afterwards. The public-mode load test and its pass criteria are described in
[Deployment → Load-test quotas](deployment.md#load-test-quotas).

## Find your way in the code

Three npm workspaces:

| Package           | What it is                                                                  |
| ----------------- | --------------------------------------------------------------------------- |
| `packages/shared` | zod schemas of the control plane and WebSocket, used by server and UI       |
| `packages/server` | The Hono server: Graph API, control plane, WebSocket, static UI             |
| `packages/web`    | The React 19 + Vite console and phone, pure clients of `/api` and `/api/ws` |

One process runs two listeners (`app.ts`): the Graph app and the console app. Inside the server,
each layer has one job:

| Layer                        | Does                                               |
| ---------------------------- | -------------------------------------------------- |
| `graph-api/`, `control-api/` | Parse, validate and map to HTTP; nothing else      |
| `domain/`                    | All behavior; never imports Hono                   |
| `db/repositories/`           | All SQL (Kysely over `node:sqlite`)                |
| `storage/`                   | All file system and S3 access                      |
| `composition.ts`             | Wires it together with plain constructor injection |

The server runs its TypeScript directly in development, so the code must stay erasable (no
enums, namespaces or parameter properties) and relative imports keep their `.ts` extension.
`@mockwa/shared` resolves to its source in development and tests, and to `dist/` in a build;
that is why `shared` builds first. If a build fails with `TS2307` on `@mockwa/shared`, build
`shared` first.

The rest of the project's rules (determinism, seeded IDs, webhook bytes, migrations, style) are
in [AGENTS.md](../AGENTS.md).

## Build the image

```sh
docker build -t mockwa:local .
```

The image runs the compiled server as the unprivileged `node` user, declares `/data` as a volume,
exposes 8888 and 8025, has a `HEALTHCHECK` on both `/health` routes, and puts the `mockwa` command
on the `PATH`. The S3 client is about 26 MB of it; it ships either way, because the media backend
is chosen at run time.

## How a release is published

[`.github/workflows/docker.yml`](../.github/workflows/docker.yml) builds and tests the image on
every pull request that touches it and on every push to `main`: a smoke test, the end-to-end
suites against dedicated containers, Playwright, and a `linux/amd64` + `linux/arm64` build. Those
runs **publish nothing**.

Only pushing a `v*` tag publishes:

1. The image goes to `ghcr.io/loongest/mockwa`, and to Docker Hub when the `DOCKER_HUB_USERNAME`
   variable **and** the `DOCKER_HUB_TOKEN` secret are both set (otherwise GHCR only).
2. Tags: the version (`1.2.3`, `1.2`, `1`), `sha-<short>`, and `latest`.
3. It carries SLSA provenance and an SBOM, and a GitHub-signed build attestation:

   ```sh
   VERSION=1.2.3   # the release you pulled
   gh attestation verify "oci://ghcr.io/loongest/mockwa:$VERSION" --owner loongest
   ```

Until a release exists, `latest` may not exist or may be older than `main`; build from a
checkout instead.

## Contribute

Issues and pull requests are welcome. A change is measured against three things:

- **[SPEC](SPEC.md) is the contract.** Meta-facing behavior (envelopes, error codes, webhook
  shapes, paging) should match what Meta does, with the samples in `docs/fixtures/` as evidence.
  A faithful quirk beats a tidy invention.
- **Deterministic by default.** Nothing fails or changes at random; a feature that needs chance
  is an explicit rule instead.
- **Seeded IDs are a stable contract.** Changing a seed's names or digits changes the derived IDs
  and silently breaks setups that pin them.

New behavior comes with tests: route-level through `app.request()`, webhook payloads against the
fixtures. A bug fix pins the corrected behavior.
