import type { ScenarioRun } from "./scenario-runner.ts";

/**
 * A scenario run as JUnit XML (SPEC §4, "Scenarios"): one `<testsuite>` per scenario, one
 * `<testcase>` per step, a `<failure>` carrying what was expected and what was observed, and
 * `<skipped/>` for the steps after it. The shape CI systems (GitHub Actions reporters, GitLab,
 * Jenkins) read; `time` is wall-clock seconds, the only place a run's real duration appears.
 */

function escapeXml(value: string): string {
	return (
		value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&apos;")
			// XML 1.0 has no escape for these control characters at all; they are dropped.
			// eslint-disable-next-line no-control-regex
			.replaceAll(/[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}]/gu, "")
	);
}

function seconds(ms: number): string {
	return (ms / 1000).toFixed(3);
}

function failureBody(failure: { message: string; expected?: unknown; observed?: unknown }): string {
	const lines = [failure.message];

	if (failure.expected !== undefined) {
		lines.push(`expected: ${JSON.stringify(failure.expected, null, 2)}`);
	}

	if (failure.observed !== undefined) {
		lines.push(`observed: ${JSON.stringify(failure.observed, null, 2)}`);
	}

	return lines.join("\n");
}

function suiteXml(run: ScenarioRun): string {
	const { result, elapsedMs } = run;
	const failures = result.steps.filter(step => step.status === "failed").length;
	const skipped = result.steps.filter(step => step.status === "skipped").length;
	const total = elapsedMs.reduce((sum, ms) => sum + ms, 0);
	const testClass = `mockwa.scenario.${result.scenario}`;
	const cases = result.steps.map((step, position) => {
		const open = `    <testcase classname="${escapeXml(testClass)}" name="${escapeXml(`${String(step.index)}. ${step.name}`)}" time="${seconds(elapsedMs[position] ?? 0)}"`;

		if (step.status === "skipped") {
			return `${open}>\n      <skipped message="an earlier step failed"/>\n    </testcase>`;
		}

		if (step.failure !== undefined) {
			return (
				`${open}>\n      <failure message="${escapeXml(step.failure.message)}" type="${escapeXml(step.action)}">` +
				`${escapeXml(failureBody(step.failure))}</failure>\n    </testcase>`
			);
		}

		return `${open}/>`;
	});

	return [
		`  <testsuite name="${escapeXml(result.scenario)}" tests="${String(result.steps.length)}" failures="${String(failures)}" errors="0" skipped="${String(skipped)}" time="${seconds(total)}">`,
		...cases,
		"  </testsuite>",
	].join("\n");
}

export function toJUnitXml(runs: readonly ScenarioRun[]): string {
	const steps = runs.flatMap(run => run.result.steps);
	const failures = steps.filter(step => step.status === "failed").length;
	const skipped = steps.filter(step => step.status === "skipped").length;
	const total = runs.flatMap(run => run.elapsedMs).reduce((sum, ms) => sum + ms, 0);

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<testsuites name="mockwa scenarios" tests="${String(steps.length)}" failures="${String(failures)}" errors="0" skipped="${String(skipped)}" time="${seconds(total)}">`,
		...runs.map(run => suiteXml(run)),
		"</testsuites>",
		"",
	].join("\n");
}
