import type { ClockMove, ClockState } from "@wasandbox/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { jsonResponse, makeAppState, stubFetch } from "../../test/factories.ts";
import { ClockPage } from "./clock-page.tsx";

/** The Clock view (SPEC §4, "Virtual clock"). */

const VIRTUAL: ClockState = {
	mode: "virtual",
	now: "2026-06-01T08:00:00.000Z",
	start: "2026-06-01T08:00:00.000Z",
	pending: [{ sequence: 3, dueAt: "2026-06-01T08:02:00.000Z", label: "status delivered wamid.X" }],
	deterministicIds: true,
};
const REAL: ClockState = {
	mode: "real",
	now: "2026-06-01T08:00:00.000Z",
	start: null,
	pending: null,
	deterministicIds: false,
};

function renderPage(clock: ClockState): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState({ clock: { clock, syncedAt: Date.now() } })}>
			{children}
		</StoreProvider>
	);

	render(<ClockPage />, { wrapper });
}

describe("ClockPage", () => {
	it("explains a real clock, and locks the controls", async () => {
		stubFetch(() => Promise.resolve(jsonResponse({ data: REAL })));
		renderPage(REAL);

		const found1 = await screen.findByTestId("clock-mode");

		expect(found1.textContent).toBe("real time");
		expect(screen.getByTestId("clock-explainer").textContent).toMatch(/WASANDBOX_CLOCK=virtual/);
		expect(screen.getByTestId("clock-explainer").textContent).toMatch(/the app under test keeps its own clock/);
		expect(screen.getByRole("button", { name: "Advance" })).toHaveProperty("disabled", true);
		expect(screen.getByRole("button", { name: "Run the next event" })).toHaveProperty("disabled", true);
	});

	it("shows the time, the start and what is waiting", async () => {
		stubFetch(() => Promise.resolve(jsonResponse({ data: VIRTUAL })));
		renderPage(VIRTUAL);

		const found2 = await screen.findByTestId("clock-now");

		expect(found2.dataset["now"]).toBe(VIRTUAL.now);
		expect(screen.getByTestId("clock-pending").textContent).toContain("status delivered wamid.X");
	});

	it("advances once however often it is clicked, then shows what ran and any error", async () => {
		const pendingMove = Promise.withResolvers<Response>();
		const move: ClockMove = {
			from: VIRTUAL.now,
			to: "2026-06-01T08:05:00.000Z",
			fired: [
				{ sequence: 3, dueAt: "2026-06-01T08:02:00.000Z", label: "status delivered wamid.X" },
				{ sequence: 4, dueAt: "2026-06-01T08:04:00.000Z", label: "webhook retry", error: "boom" },
			],
			clock: { ...VIRTUAL, now: "2026-06-01T08:05:00.000Z", pending: [] },
		};
		const fetchMock = stubFetch(input => {
			if (input === "/api/clock/advance") {
				return pendingMove.promise;
			}

			return Promise.resolve(jsonResponse({ data: VIRTUAL }));
		});

		renderPage(VIRTUAL);
		await screen.findByTestId("clock-pending");

		const advance = screen.getByRole("button", { name: "Advance" });

		fireEvent.click(advance);
		fireEvent.click(advance);
		fireEvent.click(screen.getByRole("button", { name: "+1h" }));

		expect(screen.getByTestId("clock-busy").textContent).toBe("Advancing…");
		expect(fetchMock.mock.calls.filter(([input]) => input === "/api/clock/advance")).toHaveLength(1);

		pendingMove.resolve(jsonResponse({ data: move }));

		await waitFor(() => {
			expect(screen.getAllByTestId("clock-fired")).toHaveLength(2);
		});
		expect(screen.getByTestId("clock-move").textContent).toContain("1 with an error");
		expect(screen.getByText("boom")).toBeTruthy();
		expect(screen.getByTestId("clock-now").dataset["now"]).toBe("2026-06-01T08:05:00.000Z");
		expect(screen.queryByTestId("clock-busy")).toBeNull();
	});

	it("sends one move for a double click, even before the disabled buttons have rendered", async () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: VIRTUAL })));

		renderPage(VIRTUAL);
		await screen.findByTestId("clock-pending");

		const step = screen.getByRole("button", { name: "+1h" });

		// Both clicks land in one batch, the way a real double click can: no re-render in between.
		act(() => {
			step.click();
			step.click();
		});

		expect(fetchMock.mock.calls.filter(([input]) => input === "/api/clock/advance")).toHaveLength(1);
	});

	it("ignores the second click of a double click even when the first move has already finished", async () => {
		const move: ClockMove = { from: VIRTUAL.now, to: VIRTUAL.now, fired: [], clock: VIRTUAL };
		const fetchMock = stubFetch(input =>
			Promise.resolve(jsonResponse({ data: input === "/api/clock/advance" ? move : VIRTUAL })),
		);

		renderPage(VIRTUAL);
		await screen.findByTestId("clock-pending");

		const step = screen.getByRole("button", { name: "+1h" });

		fireEvent.click(step, { detail: 1 });
		await screen.findByTestId("clock-move");
		fireEvent.click(step, { detail: 2 });
		fireEvent.click(screen.getByRole("button", { name: "Advance" }), { detail: 2 });

		expect(fetchMock.mock.calls.filter(([input]) => input === "/api/clock/advance")).toHaveLength(1);
	});

	it("shows the server's refusal", async () => {
		stubFetch(input =>
			Promise.resolve(
				input === "/api/clock/set"
					? jsonResponse({ error: { message: "the clock only moves forward", code: "clock_backwards" } }, 400)
					: jsonResponse({ data: VIRTUAL }),
			),
		);
		renderPage(VIRTUAL);
		await screen.findByTestId("clock-pending");
		fireEvent.click(screen.getByRole("button", { name: "Move" }));

		const found3 = await screen.findByTestId("clock-error");

		expect(found3.textContent).toBe("the clock only moves forward");
	});
});
