import type { WebhookDelivery } from "@mockwa/shared";
import clsx from "clsx";
import { useState } from "react";
import { api } from "../../api/endpoints.ts";
import { JsonBlock } from "../../components/json-block.tsx";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { formatClockWithSeconds, formatDuration } from "../../lib/format.ts";
import { prettyJsonText } from "../../lib/json.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";

export interface DeliveryOutcome {
	label: string;
	tone: string;
}

/**
 * What the row's status cell says. A delivery with no URL configured was never sent — the
 * payload is logged anyway (SPEC §3) — and that is a different thing from a request that
 * failed, so it gets its own label rather than an empty status.
 */
export function describeOutcome(delivery: WebhookDelivery): DeliveryOutcome {
	if (delivery.skipped) {
		return { label: "skipped", tone: "" };
	}

	if (delivery.responseStatus === null) {
		return { label: "error", tone: "badge--danger" };
	}

	if (delivery.responseStatus >= 500) {
		return { label: String(delivery.responseStatus), tone: "badge--danger" };
	}

	if (delivery.responseStatus >= 400) {
		return { label: String(delivery.responseStatus), tone: "badge--warn" };
	}

	return { label: String(delivery.responseStatus), tone: "badge--ok" };
}

/**
 * What became of the chain this attempt belongs to (SPEC §3): Meta keeps retrying anything
 * but a `200`, so "500" alone does not say whether another attempt is coming.
 */
export function describeRetry(delivery: WebhookDelivery): string | null {
	if (delivery.nextAttemptAt !== null) {
		return `retry at ${formatClockWithSeconds(delivery.nextAttemptAt)}`;
	}

	return delivery.outcome === "failed" ? "gave up" : null;
}

const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * What can honestly be said about the signature (SPEC §1.12): mockwa **generated** it over the
 * exact body bytes with the app's secret. Whether the receiver **verified** it is something only
 * the receiver knows — its answer says what it decided, not why — so nothing here claims it.
 */
export function describeSignature(delivery: WebhookDelivery): { label: string; detail: string } {
	const header = delivery.requestHeaders[SIGNATURE_HEADER];

	if (header === undefined) {
		return {
			label: "unsigned",
			detail: "No app secret is configured for this app, so no x-hub-signature-256 header was sent.",
		};
	}

	return {
		label: "signature generated",
		detail:
			"mockwa computed x-hub-signature-256 (HMAC-SHA256 of the body below with the app secret) and sent it. " +
			"Whether the receiver verified it is not visible to mockwa: the response status is all it reports.",
	};
}

/** The chain's state in words: Meta retries anything but a 200 (SPEC §3). */
const OUTCOME_TEXT: Record<WebhookDelivery["outcome"], string> = {
	delivered: "delivered — the receiver answered 200",
	retrying: "retrying — another attempt is scheduled",
	failed: "failed — no further attempt will be made",
	skipped: "skipped — the app has no callback URL, nothing was sent",
};

export interface DeliveryRowProps {
	delivery: WebhookDelivery;
}

/** One attempt in the delivery log, expandable into the exact bytes that went out. */
export function DeliveryRow(props: DeliveryRowProps) {
	const { delivery } = props;
	const [open, setOpen] = useState(false);
	const run = useAction();
	const toasts = useToasts();
	const dispatch = useDispatch();
	const { webhookRouting } = useAppState();
	const outcome = describeOutcome(delivery);
	const retry = describeRetry(delivery);
	const appName = webhookRouting?.apps.find(app => app.key === delivery.appKey)?.name ?? delivery.appKey;
	const signature = describeSignature(delivery);

	return (
		<>
			<tr
				className={clsx("delivery", open && "is-open")}
				onClick={() => {
					setOpen(!open);
				}}
			>
				<td>
					<button
						type="button"
						className="link-button"
						aria-expanded={open}
						aria-label={`Toggle delivery ${delivery.id}`}
					>
						{open ? "▾" : "▸"}
					</button>
				</td>
				<td className="faint mono">{formatClockWithSeconds(delivery.createdAt)}</td>
				<td>
					<span className="chip">{delivery.eventType}</span>
				</td>
				<td>
					<span
						className={clsx("badge", outcome.tone)}
						title={OUTCOME_TEXT[delivery.outcome]}
						data-testid="delivery-outcome"
						data-outcome={delivery.outcome}
					>
						{outcome.label}
					</span>
				</td>
				<td className="faint">{appName}</td>
				<td className="faint">
					#{delivery.attempt}
					{retry !== null && <span className="delivery__retry"> · {retry}</span>}
				</td>
				<td className="faint">{formatDuration(delivery.durationMs)}</td>
				<td className="faint mono delivery__url">{delivery.url === "" ? "—" : delivery.url}</td>
			</tr>

			{open && (
				<tr className="delivery__details">
					<td colSpan={8}>
						<div className="stack">
							{delivery.error !== null && <p className="composer__error">{delivery.error}</p>}

							<dl className="facts" data-testid="delivery-facts">
								<dt>Outcome</dt>
								<dd>
									{OUTCOME_TEXT[delivery.outcome]}
									{delivery.nextAttemptAt !== null && ` (next at ${formatClockWithSeconds(delivery.nextAttemptAt)})`}
								</dd>
								<dt>Response</dt>
								<dd>
									{delivery.responseStatus === null ? "no HTTP response" : `HTTP ${String(delivery.responseStatus)}`}
									{delivery.durationMs === null ? "" : ` in ${formatDuration(delivery.durationMs)}`}
								</dd>
								<dt>Signature</dt>
								<dd data-testid="delivery-signature" title={signature.detail}>
									<span className="badge">{signature.label}</span> <span className="faint">{signature.detail}</span>
								</dd>
							</dl>

							<div className="row row--wrap">
								<button
									type="button"
									className="button button--sm"
									onClick={event => {
										event.stopPropagation();
										run(async () => api.redeliverWebhook(delivery.id));
									}}
								>
									Redeliver
								</button>
								<span className="faint">
									Redelivery re-sends these exact body bytes, signed again with the app's current secret.
								</span>
								{delivery.nextAttemptAt !== null && (
									<button
										type="button"
										className="button button--sm"
										onClick={event => {
											event.stopPropagation();
											run(async () => {
												dispatch({ type: "delivery/updated", delivery: await api.cancelWebhookRetry(delivery.id) });
											});
										}}
									>
										Cancel retry
									</button>
								)}
								<button
									type="button"
									className="button button--sm"
									onClick={event => {
										event.stopPropagation();

										void (async () => {
											const result = await copyToClipboard(delivery.requestBody);

											toasts.info(result === "copied" ? "Request body copied" : "The clipboard is not available here");
										})();
									}}
								>
									Copy body
								</button>
							</div>

							<section>
								<h3 className="card__title">Request headers</h3>
								<JsonBlock value={delivery.requestHeaders} />
							</section>

							<section>
								<h3 className="card__title">Request body</h3>
								<JsonBlock text={prettyJsonText(delivery.requestBody)} />
							</section>

							{delivery.responseBody !== null && (
								<section>
									<h3 className="card__title">Response body</h3>
									<JsonBlock text={prettyJsonText(delivery.responseBody)} />
								</section>
							)}
						</div>
					</td>
				</tr>
			)}
		</>
	);
}
