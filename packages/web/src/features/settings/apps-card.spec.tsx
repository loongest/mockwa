import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { StoreProvider } from "../../store/store.tsx";
import type { AppState } from "../../store/types.ts";
import {
	jsonResponse,
	makeAppState,
	makeStateResponse,
	makeWebhookApp,
	makeWebhookRouting,
	stubFetch,
	type FetchMock,
} from "../../test/factories.ts";
import { AppsCard } from "./apps-card.tsx";

/** Apps and webhook routing in Settings (SPEC §3, "Apps and routing"). */
const BILLING = makeWebhookApp({
	key: "200000000000002",
	id: "200000000000002",
	name: "Billing",
	isDefault: false,
	callbackUrl: "https://billing.test/hook",
	hasAccessToken: true,
});

function renderCard(state: Partial<AppState> = {}): void {
	const appState = makeAppState(state);

	render(
		<StoreProvider isLive={false} preloadedState={appState}>
			<AppsCard wabas={(appState.server ?? makeStateResponse()).wabas} />
		</StoreProvider>,
	);
}

function requestOf(fetchMock: FetchMock, index: number): { path: unknown; method: unknown; body: unknown } {
	const [path, init] = fetchMock.mock.calls[index] ?? [];

	return {
		path,
		method: init?.method,
		body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
	};
}

describe("AppsCard", () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = stubFetch(() => Promise.resolve(jsonResponse({ data: makeWebhookRouting() })));
	});

	it("loads the routing when nobody has yet", async () => {
		const routing = makeWebhookRouting({ apps: [makeWebhookApp(), BILLING] });

		fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ data: routing })));
		renderCard({ webhookRouting: null });

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Delete Billing" })).toBeTruthy();
		});

		expect(fetchMock).toHaveBeenCalledWith("/api/apps", expect.anything());
	});

	it("shows whether credentials are set, never their values", () => {
		renderCard({ webhookRouting: makeWebhookRouting({ apps: [makeWebhookApp(), BILLING] }) });

		expect(screen.getAllByText("secret")).toHaveLength(2);
		expect(screen.getByText("no access token")).toBeTruthy();
		expect(screen.getByText("access token")).toBeTruthy();
	});

	it("does not offer to delete the default app", () => {
		renderCard({ webhookRouting: makeWebhookRouting({ apps: [makeWebhookApp(), BILLING] }) });

		expect(screen.queryByRole("button", { name: "Delete whaloc" })).toBeNull();
		expect(screen.getByRole("button", { name: "Delete Billing" })).toBeTruthy();
	});

	it("creates an app with only the fields that were filled in", async () => {
		fetchMock.mockImplementation((_path, init) => {
			const isCreate = init?.method === "POST";

			return Promise.resolve(jsonResponse({ data: isCreate ? BILLING : makeWebhookRouting() }, isCreate ? 201 : 200));
		});
		renderCard();

		fireEvent.change(screen.getByLabelText("New app name"), { target: { value: "Billing" } });
		fireEvent.change(screen.getByLabelText("New app secret"), { target: { value: "s3cret" } });
		fireEvent.click(screen.getByRole("button", { name: "Add app" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		expect(requestOf(fetchMock, 0)).toEqual({
			path: "/api/apps",
			method: "POST",
			body: { name: "Billing", appSecret: "s3cret" },
		});
	});

	it("subscribes an app to a WABA from its checkbox", async () => {
		renderCard({ webhookRouting: makeWebhookRouting({ apps: [makeWebhookApp(), BILLING] }) });

		const waba = makeStateResponse().wabas[0]!;

		fireEvent.click(screen.getByLabelText(`Billing subscribed to ${waba.name}`));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestOf(fetchMock, 0)).toMatchObject({
			path: `/api/apps/${BILLING.key}/subscriptions/${waba.id}`,
			method: "PUT",
		});
	});

	it("sets a number override with Meta's URL and verify token pair", async () => {
		renderCard();

		const phone = makeStateResponse().wabas[0]!.phoneNumbers[0]!;
		const target = screen.getByLabelText<HTMLSelectElement>("Override target");
		const option = [...target.options].find(candidate => candidate.text.includes(phone.displayPhoneNumber))!;

		fireEvent.change(target, { target: { value: option.value } });
		fireEvent.change(screen.getByLabelText("Override URL"), { target: { value: "https://phone.test/hook" } });
		fireEvent.change(screen.getByLabelText("Override verify token"), { target: { value: "vt" } });
		fireEvent.click(screen.getByRole("button", { name: "Set override" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalled();
		});

		expect(requestOf(fetchMock, 0)).toEqual({
			path: `/api/apps/default/phone-overrides/${phone.id}`,
			method: "PUT",
			body: { callbackUri: "https://phone.test/hook", verifyToken: "vt" },
		});
	});

	it("does not send an override without a verify token", () => {
		renderCard();

		fireEvent.change(screen.getByLabelText("Override URL"), { target: { value: "https://waba.test/hook" } });
		fireEvent.click(screen.getByRole("button", { name: "Set override" }));

		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("lists the overrides in force", () => {
		const waba = makeStateResponse().wabas[0]!;

		renderCard({
			webhookRouting: makeWebhookRouting({
				subscriptions: [
					{
						wabaId: waba.id,
						appKey: "default",
						overrideCallbackUri: "https://waba.test/hook",
						subscribedAt: "2026-08-31T12:00:00.000Z",
						isImplicit: false,
					},
				],
			}),
		});

		expect(screen.getByText("https://waba.test/hook")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Remove WABA override of whaloc" })).toBeTruthy();
	});
});
