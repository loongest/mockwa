// The end-to-end suites refuse to run without explicit targets, before any request or Docker
// command: `node --test e2e/targets.test.mjs` (part of `npm test`).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { readTargets, TargetConfigError } from "./targets.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FORBID_IO = fileURLToPath(new URL("testing/forbid-io.mjs", import.meta.url));
const PLAYWRIGHT_CLI = fileURLToPath(new URL("../node_modules/@playwright/test/cli.js", import.meta.url));

/** What testing/forbid-io.mjs prints on any attempt (not imported: that would arm it here). */
const TRIPWIRE = "FORBIDDEN-IO-ATTEMPTED";

/** No suite variable at all — what an unconfigured shell looks like. */
const BARE_ENV = { PATH: process.env.PATH ?? "" };

function run(args, env = BARE_ENV) {
	const result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });

	return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("readTargets", () => {
	const spec = { suite: "demo", urls: ["DEMO_URL"], names: ["DEMO_CONTAINER"] };

	it("returns every target, URLs without a trailing slash", () => {
		const targets = readTargets({ DEMO_URL: "http://127.0.0.1:58025/", DEMO_CONTAINER: "c" }, spec);

		assert.deepEqual(targets, { DEMO_URL: "http://127.0.0.1:58025", DEMO_CONTAINER: "c" });
	});

	it("lists every missing or blank variable in one error", () => {
		assert.throws(
			() => readTargets({ DEMO_CONTAINER: "  " }, spec),
			error => {
				return (
					error instanceof TargetConfigError &&
					error.message.includes("DEMO_URL is not set") &&
					error.message.includes("DEMO_CONTAINER is not set")
				);
			},
		);
	});

	it("refuses a URL without an explicit port, one that is not http(s), and one that is not a URL", () => {
		for (const value of ["http://127.0.0.1", "https://example.test/", "ftp://127.0.0.1:21", "127.0.0.1:58025x"]) {
			assert.throws(() => readTargets({ DEMO_URL: value, DEMO_CONTAINER: "c" }, spec), TargetConfigError, value);
		}
	});
});

describe("an unconfigured suite stops before touching anything", () => {
	const scripts = {
		"e2e/m0-smoke.mjs": ["GRAPH_URL", "CONSOLE_URL", "ECHO_URL"],
		"e2e/m2-webhooks.mjs": [
			"M2_GRAPH_URL",
			"M2_CONSOLE_URL",
			"M2_SALES_ECHO_URL",
			"M2_SUPPORT_ECHO_URL",
			"M2_CONTAINER",
		],
		"e2e/m3-fidelity.mjs": ["M3_GRAPH_URL", "M3_CONSOLE_URL", "M3_ECHO_URL", "M3_CONTAINER"],
		"e2e/m4-clock-scenarios.mjs": ["M4_GRAPH_URL", "M4_CONSOLE_URL", "M4_ECHO_URL", "M4_CONTAINER"],
	};

	for (const [script, variables] of Object.entries(scripts)) {
		it(`${script} exits 2, names every missing variable and makes no connection or Docker call`, () => {
			const { status, output } = run(["--import", FORBID_IO, script]);

			assert.equal(status, 2, output);
			assert.ok(!output.includes(TRIPWIRE), output);
			assert.match(output, /the test targets are not configured, so nothing was run/);

			for (const variable of variables) {
				assert.match(output, new RegExp(`${variable} is not set`));
			}
		});
	}

	it("a script given a portless URL stops the same way", () => {
		const { status, output } = run(["--import", FORBID_IO, "e2e/m0-smoke.mjs"], {
			...BARE_ENV,
			GRAPH_URL: "http://127.0.0.1",
			CONSOLE_URL: "http://127.0.0.1:48025",
			ECHO_URL: "http://127.0.0.1:3001",
		});

		assert.equal(status, 2, output);
		assert.ok(!output.includes(TRIPWIRE), output);
		assert.match(output, /GRAPH_URL must name its port explicitly/);
	});

	for (const [project, variable] of [
		["m0-console", "CONSOLE_URL"],
		["m1-phone", "M1_CONSOLE_URL"],
		["m2-webhooks", "M2_CONSOLE_URL"],
		["m3-fidelity", "M3_CONSOLE_URL"],
		["m4-clock", "M4_CONSOLE_URL"],
	]) {
		it(`the ${project} Playwright project fails while loading, before any test`, () => {
			const { status, output } = run([
				PLAYWRIGHT_CLI,
				"test",
				"-c",
				"e2e/playwright.config.mjs",
				"--project",
				project,
				"--list",
			]);

			assert.notEqual(status, 0, output);
			assert.match(output, new RegExp(`${variable} is not set`));
			assert.match(output, /Total: 0 tests|no tests found/i);
		});
	}
});
