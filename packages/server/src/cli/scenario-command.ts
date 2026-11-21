import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { describeScenarioIssues, scenarioSchema, type Scenario } from "../config/scenario.ts";
import { toJUnitXml } from "../domain/scenario-junit.ts";
import type { ScenarioRun, StepResult } from "../domain/scenario-runner.ts";

/**
 * `wasandbox scenario run` (SPEC §4, "Scenarios"): a small client of a running WaSandbox's control
 * plane. It validates each scenario file locally first — so a typo is reported with its file
 * and its location, without a round trip — then asks the instance to run it and prints the
 * outcome. Exit codes: `0` every scenario passed, `1` at least one failed, `2` the command
 * could not do its job (bad arguments, an invalid file, an unreachable or refusing instance).
 *
 * The instance is never guessed: `--url` (or `WASANDBOX_CONSOLE_URL`) must name it, because a run
 * **resets** the instance it talks to.
 */

const USAGE = `Usage:
  wasandbox scenario run <file.json>... --url <console URL> [--junit <report.xml>] [--json <results.json>]
  wasandbox scenario validate <file.json>... [--url <console URL>]

Options:
  --url      The WaSandbox console to run against, such as http://127.0.0.1:8025
             (or set WASANDBOX_CONSOLE_URL). A run resets that instance.
  --junit    Also write a JUnit XML report of every scenario to this file.
  --json     Also write the full results as JSON to this file.
  --timeout  Give up on one scenario after this many seconds (default 600).

Exit codes: 0 all passed, 1 a scenario failed, 2 usage, file or connection error.`;

const EXIT_PASSED = 0;
const EXIT_FAILED = 1;
const EXIT_ERROR = 2;
const DEFAULT_TIMEOUT_SECONDS = 600;

class CliError extends Error {
	override name = "CliError";
}

/** The string options; `--help` is handled before anything reads these. */
interface Options {
	url?: string | undefined;
	junit?: string | undefined;
	json?: string | undefined;
	timeout?: string | undefined;
}

interface Output {
	out: (line: string) => void;
	err: (line: string) => void;
}

export interface CliEnvironment extends Output {
	env: Record<string, string | undefined>;
	fetch: typeof fetch;
}

async function loadScenario(file: string): Promise<Scenario> {
	let text: string;

	try {
		text = await readFile(file, "utf8");
	} catch (error) {
		throw new CliError(`${file}: cannot read it (${Error.isError(error) ? error.message : String(error)})`);
	}

	let json: unknown;

	try {
		json = JSON.parse(text);
	} catch (error) {
		throw new CliError(`${file}: not valid JSON (${Error.isError(error) ? error.message : String(error)})`);
	}

	const parsed = scenarioSchema.safeParse(json);

	if (!parsed.success) {
		throw new CliError(
			`${file}: the scenario is invalid:\n${describeScenarioIssues(parsed.error)
				.map(issue => `  - ${issue}`)
				.join("\n")}`,
		);
	}

	return parsed.data;
}

function consoleUrl(value: string | undefined, env: Record<string, string | undefined>): string {
	const raw = value ?? env["WASANDBOX_CONSOLE_URL"];

	if (raw === undefined || raw.trim() === "") {
		throw new CliError(
			"name the WaSandbox console with --url (or WASANDBOX_CONSOLE_URL), such as http://127.0.0.1:8025",
		);
	}

	let url: URL;

	try {
		url = new URL(raw.trim());
	} catch {
		throw new CliError(`--url is not a URL: ${JSON.stringify(raw)}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new CliError(`--url must be an http(s) URL, got ${JSON.stringify(raw)}`);
	}

	return url.href.replace(/\/+$/, "");
}

async function post(
	cli: CliEnvironment,
	url: string,
	scenario: Scenario,
	timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
	let response: Response;

	try {
		response = await cli.fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(scenario),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		const cause = Error.isError(error) && Error.isError(error.cause) ? ` (${error.cause.message})` : "";

		throw new CliError(`cannot reach ${url}: ${Error.isError(error) ? error.message : String(error)}${cause}`);
	}

	const text = await response.text();

	try {
		return { status: response.status, body: JSON.parse(text) as unknown };
	} catch {
		throw new CliError(
			`${url} answered ${String(response.status)} with something that is not JSON: ${text.slice(0, 200)}`,
		);
	}
}

function errorMessageOf(body: unknown): string {
	const error = (body as { error?: { message?: unknown } } | null)?.error;

	return typeof error?.message === "string" ? error.message : JSON.stringify(body);
}

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map(line => prefix + line)
		.join("\n");
}

function printStep(output: Output, step: StepResult, elapsedMs: number): void {
	const at = step.at === null ? "" : `  @ ${step.at}`;

	if (step.status === "passed") {
		output.out(`  ✓ ${String(step.index)}. ${step.name}  (${String(elapsedMs)} ms)${at}`);

		return;
	}

	if (step.status === "skipped") {
		output.out(`  - ${String(step.index)}. ${step.name}  (skipped)`);

		return;
	}

	output.out(`  ✗ ${String(step.index)}. ${step.name}${at}`);

	if (step.failure !== undefined) {
		output.out(indent(step.failure.message, " ".repeat(6)));

		if (step.failure.expected !== undefined) {
			output.out(indent(`expected: ${JSON.stringify(step.failure.expected, null, 2)}`, " ".repeat(6)));
		}

		if (step.failure.observed !== undefined) {
			output.out(indent(`observed: ${JSON.stringify(step.failure.observed, null, 2)}`, " ".repeat(6)));
		}
	}
}

function printRun(output: Output, file: string, run: ScenarioRun): void {
	const { result } = run;
	const clock =
		result.clock.mode === "virtual"
			? `  (virtual clock ${result.clock.start ?? "?"} → ${result.clock.end ?? "?"})`
			: "";

	output.out(`${result.passed ? "PASS" : "FAIL"} ${result.scenario}  [${file}]${clock}`);

	for (const [position, step] of result.steps.entries()) {
		printStep(output, step, run.elapsedMs[position] ?? 0);
	}
}

async function runScenarios(cli: CliEnvironment, files: string[], values: Options) {
	const base = consoleUrl(values.url, cli.env);
	const timeoutSeconds = values.timeout === undefined ? DEFAULT_TIMEOUT_SECONDS : Number(values.timeout);

	if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
		throw new CliError(`--timeout must be a positive number of seconds, got ${JSON.stringify(values.timeout)}`);
	}

	// Every file is checked before the first run, so a broken file never leaves an instance
	// half-way through a batch.
	const scenarios: { file: string; scenario: Scenario }[] = [];

	for (const file of files) {
		scenarios.push({ file, scenario: await loadScenario(file) });
	}

	const runs: ScenarioRun[] = [];

	for (const { file, scenario } of scenarios) {
		const { status, body } = await post(cli, `${base}/api/scenarios/run`, scenario, timeoutSeconds * 1000);

		if (status !== 200) {
			throw new CliError(`${file}: the instance refused it (${String(status)}): ${errorMessageOf(body)}`);
		}

		const { data, elapsedMs } = body as { data: ScenarioRun["result"]; elapsedMs: number[] };
		const run: ScenarioRun = { result: data, elapsedMs };

		runs.push(run);
		printRun(cli, file, run);
	}

	if (values.junit !== undefined) {
		await writeFile(values.junit, toJUnitXml(runs), "utf8");
	}

	if (values.json !== undefined) {
		await writeFile(values.json, `${JSON.stringify(runs, null, 2)}\n`, "utf8");
	}

	const failed = runs.filter(run => !run.result.passed).length;

	cli.out(`${String(runs.length)} scenario(s): ${String(runs.length - failed)} passed, ${String(failed)} failed`);

	return failed === 0 ? EXIT_PASSED : EXIT_FAILED;
}

async function validateScenarios(cli: CliEnvironment, files: string[], values: Options) {
	const base = values.url ?? cli.env["WASANDBOX_CONSOLE_URL"];

	for (const file of files) {
		const scenario = await loadScenario(file);

		if (base !== undefined) {
			const url = consoleUrl(base, cli.env);
			const { status, body } = await post(
				cli,
				`${url}/api/scenarios/validate`,
				scenario,
				DEFAULT_TIMEOUT_SECONDS * 1000,
			);

			if (status !== 200) {
				throw new CliError(`${file}: ${errorMessageOf(body)}`);
			}
		}

		cli.out(`${file}: valid (${String(scenario.steps.length)} steps)${base === undefined ? ", schema only" : ""}`);
	}

	return EXIT_PASSED;
}

/** The whole command, with its I/O injected: what the tests drive. Returns the exit code. */
export async function main(argv: readonly string[], cli: CliEnvironment): Promise<number> {
	let parsed;

	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			options: {
				url: { type: "string" },
				junit: { type: "string" },
				json: { type: "string" },
				timeout: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		});
	} catch (error) {
		cli.err(`${Error.isError(error) ? error.message : String(error)}\n\n${USAGE}`);

		return EXIT_ERROR;
	}

	const [group, command, ...files] = parsed.positionals;

	if (group === undefined || parsed.values.help === true) {
		cli.out(USAGE);

		return parsed.values.help === true ? EXIT_PASSED : EXIT_ERROR;
	}

	if (group !== "scenario" || (command !== "run" && command !== "validate") || files.length === 0) {
		cli.err(USAGE);

		return EXIT_ERROR;
	}

	const action = command === "run" ? runScenarios : validateScenarios;

	try {
		return await action(cli, files, parsed.values);
	} catch (error) {
		if (error instanceof CliError) {
			cli.err(`wasandbox: ${error.message}`);

			return EXIT_ERROR;
		}

		throw error;
	}
}
