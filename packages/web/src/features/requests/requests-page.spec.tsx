import type { GraphRequest } from "@mockwa/shared";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import { jsonResponse, makeAppState, stubFetch } from "../../test/factories.ts";
import { RequestsPage } from "./requests-page.tsx";

/** The Graph request log view (SPEC §5): summaries live, details on demand, secrets masked. */

const REJECTED: GraphRequest = {
	id: 2,
	receivedAt: "2026-06-01T08:00:00.000Z",
	durationMs: 4,
	method: "POST",
	path: "/v25.0/100000000000002/messages",
	query: "",
	status: 400,
	phoneNumberId: "100000000000002",
	appKey: "default",
	tokenMasked: "••••••oken",
	errorCode: 132_001,
	requestHeaders: { authorization: "Bearer ••••••oken", "content-type": "application/json" },
	requestBody: {
		kind: "json",
		contentType: "application/json",
		size: 96,
		text: '{"type":"template","template":{"name":"nope"}}',
		truncated: false,
	},
	responseBody: {
		kind: "json",
		contentType: "application/json",
		size: 120,
		text: '{"error":{"code":132001}}',
		truncated: false,
	},
};

const DOWNLOAD: GraphRequest = {
	...REJECTED,
	id: 1,
	method: "GET",
	path: "/whaloc-media/••••••••abcd",
	status: 200,
	errorCode: null,
	phoneNumberId: null,
	requestBody: { kind: "empty", contentType: null, size: 0, truncated: false },
	responseBody: { kind: "binary", contentType: "image/jpeg", size: 2048, truncated: false },
};

function summaryOf(request: GraphRequest) {
	const { requestHeaders: _headers, requestBody: _request, responseBody: _response, ...summary } = request;

	return summary;
}

function renderPage(): void {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<StoreProvider isLive={false} preloadedState={makeAppState()}>
			{children}
		</StoreProvider>
	);

	render(<RequestsPage />, { wrapper });
}

describe("RequestsPage", () => {
	it("lists the Graph calls with status, Meta's error code, number and app, and opens one", async () => {
		stubFetch(input => {
			if (input.startsWith("/api/graph-requests?")) {
				return Promise.resolve(
					jsonResponse({ data: [summaryOf(REJECTED), summaryOf(DOWNLOAD)], paging: { before: null } }),
				);
			}

			return Promise.resolve(jsonResponse({ data: input.endsWith("/2") ? REJECTED : DOWNLOAD }));
		});

		renderPage();

		const rows = await screen.findAllByTestId("graph-request");

		expect(rows.map(row => row.dataset["status"])).toEqual(["400", "200"]);
		expect(within(rows[0]!).getByText("code 132001")).toBeTruthy();
		expect(within(rows[0]!).getByText("100000000000002")).toBeTruthy();

		fireEvent.click(rows[0]!);

		const detail = await screen.findByTestId("request-detail");

		expect(detail.textContent).toContain("Bearer ••••••oken");
		expect(detail.textContent).toContain('"code": 132001');

		fireEvent.click(rows[1]!);

		const binary = await waitFor(() => {
			const found = screen.getAllByTestId("request-body").find(body => body.dataset["kind"] === "binary");

			expect(found).toBeDefined();

			return found!;
		});

		expect(binary.textContent).toContain("described, not stored");
		expect(binary.textContent).toContain("2.0 KB");
	});

	it("says why a body it could not mask was not stored, and shows nothing of it", async () => {
		const malformed: GraphRequest = {
			...REJECTED,
			id: 3,
			errorCode: 100,
			requestBody: {
				kind: "omitted",
				contentType: "application/json",
				size: 41,
				omittedReason:
					"malformed JSON: not stored, because secrets in text that does not parse cannot be found and masked",
				truncated: false,
			},
		};

		const list = { data: [summaryOf(malformed)], paging: { before: null } };

		stubFetch(input =>
			Promise.resolve(jsonResponse(input.startsWith("/api/graph-requests?") ? list : { data: malformed })),
		);
		renderPage();
		fireEvent.click(await screen.findByTestId("graph-request"));

		const omitted = await screen.findByTestId("request-body-omitted");

		expect(omitted.textContent).toContain("Not stored: malformed JSON");
		const section = screen.getAllByTestId("request-body").find(body => body.contains(omitted));

		expect(section?.dataset["kind"]).toBe("omitted");
		expect(screen.getByTestId("request-detail").textContent).toContain("41 B");
	});

	it("offers the export as a download and says what is kept", async () => {
		stubFetch(() => Promise.resolve(jsonResponse({ data: [], paging: { before: null } })));
		renderPage();

		expect(await screen.findByText(/No Graph requests yet/)).toBeTruthy();
		expect(screen.getByRole("link", { name: "Download JSON" }).getAttribute("href")).toBe("/api/graph-requests/export");
		expect(screen.getByText(/A reset empties the log; it is not part of a state export/)).toBeTruthy();
	});
});
