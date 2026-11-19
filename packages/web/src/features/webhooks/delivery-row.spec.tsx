import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { jsonResponse, makeAppState, makeDelivery, stubFetch, type FetchMock } from "../../test/factories.ts";
import { DeliveryRow, describeOutcome, describeRetry } from "./delivery-row.tsx";

function renderRow(delivery = makeDelivery()): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(
		<table>
			<tbody>
				<DeliveryRow delivery={delivery} />
			</tbody>
		</table>,
		{ wrapper },
	);
}

describe("describeOutcome", () => {
	it("tells a skipped attempt apart from a failed one", () => {
		expect(describeOutcome(makeDelivery({ skipped: true, url: "", responseStatus: null })).label).toBe("skipped");
		expect(describeOutcome(makeDelivery({ responseStatus: null, error: "ECONNREFUSED" }))).toEqual({
			label: "error",
			tone: "badge--danger",
		});
	});

	it("colours by status class", () => {
		expect(describeOutcome(makeDelivery({ responseStatus: 200 })).tone).toBe("badge--ok");
		expect(describeOutcome(makeDelivery({ responseStatus: 404 })).tone).toBe("badge--warn");
		expect(describeOutcome(makeDelivery({ responseStatus: 500 })).tone).toBe("badge--danger");
	});
});

describe("describeRetry", () => {
	it("says when the next attempt is due, that the chain gave up, or nothing once delivered", () => {
		expect(
			describeRetry(
				makeDelivery({ responseStatus: 500, outcome: "retrying", nextAttemptAt: "2026-08-31T12:00:10.000Z" }),
			),
		).toMatch(/^retry at /);
		expect(describeRetry(makeDelivery({ responseStatus: 500, outcome: "failed" }))).toBe("gave up");
		expect(describeRetry(makeDelivery())).toBeNull();
	});
});

describe("DeliveryRow", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() =>
			Promise.resolve(jsonResponse({ data: [makeDelivery({ id: "delivery-2", attempt: 2 })] }, 201)),
		);
	});

	it("shows the summary without the payload until it is expanded", () => {
		renderRow(makeDelivery({ eventType: "message_template_status_update", attempt: 2, durationMs: 1200 }));

		expect(screen.getByText("message_template_status_update")).toBeTruthy();
		expect(screen.getByText("200")).toBeTruthy();
		expect(screen.getByText("#2")).toBeTruthy();
		expect(screen.getByText("1.20 s")).toBeTruthy();
		expect(screen.queryByText("Request body")).toBeNull();
	});

	it("expands into the exact bytes that were signed and sent", () => {
		renderRow();

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		expect(screen.getByText("Request headers")).toBeTruthy();
		expect(screen.getByText(/"x-hub-signature-256": "sha256=abc"/)).toBeTruthy();
		// The stored body is one line; the inspector pretty-prints it.
		expect(screen.getByText(/"object": "whatsapp_business_account"/)).toBeTruthy();
		expect(screen.getByText("Response body")).toBeTruthy();
	});

	it("says the signature was generated, never that the receiver verified it", () => {
		renderRow();
		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		const signature = screen.getByTestId("delivery-signature");

		expect(signature.textContent).toContain("signature generated");
		expect(signature.textContent).toContain("Whether the receiver verified it is not visible to mockwa");
		expect(signature.textContent).not.toMatch(/\bverified\b(?! it)/);
	});

	it("says an attempt without an app secret went unsigned", () => {
		renderRow(makeDelivery({ requestHeaders: { "content-type": "application/json" } }));
		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		expect(screen.getByTestId("delivery-signature").textContent).toContain("unsigned");
	});

	it("keeps a failed attempt's error, response and retry state in view", () => {
		renderRow(
			makeDelivery({
				responseStatus: 500,
				responseBody: '{"error":"down"}',
				outcome: "retrying",
				nextAttemptAt: "2026-08-31T12:00:30.000Z",
			}),
		);

		expect(screen.getByTestId("delivery-outcome").dataset["outcome"]).toBe("retrying");

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		const facts = screen.getByTestId("delivery-facts").textContent;

		expect(facts).toContain("retrying — another attempt is scheduled");
		expect(facts).toContain("HTTP 500");
		expect(screen.getByText(/"error": "down"/)).toBeTruthy();
	});

	it("collapses again on a second click", () => {
		renderRow();

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));
		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		expect(screen.queryByText("Request headers")).toBeNull();
	});

	it("redelivers the stored payload", async () => {
		renderRow(makeDelivery({ id: "delivery-1" }));

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));
		fireEvent.click(screen.getByRole("button", { name: "Redeliver" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		const [path, init] = fetchMock.mock.calls[0] ?? [];

		expect(path).toBe("/api/webhook-deliveries/delivery-1/redeliver");
		expect(init?.method).toBe("POST");
	});

	it("shows the transport error of an attempt that never got a response", () => {
		renderRow(makeDelivery({ responseStatus: null, responseBody: null, error: "connect ECONNREFUSED" }));

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		expect(screen.getByText("connect ECONNREFUSED")).toBeTruthy();
		expect(screen.queryByText("Response body")).toBeNull();
	});

	it("names the app the copy went to", () => {
		renderRow();

		expect(screen.getByText("whaloc")).toBeTruthy();
	});

	it("cancels a pending retry", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(jsonResponse({ data: [makeDelivery({ responseStatus: 500, outcome: "failed" })] })),
		);
		renderRow(makeDelivery({ responseStatus: 500, outcome: "retrying", nextAttemptAt: "2026-08-31T12:00:10.000Z" }));

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel retry" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith("/api/webhook-deliveries/delivery-1/cancel-retry", expect.anything());
		});
	});

	it("offers no cancel without a pending retry", () => {
		renderRow();

		fireEvent.click(screen.getByRole("button", { name: /Toggle delivery/ }));

		expect(screen.queryByRole("button", { name: "Cancel retry" })).toBeNull();
	});
});
