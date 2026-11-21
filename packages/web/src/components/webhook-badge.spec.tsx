import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "../store/store.tsx";
import type { AppState } from "../store/types.ts";
import { makeAppState, makeStateResponse } from "../test/factories.ts";
import { shortWebhookUrl, WebhookBadge } from "./webhook-badge.tsx";

/** The webhook receiver, named in the top bar so a reply is never mistaken for WaSandbox's own. */
function renderBadge(state: Partial<AppState>): void {
	render(
		<MemoryRouter>
			<StoreProvider isLive={false} preloadedState={makeAppState(state)}>
				<WebhookBadge />
			</StoreProvider>
		</MemoryRouter>,
	);
}

describe("the webhook badge", () => {
	it("names the configured receiver and links to the Webhooks view", () => {
		renderBadge({ server: makeStateResponse() });

		const badge = screen.getByTestId("webhook-badge");

		expect(badge.textContent).toBe("webhooks → receiver.test/meta-webhooks");
		expect(badge.getAttribute("href")).toBe("/webhooks");
		expect(badge.getAttribute("title")).toBe("Webhooks are sent to https://receiver.test/meta-webhooks (signed)");
	});

	it("says nothing is sent when no receiver is configured", () => {
		const server = makeStateResponse();

		renderBadge({ server: { ...server, webhook: { ...server.webhook, url: null, appSecretConfigured: false } } });

		const badge = screen.getByTestId("webhook-badge");

		expect(badge.textContent).toBe("webhooks: not sent");
		expect(badge.className).toContain("webhook-badge--off");
	});

	it("renders nothing before the state has loaded", () => {
		renderBadge({ server: null });

		expect(screen.queryByTestId("webhook-badge")).toBeNull();
	});

	it("shortens a URL to its host and path", () => {
		expect(shortWebhookUrl("https://host.docker.internal:3002/webhook")).toBe("host.docker.internal:3002/webhook");
		expect(shortWebhookUrl("https://app.test/")).toBe("app.test");
		expect(shortWebhookUrl("not a url")).toBe("not a url");
	});
});
