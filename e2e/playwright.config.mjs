import { defineConfig } from "@playwright/test";

/**
 * Browser checks against a running mockwa — in CI, the built Docker image (see
 * .github/workflows/docker.yml). Nothing is started here: the target is whatever
 * CONSOLE_URL / GRAPH_URL point at. PLAYWRIGHT_CHANNEL=chrome runs the locally installed Chrome
 * instead of Playwright's own Chromium.
 */
export default defineConfig({
	testDir: ".",
	forbidOnly: process.env.CI !== undefined,
	reporter: process.env.CI === undefined ? "list" : [["list"], ["junit", { outputFile: "results/junit.xml" }]],
	outputDir: "results/artifacts",
	use: {
		baseURL: process.env.CONSOLE_URL ?? "http://127.0.0.1:8025",
		trace: "off",
		...(process.env.PLAYWRIGHT_CHANNEL !== undefined && { channel: process.env.PLAYWRIGHT_CHANNEL }),
	},
});
