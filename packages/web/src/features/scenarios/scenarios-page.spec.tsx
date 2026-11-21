import type { ScenarioRunResponse } from "@wasandbox/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { jsonResponse, makeAppState, requestBodyOf, stubFetch } from "../../test/factories.ts";
import { SCENARIO_EXAMPLES } from "./scenario-examples.ts";
import { parseScenarioText, ScenariosPage } from "./scenarios-page.tsx";

/** The Scenarios view (SPEC §4, "Scenarios"): check without side effects, run after a warning. */

function renderPage(): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(<ScenariosPage />, { wrapper });
}

function typeScenario(text: string): void {
	fireEvent.change(screen.getByLabelText("Scenario JSON"), { target: { value: text } });
}

const FAILED_RUN: ScenarioRunResponse = {
	data: {
		scenario: "unmet expectation",
		passed: false,
		clock: { mode: "virtual", start: "2026-05-04T09:00:00.000Z", end: "2026-05-04T09:00:02.000Z" },
		world: { wabas: [], numbers: [], identities: [] },
		steps: [
			{ index: 1, name: "Dina sends hi", action: "send", status: "passed", at: "2026-05-04T09:00:00.000Z" },
			{
				index: 2,
				name: "the app greets Dina by name",
				action: "expect",
				status: "failed",
				at: "2026-05-04T09:00:02.000Z",
				failure: {
					message: "no matching message within 2s",
					expected: { text: "Hello, Dina!" },
					observed: [{ text: "echo: hi" }],
				},
			},
			{ index: 3, name: "advance 1m", action: "advance", status: "skipped", at: null },
		],
		failure: {
			step: 2,
			name: "the app greets Dina by name",
			action: "expect",
			message: "no matching message within 2s",
		},
	},
	elapsedMs: [3, 2001, 0],
};

describe("parseScenarioText", () => {
	it("says what is wrong before anything is sent", () => {
		expect(parseScenarioText("  ")).toEqual({ error: expect.stringMatching(/Paste a scenario/) as string });
		expect(parseScenarioText("{ nope")).toEqual({ error: expect.stringMatching(/^This is not valid JSON/) as string });
		expect(parseScenarioText('{"name":"x"}')).toEqual({ value: { name: "x" } });
	});
});

describe("ScenariosPage", () => {
	it("offers the shipped examples", () => {
		renderPage();

		expect(SCENARIO_EXAMPLES.map(example => example.file)).toEqual([
			"booking-conversation.json",
			"service-window.json",
		]);

		fireEvent.change(screen.getByLabelText("Example scenario"), { target: { value: "service-window.json" } });

		expect(screen.getByLabelText("Scenario JSON")).toHaveProperty("value", SCENARIO_EXAMPLES[1]!.text);
		expect(screen.getByTestId("scenario-reset-warning").textContent).toMatch(/resets this WaSandbox/);
	});

	it("checks a scenario with the server and shows its actionable errors; nothing runs", async () => {
		const fetchMock = stubFetch(() =>
			Promise.resolve(
				jsonResponse(
					{
						error: {
							message: 'the scenario is invalid:\n  - steps.0.send.as: unknown identity "Zed"',
							code: "invalid_scenario",
						},
					},
					400,
				),
			),
		);

		renderPage();
		typeScenario('{"name":"x","steps":[{"send":{"as":"Zed","text":"hi"}}]}');
		fireEvent.click(screen.getByRole("button", { name: "Check" }));

		const found1 = await screen.findByTestId("scenario-invalid");

		expect(found1.textContent).toContain('steps.0.send.as: unknown identity "Zed"');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/scenarios/validate");
	});

	it("refuses text that is not JSON without calling the server", () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({})));

		renderPage();
		typeScenario("{ not json");
		fireEvent.click(screen.getByRole("button", { name: "Check" }));

		expect(screen.getByTestId("scenario-invalid").textContent).toMatch(/not valid JSON/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("runs only after the reset is confirmed, and shows failed, expected, observed and skipped steps", async () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse(FAILED_RUN)));
		const scenario = { name: "unmet expectation", steps: [] };

		renderPage();
		typeScenario(JSON.stringify(scenario));
		fireEvent.click(screen.getByRole("button", { name: "Run…" }));

		expect(fetchMock).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Reset and run" }));

		const report = await screen.findByTestId("scenario-report");

		expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/scenarios/run");
		expect(requestBodyOf(fetchMock)).toEqual(scenario);
		expect(report.dataset["passed"]).toBe("false");
		expect(screen.getAllByTestId("scenario-step").map(row => row.dataset["status"])).toEqual([
			"passed",
			"failed",
			"skipped",
		]);

		const failure = within(screen.getByTestId("scenario-failure"));

		expect(failure.getByText("no matching message within 2s")).toBeTruthy();
		expect(failure.getByText(/Hello, Dina!/)).toBeTruthy();
		expect(failure.getByText(/echo: hi/)).toBeTruthy();
	});

	it("downloads the JUnit report of the run on screen without running it again", async () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse(FAILED_RUN)));
		const created: Blob[] = [];
		const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {
			// jsdom does not navigate.
		});

		vi.stubGlobal("URL", {
			...URL,
			createObjectURL: (blob: Blob) => {
				created.push(blob);

				return "blob:junit";
			},
			revokeObjectURL: () => {
				// nothing to free in a test
			},
		});

		renderPage();
		typeScenario("{}");
		fireEvent.click(screen.getByRole("button", { name: "Run…" }));
		fireEvent.click(screen.getByRole("button", { name: "Reset and run" }));
		fireEvent.click(await screen.findByRole("button", { name: "Download JUnit XML" }));

		await waitFor(() => {
			expect(created).toHaveLength(1);
		});

		const xml = await created[0]!.text();

		expect(xml).toContain('<testsuite name="unmet expectation" tests="3" failures="1" errors="0" skipped="1"');
		expect(xml).toContain("expected: {");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(click).toHaveBeenCalledTimes(1);
		click.mockRestore();
		vi.unstubAllGlobals();
	});
});
