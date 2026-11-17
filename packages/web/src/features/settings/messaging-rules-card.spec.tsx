import type { MessagingRulesConfig } from "@mockwa/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { jsonResponse, stubFetch } from "../../test/factories.ts";
import { describeRules, MessagingRulesCard } from "./messaging-rules-card.tsx";

/** The read-only Settings card for Meta's messaging rules (SPEC §4). */
const DEFAULTS: MessagingRulesConfig = {
	serviceWindowMs: 86_400_000,
	throughput: null,
	pairRateLimit: null,
	messagingLimit: null,
};

describe("MessagingRulesCard", () => {
	it("describes the shipped defaults: a 24-hour window and every limit off", () => {
		expect(describeRules(DEFAULTS).map(rule => rule.value)).toEqual(["1d", "off", "off", "unlimited"]);
	});

	it("describes every configured rule in Meta's terms", () => {
		const values = describeRules({
			serviceWindowMs: 30_000,
			throughput: "meta",
			pairRateLimit: { intervalMs: 6000, burst: 45 },
			messagingLimit: 250,
		}).map(rule => rule.value);

		expect(values).toEqual(["30s", "Meta: 80/s STANDARD, 1000/s HIGH", "1 per 6s, bursts of 45", "250 users / 24h"]);
		expect(describeRules({ ...DEFAULTS, throughput: { messagesPerSecond: 5 } })[1]?.value).toBe("5/s per number");
	});

	it("fetches the messaging-limit count only when a limit is set", async () => {
		const fetchMock = stubFetch(() =>
			Promise.resolve(
				jsonResponse({
					data: { ...DEFAULTS, messagingLimit: 2, usage: [{ wabaId: "100000000000001", limit: 2, used: 1 }] },
				}),
			),
		);
		const { unmount } = render(<MessagingRulesCard rules={DEFAULTS} />);

		expect(screen.getByText("MOCKWA_SERVICE_WINDOW")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalled();

		unmount();
		render(<MessagingRulesCard rules={{ ...DEFAULTS, messagingLimit: 2 }} />);

		expect(await screen.findByText(/1 of 2 users reached/)).toBeTruthy();
	});
});
