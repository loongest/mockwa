import { defineConfig } from "@playwright/test";

/**
 * Browser checks against running mockwa instances — in CI, the built Docker image (see
 * .github/workflows/docker.yml). Nothing is started here:
 *
 * - `m0-console` drives the console of the default-seeded instance at CONSOLE_URL / GRAPH_URL;
 * - `m1-phone` drives the virtual phone of an instance seeded from e2e/fixtures/m1-seed.json,
 *   at M1_CONSOLE_URL, with its own echo app at M1_ECHO_URL;
 * - `m2-webhooks` drives the apps and retries of an instance started with
 *   e2e/fixtures/m2-seed.json and m2-apps.json, at M2_CONSOLE_URL.
 *
 * PLAYWRIGHT_CHANNEL=chrome runs the locally installed Chrome instead of Playwright's Chromium.
 */
export default defineConfig({
	testDir: ".",
	forbidOnly: process.env.CI !== undefined,
	reporter: process.env.CI === undefined ? "list" : [["list"], ["junit", { outputFile: "results/junit.xml" }]],
	outputDir: "results/artifacts",
	use: {
		trace: "off",
		...(process.env.PLAYWRIGHT_CHANNEL !== undefined && { channel: process.env.PLAYWRIGHT_CHANNEL }),
	},
	projects: [
		{
			name: "m0-console",
			testMatch: "console.spec.mjs",
			use: { baseURL: process.env.CONSOLE_URL ?? "http://127.0.0.1:8025" },
		},
		{
			name: "m1-phone",
			testMatch: "m1-*.spec.mjs",
			use: { baseURL: process.env.M1_CONSOLE_URL ?? "http://127.0.0.1:18025" },
		},
		{
			name: "m2-webhooks",
			testMatch: "m2-*.spec.mjs",
			use: { baseURL: process.env.M2_CONSOLE_URL ?? "http://127.0.0.1:28025" },
		},
	],
});
