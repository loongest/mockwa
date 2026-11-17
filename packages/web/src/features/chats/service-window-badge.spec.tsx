import type { ServiceWindow } from "@mockwa/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse, stubFetch } from "../../test/factories.ts";
import { describeServiceWindow, ServiceWindowBadge } from "./service-window-badge.tsx";

/** The conversation header's customer service window badge (SPEC §4). */
const CLOSED: ServiceWindow = {
	phoneNumberId: "100000000000002",
	waId: "5571990000001",
	isEnforced: true,
	isOpen: false,
	lastInboundAt: null,
	expiresAt: null,
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
