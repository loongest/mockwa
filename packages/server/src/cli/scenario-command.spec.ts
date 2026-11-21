import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../testing/test-app.ts";
import { main, type CliEnvironment } from "./scenario-command.ts";

/**
 * `wasandbox scenario run|validate` (SPEC §4, "Scenarios") against the composed app: the CLI's
 * `fetch` is wired to `app.request()`, so everything but the socket is real.
 */

const CONSOLE = "http://127.0.0.1:18999";

const PASSING = {
	name: "window opens",
	clock: { start: "2026-05-01T00:00:00Z" },
	steps: [
		{ send: { as: "Ana Souza", text: "hello" } },
		{ expect: { window: { as: "Ana Souza", open: true } } },
		{ advance: "24h" },
		{ name: "closed a day later", expect: { window: { as: "Ana Souza", open: false } } },
	],
};

const FAILING = {
	name: "window still open",
	steps: [
		{ send: { as: "Ana Souza", text: "hello" } },
		{ advance: "25h" },
		{ name: "still open?", expect: { window: { as: "Ana Souza", open: true }, within: 0 } },
		{ advance: "1m" },
	],
};

describe("wasandbox scenario", () => {
	let fixture: TestApp;
	let dir: string;
	let out: string[];
	let err: string[];
	let cli: CliEnvironment;

	beforeEach(async () => {
		fixture = await createTestApp({ WASANDBOX_CLOCK: "virtual" });
		dir = await mkdtemp(path.join(tmpdir(), "wasandbox-cli-"));
		out = [];
		err = [];
		cli = {
			env: {},
			fetch: async (input, init) => {
				const url = new URL(input instanceof Request ? input.url : String(input));

				expect(url.origin).toBe(CONSOLE);

				return fixture.app.request(`${url.pathname}${url.search}`, init);
			},
			out: line => {
				out.push(line);
			},
			err: line => {
				err.push(line);
			},
		};
	});

	afterEach(async () => {
		await fixture.close();
		await rm(dir, { recursive: true, force: true });
	});

	async function file(name: string, content: unknown): Promise<string> {
		const target = path.join(dir, name);

		await writeFile(target, typeof content === "string" ? content : JSON.stringify(content), "utf8");

		return target;
	}

	it("runs scenarios, prints each step and exits 0 when all pass", async () => {
		const scenario = await file("pass.json", PASSING);
		const results = path.join(dir, "results.json");

		expect(await main(["scenario", "run", scenario, "--url", CONSOLE, "--json", results], cli)).toBe(0);
		expect(err).toEqual([]);
		expect(out[0]).toBe(
			`PASS window opens  [${scenario}]  (virtual clock 2026-05-01T00:00:00.000Z → 2026-05-02T00:00:00.000Z)`,
		);
		expect(out[4]).toMatch(/^ {2}✓ 4\. closed a day later {2}\(\d+ ms\) {2}@ 2026-05-02T00:00:00\.000Z$/);
		expect(out.at(-1)).toBe("1 scenario(s): 1 passed, 0 failed");

		const written = JSON.parse(await readFile(results, "utf8")) as [{ result: { passed: boolean } }];

		expect(written[0].result.passed).toBe(true);
	});

	it("AC-12: exits 1 on an unmet expectation, names the step, and writes valid JUnit XML", async () => {
		const passing = await file("pass.json", PASSING);
		const failing = await file("fail.json", FAILING);
		const junit = path.join(dir, "junit.xml");

		expect(await main(["scenario", "run", passing, failing, "--url", CONSOLE, "--junit", junit], cli)).toBe(1);

		const report = out.join("\n");

		expect(report).toContain(`FAIL window still open  [${failing}]`);
		expect(report).toContain("  ✗ 3. still open?  @ 2026-01-02T01:00:00.000Z\n      the window is closed");
		expect(report).toContain('      expected: {\n        "open": true\n      }');
		expect(report).toContain('"open": false');
		expect(report).toContain("  - 4. advance 1m  (skipped)");
		expect(out.at(-1)).toBe("2 scenario(s): 1 passed, 1 failed");

		const xml = await readFile(junit, "utf8");

		expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/);
		expect(xml).toContain('<testsuites name="wasandbox scenarios" tests="8" failures="1" errors="0" skipped="1"');
		expect(xml).toContain('<testsuite name="window opens" tests="4" failures="0" errors="0" skipped="0"');
		expect(xml).toContain('<testcase classname="wasandbox.scenario.window still open" name="3. still open?"');
		expect(xml).toContain('<failure message="the window is closed" type="expect">');
		// Well formed: every element that opens, closes.
		expect(xml.match(/<testcase /g)).toHaveLength(8);
		expect((xml.match(/<\/testcase>/g)?.length ?? 0) + (xml.match(/<testcase [^>]*\/>/g)?.length ?? 0)).toBe(8);
		expect(xml.trimEnd().endsWith("</testsuites>")).toBe(true);
	});

	it("exits 2 with the file and the location of every problem, before running anything", async () => {
		const good = await file("good.json", PASSING);
		const bad = await file("bad.json", { name: "bad", steps: [{ tap: { as: "Ana Souza" } }, { advance: "soon" }] });
		const before = fixture.services.domain.clock.view();

		expect(await main(["scenario", "run", good, bad, "--url", CONSOLE], cli)).toBe(2);
		expect(err.join("\n")).toContain(`wasandbox: ${bad}: the scenario is invalid:`);
		expect(err.join("\n")).toContain("  - steps[0].tap.option:");
		expect(err.join("\n")).toContain("  - steps[1].advance:");
		// The good file was not run either: the whole batch is checked first.
		expect(out).toEqual([]);
		expect(fixture.services.domain.clock.view()).toEqual(before);
	});

	it("exits 2 for a file that is not JSON, a reference the instance rejects, and no --url", async () => {
		const broken = await file("broken.json", "{ nope");
		const stranger = await file("stranger.json", { name: "x", steps: [{ send: { as: "Zed", text: "hi" } }] });

		expect(await main(["scenario", "run", broken, "--url", CONSOLE], cli)).toBe(2);
		expect(err.at(-1)).toMatch(/broken\.json: not valid JSON/);

		expect(await main(["scenario", "run", stranger, "--url", CONSOLE], cli)).toBe(2);
		expect(err.at(-1)).toContain(
			'the instance refused it (400): scenario "x" is invalid:\n  - steps[0].send.as: no identity "Zed"',
		);

		expect(await main(["scenario", "run", stranger], cli)).toBe(2);
		expect(err.at(-1)).toContain("name the WaSandbox console with --url");
	});

	it("exits 2 when the instance cannot be reached", async () => {
		const scenario = await file("pass.json", PASSING);

		cli.fetch = () => Promise.reject(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") }));

		expect(await main(["scenario", "run", scenario, "--url", CONSOLE], cli)).toBe(2);
		expect(err.at(-1)).toBe(
			`wasandbox: cannot reach ${CONSOLE}/api/scenarios/run: fetch failed (connect ECONNREFUSED)`,
		);
	});

	it("validates locally, or against an instance, without running", async () => {
		const scenario = await file("pass.json", PASSING);

		expect(
			await main(["scenario", "validate", scenario], { ...cli, fetch: () => Promise.reject(new Error("no")) }),
		).toBe(0);
		expect(out.at(-1)).toBe(`${scenario}: valid (4 steps), schema only`);

		expect(await main(["scenario", "validate", scenario, "--url", CONSOLE], cli)).toBe(0);
		expect(out.at(-1)).toBe(`${scenario}: valid (4 steps)`);
	});

	it("prints the usage for a wrong command", async () => {
		expect(await main(["scenarios", "go"], cli)).toBe(2);
		expect(err[0]).toContain("wasandbox scenario run <file.json>...");
		expect(await main(["--help"], cli)).toBe(0);
	});
});
