import { defineConfig } from "@playwright/test";

/**
 * Browser checks against running WaSandbox instances — in CI, the built Docker image (see
 * .github/workflows/docker.yml). Nothing is started here:
 *
 * - `m0-console` drives the console of the default-seeded instance at CONSOLE_URL / GRAPH_URL;
 * - `m1-phone` drives the virtual phone of an instance seeded from e2e/fixtures/m1-seed.json,
 *   at M1_CONSOLE_URL, with its own echo app at M1_ECHO_URL;
 * - `m2-webhooks` drives the apps and retries of an instance started with
 *   e2e/fixtures/m2-seed.json and m2-apps.json, at M2_CONSOLE_URL;
 * - `m3-fidelity` drives the messaging-rule views of the instance e2e/m3-fidelity.mjs checks,
 *   at M3_CONSOLE_URL;
 * - `m4-clock` drives the virtual phone on the virtual-clock instance e2e/m4-clock-scenarios.mjs
 *   checks, at M4_CONSOLE_URL (it resets that instance);
 * - `m5-console` drives the Clock, Scenarios, Requests and Webhooks views and the window badge on
 *   the virtual-clock instance e2e/m5-console.mjs checks, at M5_CONSOLE_URL with M5_GRAPH_URL (it resets that
 *   instance).
 * - `m6-public` drives the public Virtual Phone and the admin sign-in of the WASANDBOX_MODE=public
 *   instance e2e/m6-public.mjs checks, at M6_CONSOLE_URL (each test is a new anonymous visitor).
 * - `m7-hardening` runs the public phone and the admin console under their Content-Security-Policy
 *   with hostile message text, on the instance e2e/m7-hardening.mjs checks, at M7_CONSOLE_URL.
 *
 * Every URL is required and has no default (e2e/targets.mjs): each spec file checks its own
 * before any test runs, so a missing one can never reach a developer's own instance.
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
			use: { baseURL: process.env.CONSOLE_URL },
		},
		{
			name: "m1-phone",
			testMatch: "m1-*.spec.mjs",
			use: { baseURL: process.env.M1_CONSOLE_URL },
		},
		{
			name: "m2-webhooks",
			testMatch: "m2-*.spec.mjs",
			use: { baseURL: process.env.M2_CONSOLE_URL },
		},
		{
			name: "m3-fidelity",
			testMatch: "m3-*.spec.mjs",
			use: { baseURL: process.env.M3_CONSOLE_URL },
		},
		{
			name: "m4-clock",
			testMatch: "m4-*.spec.mjs",
			use: { baseURL: process.env.M4_CONSOLE_URL },
		},
		{
			name: "m5-console",
			testMatch: "m5-*.spec.mjs",
			use: { baseURL: process.env.M5_CONSOLE_URL },
		},
		{
			name: "m6-public",
			testMatch: "m6-*.spec.mjs",
			use: { baseURL: process.env.M6_CONSOLE_URL },
		},
		{
			name: "m7-hardening",
			testMatch: "m7-*.spec.mjs",
			use: { baseURL: process.env.M7_CONSOLE_URL },
		},
	],
});
