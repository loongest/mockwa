import type { MessagingLimitUsage, MessagingRulesConfig } from "@wasandbox/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/endpoints.ts";

/**
 * Meta's messaging rules as this WaSandbox enforces them (SPEC §4, "Messaging rules"). Read-only:
 * each rule is an environment variable, and the window is opened by the contact writing, exactly
 * as on WhatsApp. The card exists so a send that came back 429 or `failed` has an explanation one
 * click away.
 */

function durationText(ms: number): string {
	const units: [number, string][] = [
		[86_400_000, "d"],
		[3_600_000, "h"],
		[60_000, "m"],
		[1000, "s"],
	];
	const unit = units.find(([size]) => ms % size === 0);

	return unit === undefined ? `${String(ms)}ms` : `${String(ms / unit[0])}${unit[1]}`;
}

export function describeRules(rules: MessagingRulesConfig): { name: string; variable: string; value: string }[] {
	const { throughput, pairRateLimit } = rules;

	return [
		{
			name: "Customer service window (131047)",
			variable: "WASANDBOX_SERVICE_WINDOW",
			value: rules.serviceWindowMs === null ? "off" : durationText(rules.serviceWindowMs),
		},
		{
			name: "Throughput (130429)",
			variable: "WASANDBOX_THROUGHPUT",
			value:
				throughput === null
					? "off"
					: throughput === "meta"
						? "Meta: 80/s STANDARD, 1000/s HIGH"
						: `${String(throughput.messagesPerSecond)}/s per number`,
		},
		{
			name: "Pair rate limit (131056)",
			variable: "WASANDBOX_PAIR_RATE_LIMIT",
			value:
				pairRateLimit === null
					? "off"
					: `1 per ${durationText(pairRateLimit.intervalMs)}, bursts of ${String(pairRateLimit.burst)}`,
		},
		{
			name: "Messaging limit (simulated 990001)",
			variable: "WASANDBOX_MESSAGING_LIMIT",
			value: rules.messagingLimit === null ? "unlimited" : `${String(rules.messagingLimit)} users / 24h`,
		},
	];
}

/**
 * The rules come with `GET /api/state` (`behavior.messaging`); only the messaging-limit count is
 * fetched, and only when a limit is set — with none there is nothing to count.
 */
export function MessagingRulesCard(props: { rules: MessagingRulesConfig }) {
	const { rules } = props;
	const [usage, setUsage] = useState<MessagingLimitUsage[] | null>(null);
	const hasLimit = rules.messagingLimit !== null;

	useEffect(() => {
		if (!hasLimit) {
			return;
		}

		const controller = new AbortController();

		void (async () => {
			try {
				const loaded = await api.getMessagingRules({ signal: controller.signal });

				setUsage(loaded.usage);
			} catch {
				// The count is a convenience; the table above it is what the card is for.
			}
		})();

		return () => {
			controller.abort();
		};
	}, [hasLimit]);

	return (
		<div className="card stack">
			<p className="muted">
				Meta's rules for the send path. Refusals (throughput, pair rate) answer the request with an error; the window
				and the messaging limit accept the send and fail its status webhook instead.
			</p>
			<table className="table">
				<thead>
					<tr>
						<th>Rule</th>
						<th>Variable</th>
						<th>Setting</th>
					</tr>
				</thead>
				<tbody>
					{describeRules(rules).map(rule => (
						<tr key={rule.variable}>
							<td>{rule.name}</td>
							<td className="mono">{rule.variable}</td>
							<td>{rule.value}</td>
						</tr>
					))}
				</tbody>
			</table>
			{usage !== null && (
				<ul className="stack">
					{usage.map(entry => (
						<li key={entry.wabaId} className="faint">
							WABA <span className="mono">{entry.wabaId}</span>: {entry.used} of {entry.limit ?? "∞"} users reached
							outside a window in the last 24 hours
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
