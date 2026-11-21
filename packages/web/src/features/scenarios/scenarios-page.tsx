import { toJUnitXml, type ScenarioRunResponse, type ScenarioStepResult } from "@wasandbox/shared";
import clsx from "clsx";
import { useRef, useState } from "react";
import { ApiError, describeError } from "../../api/client.ts";
import { api } from "../../api/endpoints.ts";
import { Dialog } from "../../components/dialog.tsx";
import { JsonBlock } from "../../components/json-block.tsx";
import { formatTimestamp } from "../../lib/format.ts";
import { SCENARIO_EXAMPLES } from "./scenario-examples.ts";
import { isRepeatClick } from "../../lib/repeat-click.ts";

/**
 * Scenarios (SPEC §4, "Scenarios"): load or paste one, check it, run it, read what happened.
 *
 * Checking never changes anything. Running **resets this WaSandbox** into the scenario's world
 * first — the same reset as `POST /api/reset` — which is why it asks before it starts. The JUnit
 * report is built here from the run on screen, so downloading it does not run the scenario again.
 */

type Outcome =
	| { kind: "idle" }
	| { kind: "invalid"; message: string }
	| { kind: "valid"; name: string; steps: number }
	| { kind: "ran"; run: ScenarioRunResponse }
	| { kind: "failed-to-run"; message: string };

type Busy = "validate" | "run" | null;

/** The JSON on screen, or why it is not JSON — said before anything is sent. */
export function parseScenarioText(text: string): { value: unknown } | { error: string } {
	if (text.trim() === "") {
		return { error: "Paste a scenario, load a file or pick an example first." };
	}

	try {
		return { value: JSON.parse(text) as unknown };
	} catch (error) {
		return { error: `This is not valid JSON: ${describeError(error)}` };
	}
}

function downloadJUnit(run: ScenarioRunResponse): void {
	const xml = toJUnitXml([{ result: run.data, elapsedMs: run.elapsedMs }]);
	const url = URL.createObjectURL(new Blob([xml], { type: "application/xml" }));
	const link = document.createElement("a");

	link.href = url;
	link.download = `wasandbox-${run.data.scenario.replaceAll(/[^\w.-]+/g, "-")}.junit.xml`;
	link.click();
	URL.revokeObjectURL(url);
}

const STATUS_TONE: Record<ScenarioStepResult["status"], string> = {
	passed: "badge--ok",
	failed: "badge--danger",
	skipped: "",
};

function StepRow(props: { step: ScenarioStepResult }) {
	const { step } = props;

	return (
		<>
			<tr data-testid="scenario-step" data-status={step.status}>
				<td className="mono">{step.index}</td>
				<td>{step.name}</td>
				<td className="mono">{step.action}</td>
				<td>
					<span className={clsx("badge", STATUS_TONE[step.status])}>{step.status}</span>
				</td>
				<td className="mono">{step.at === null ? "—" : formatTimestamp(step.at)}</td>
			</tr>
			{step.failure !== undefined && (
				<tr className="scenario-failure" data-testid="scenario-failure">
					<td />
					<td colSpan={4} className="stack">
						<strong>{step.failure.message}</strong>
						<div className="scenario-compare">
							<div>
								<span className="section-label">Expected</span>
								<JsonBlock value={step.failure.expected ?? null} />
							</div>
							<div>
								<span className="section-label">Observed</span>
								<JsonBlock value={step.failure.observed ?? null} />
							</div>
						</div>
					</td>
				</tr>
			)}
		</>
	);
}

function RunReport(props: { run: ScenarioRunResponse }) {
	const { data } = props.run;
	const counts = { passed: 0, failed: 0, skipped: 0 };

	for (const step of data.steps) {
		counts[step.status] += 1;
	}

	return (
		<div className="card stack" data-testid="scenario-report" data-passed={String(data.passed)}>
			<div className="row row--wrap">
				<h2 className="card__title">{data.scenario}</h2>
				<span className={clsx("badge", data.passed ? "badge--ok" : "badge--danger")}>
					{data.passed ? "passed" : "failed"}
				</span>
				<span className="faint">
					{counts.passed} passed · {counts.failed} failed · {counts.skipped} skipped
				</span>
				<span className="spacer" />
				<button
					type="button"
					className="button button--sm"
					onClick={() => {
						downloadJUnit(props.run);
					}}
				>
					Download JUnit XML
				</button>
			</div>
			{data.clock.start !== null && (
				<p className="faint">
					Virtual time {formatTimestamp(data.clock.start)} →{" "}
					{data.clock.end === null ? "—" : formatTimestamp(data.clock.end)}
				</p>
			)}
			<table className="table">
				<thead>
					<tr>
						<th>#</th>
						<th>Step</th>
						<th>Action</th>
						<th>Result</th>
						<th>At</th>
					</tr>
				</thead>
				<tbody>
					{data.steps.map(step => (
						<StepRow key={step.index} step={step} />
					))}
				</tbody>
			</table>
		</div>
	);
}

export function ScenariosPage() {
	const [text, setText] = useState("");
	const [source, setSource] = useState<string | null>(null);
	const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
	const [busy, setBusy] = useState<Busy>(null);
	const [isConfirming, setIsConfirming] = useState(false);
	// What refuses a second click before the disabled buttons have rendered (see the Clock view).
	const inFlight = useRef(false);

	const load = (name: string, content: string): void => {
		setText(content);
		setSource(name);
		setOutcome({ kind: "idle" });
	};

	const validate = (): void => {
		const parsed = parseScenarioText(text);

		if ("error" in parsed) {
			setOutcome({ kind: "invalid", message: parsed.error });

			return;
		}

		if (inFlight.current) {
			return;
		}

		inFlight.current = true;
		setBusy("validate");

		void (async () => {
			try {
				const { data } = await api.validateScenario(parsed.value);

				setOutcome({ kind: "valid", name: data.name, steps: data.steps });
			} catch (error) {
				setOutcome({ kind: "invalid", message: describeError(error) });
			} finally {
				inFlight.current = false;
				setBusy(null);
			}
		})();
	};

	const run = (): void => {
		setIsConfirming(false);

		const parsed = parseScenarioText(text);

		if ("error" in parsed) {
			setOutcome({ kind: "invalid", message: parsed.error });

			return;
		}

		if (inFlight.current) {
			return;
		}

		inFlight.current = true;
		setBusy("run");

		void (async () => {
			try {
				setOutcome({ kind: "ran", run: await api.runScenario(parsed.value) });
			} catch (error) {
				// A scenario the server refuses (400) is invalid, and nothing was reset; anything else
				// failed to run.
				const message = describeError(error);
				const isRefused = error instanceof ApiError && error.status === 400;

				setOutcome(isRefused ? { kind: "invalid", message } : { kind: "failed-to-run", message });
			} finally {
				inFlight.current = false;
				setBusy(null);
			}
		})();
	};

	return (
		<div className="page">
			<header className="page__header">
				<div className="page__title">
					<h1>Scenarios</h1>
					{source !== null && <span className="faint mono">{source}</span>}
				</div>
			</header>

			<div className="page__body stack">
				<p className="badge badge--warn badge--wrap" data-testid="scenario-reset-warning">
					Running a scenario resets this WaSandbox: messages, contacts, deliveries, apps and the request log are
					replaced by the scenario's world, and a virtual clock goes back to the scenario's start. Checking it changes
					nothing.
				</p>

				<div className="card stack">
					<div className="row row--wrap">
						<label className="field">
							<span className="field__label">Example</span>
							<select
								className="input"
								aria-label="Example scenario"
								value=""
								disabled={busy !== null}
								onChange={event => {
									const example = SCENARIO_EXAMPLES.find(candidate => candidate.file === event.target.value);

									if (example !== undefined) {
										load(example.file, example.text);
									}
								}}
							>
								<option value="">Pick an example…</option>
								{SCENARIO_EXAMPLES.map(example => (
									<option key={example.file} value={example.file}>
										{example.file}
									</option>
								))}
							</select>
						</label>
						<label className="field">
							<span className="field__label">Or a file</span>
							<input
								className="input"
								type="file"
								accept=".json, application/json"
								aria-label="Scenario file"
								disabled={busy !== null}
								onChange={event => {
									const file = event.target.files?.[0];

									if (file !== undefined) {
										void file.text().then(content => {
											load(file.name, content);
										});
									}
								}}
							/>
						</label>
					</div>

					<label className="field">
						<span className="field__label">Scenario JSON</span>
						<textarea
							className="input mono scenario-editor"
							aria-label="Scenario JSON"
							spellCheck={false}
							rows={16}
							value={text}
							disabled={busy !== null}
							onChange={event => {
								setText(event.target.value);
								setOutcome({ kind: "idle" });
							}}
						/>
					</label>

					<div className="row row--wrap">
						<button type="button" className="button" disabled={busy !== null} onClick={validate}>
							{busy === "validate" ? "Checking…" : "Check"}
						</button>
						<button
							type="button"
							className="button button--primary"
							disabled={busy !== null}
							onClick={() => {
								setIsConfirming(true);
							}}
						>
							{busy === "run" ? "Running…" : "Run…"}
						</button>
						{busy === "run" && (
							<span className="badge badge--info" role="status" data-testid="scenario-busy">
								Running: the steps execute in order; a virtual clock moves as they say.
							</span>
						)}
					</div>

					{outcome.kind === "invalid" && (
						<pre className="field__error scenario-error" role="alert" data-testid="scenario-invalid">
							{outcome.message}
						</pre>
					)}
					{outcome.kind === "failed-to-run" && (
						<p className="field__error" role="alert">
							{outcome.message}
						</p>
					)}
					{outcome.kind === "valid" && (
						<p className="badge badge--ok badge--wrap" data-testid="scenario-valid">
							“{outcome.name}” is valid: {outcome.steps} step{outcome.steps === 1 ? "" : "s"}. Nothing was run.
						</p>
					)}
				</div>

				{outcome.kind === "ran" && <RunReport run={outcome.run} />}
			</div>

			{isConfirming && (
				<Dialog
					title="Reset and run?"
					onClose={() => {
						setIsConfirming(false);
					}}
					footer={
						<>
							<button
								type="button"
								className="button"
								onClick={() => {
									setIsConfirming(false);
								}}
							>
								Cancel
							</button>
							<button
								type="button"
								className="button button--danger"
								onClick={event => {
									if (!isRepeatClick(event)) {
										run();
									}
								}}
							>
								Reset and run
							</button>
						</>
					}
				>
					<p>
						This replaces everything in this WaSandbox with the scenario's world before the first step. Export the state
						from Settings first if you want to keep it.
					</p>
				</Dialog>
			)}
		</div>
	);
}
