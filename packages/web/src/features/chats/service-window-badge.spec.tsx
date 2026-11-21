import type { ServiceWindow } from "@wasandbox/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SimClockContext, type ClockSync } from "../../lib/sim-clock.tsx";
import { jsonResponse, requestBodyOf, stubFetch } from "../../test/factories.ts";
import { describeServiceWindow, ServiceWindowBadge } from "./service-window-badge.tsx";

/** The conversation header's customer service window badge (SPEC §4). */
const CLOSED: ServiceWindow = {
	phoneNumberId: "100000000000002",
	waId: "5571990000001",
	isEnforced: true,
	isOpen: false,
	lastInboundAt: null,
	expiresAt: null,
	expiredManuallyAt: null,
	windowMs: 86_400_000,
};
const OPENED_AT = Date.parse("2026-06-12T12:00:00.000Z");
const OPEN: ServiceWindow = {
	...CLOSED,
	isOpen: true,
	lastInboundAt: "2026-06-12T12:00:00.000Z",
	expiresAt: "2026-06-13T12:00:00.000Z",
};

describe("describeServiceWindow", () => {
	it("says templates only when the contact never wrote", () => {
		expect(describeServiceWindow(CLOSED, OPENED_AT)).toEqual({
			label: "No service window: templates only",
			tone: "badge--warn",
			remaining: null,
		});
	});

	it("is open until the 24 hours run out, and closed at that instant", () => {
		expect(describeServiceWindow(OPEN, OPENED_AT + 86_400_000 - 1)).toMatchObject({ tone: "badge--ok" });
		expect(describeServiceWindow(OPEN, OPENED_AT + 86_400_000)).toMatchObject({ tone: "badge--warn" });
		expect(describeServiceWindow(OPEN, OPENED_AT + 86_400_000).label).toMatch(
			/^Service window closed .*: templates only$/,
		);
	});

	it("says so when the window is not enforced", () => {
		expect(describeServiceWindow({ ...CLOSED, isEnforced: false }, OPENED_AT)).toEqual({
			label: "Service window not enforced",
			tone: "",
			remaining: null,
		});
	});
});

describe("ServiceWindowBadge", () => {
	it("asks the server about this number and contact", async () => {
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: CLOSED })));

		render(<ServiceWindowBadge phoneNumberId={CLOSED.phoneNumberId} waId={CLOSED.waId} refreshKey={null} />);

		expect(await screen.findByText("No service window: templates only")).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			`/api/service-window?phoneNumberId=${CLOSED.phoneNumberId}&waId=${CLOSED.waId}`,
			expect.anything(),
		);
	});
});

/** The badge on a virtual clock: frozen, and moved only by the server (SPEC §4). */
describe("ServiceWindowBadge on simulator time", () => {
	function virtualAt(iso: string): ClockSync {
		return {
			clock: { mode: "virtual", now: iso, start: iso, pending: [], deterministicIds: true },
			// Far from the simulated instant on purpose: the browser's clock must not matter.
			syncedAt: Date.parse("2031-01-01T00:00:00.000Z"),
		};
	}

	function renderAt(clock: ClockSync, serviceWindow: ServiceWindow = OPEN) {
		stubFetch(() => Promise.resolve(jsonResponse({ data: serviceWindow })));

		const view = render(
			<SimClockContext value={clock}>
				<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey={null} />
			</SimClockContext>,
		);

		return {
			...view,
			moveTo: (iso: string) => {
				view.rerender(
					<SimClockContext value={virtualAt(iso)}>
						<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey={null} />
					</SimClockContext>,
				);
			},
		};
	}

	it("is open one millisecond before the boundary, closed at it, by the server's clock", async () => {
		const view = renderAt(virtualAt("2026-06-13T11:59:59.999Z"));
		const badge = await screen.findByTestId("service-window");

		expect(badge.dataset["state"]).toBe("open");
		expect(badge.textContent).toContain("0s left");

		view.moveTo("2026-06-13T12:00:00.000Z");

		expect(screen.getByTestId("service-window").dataset["state"]).toBe("closed");
		expect(screen.getByTestId("service-window").textContent).toMatch(/closed .*: templates only/);
	});

	it("does not tick on its own under a virtual clock", async () => {
		renderAt(virtualAt("2026-06-12T12:00:00.000Z"));

		const found1 = await screen.findByTestId("service-window");

		expect(found1.textContent).toContain("1d 0h left");
		await new Promise(resolve => {
			setTimeout(resolve, 1100);
		});
		expect(screen.getByTestId("service-window").textContent).toContain("1d 0h left");
	});

	it("reopens when the server reports the contact's new message", async () => {
		const reopened: ServiceWindow = {
			...OPEN,
			lastInboundAt: "2026-06-13T12:00:00.000Z",
			expiresAt: "2026-06-14T12:00:00.000Z",
		};
		const fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: OPEN })));
		const at = virtualAt("2026-06-13T12:00:00.000Z");
		const view = render(
			<SimClockContext value={at}>
				<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey="wamid.1" />
			</SimClockContext>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("service-window").dataset["state"]).toBe("closed");
		});

		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: reopened })));
		view.rerender(
			<SimClockContext value={at}>
				<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey="wamid.2" />
			</SimClockContext>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("service-window").dataset["state"]).toBe("open");
		});
	});

	it("expires one number's window with one contact, and says it was by hand", async () => {
		const expired: ServiceWindow = {
			...OPEN,
			isOpen: false,
			expiresAt: "2026-06-12T13:00:00.000Z",
			expiredManuallyAt: "2026-06-12T13:00:00.000Z",
		};
		const fetchMock = stubFetch(input =>
			Promise.resolve(jsonResponse({ data: input === "/api/service-window/expire" ? expired : OPEN })),
		);

		render(
			<SimClockContext value={virtualAt("2026-06-12T13:00:00.000Z")}>
				<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey={null} />
			</SimClockContext>,
		);

		fireEvent.click(await screen.findByRole("button", { name: "Expire now" }));

		await waitFor(() => {
			expect(screen.getByTestId("service-window").dataset["state"]).toBe("expired");
		});
		expect(screen.getByTestId("service-window").textContent).toMatch(/expired by hand .*: templates only/);
		expect(screen.queryByRole("button", { name: "Expire now" })).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith("/api/service-window/expire", expect.objectContaining({ method: "POST" }));
		expect(requestBodyOf(fetchMock, 1)).toEqual({ phoneNumberId: OPEN.phoneNumberId, waId: OPEN.waId });
	});

	it("adopts a window another tab expired, but only its own", async () => {
		const at = virtualAt("2026-06-12T13:00:00.000Z");

		stubFetch(() => Promise.resolve(jsonResponse({ data: OPEN })));

		const view = render(
			<SimClockContext value={at}>
				<ServiceWindowBadge phoneNumberId={OPEN.phoneNumberId} waId={OPEN.waId} refreshKey={null} />
			</SimClockContext>,
		);

		await screen.findByRole("button", { name: "Expire now" });

		const change = { ...OPEN, isOpen: false, expiresAt: at.clock.now, expiredManuallyAt: at.clock.now };

		view.rerender(
			<SimClockContext value={at}>
				<ServiceWindowBadge
					phoneNumberId={OPEN.phoneNumberId}
					waId={OPEN.waId}
					refreshKey={null}
					serviceWindowChange={{ ...change, waId: "someone-else" }}
				/>
			</SimClockContext>,
		);

		expect(screen.getByTestId("service-window").dataset["state"]).toBe("open");

		view.rerender(
			<SimClockContext value={at}>
				<ServiceWindowBadge
					phoneNumberId={OPEN.phoneNumberId}
					waId={OPEN.waId}
					refreshKey={null}
					serviceWindowChange={change}
				/>
			</SimClockContext>,
		);

		await waitFor(() => {
			expect(screen.getByTestId("service-window").dataset["state"]).toBe("expired");
		});
	});
});
