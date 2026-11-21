import clsx from "clsx";
import { NavLink } from "react-router";
import { useAppState } from "../store/store.tsx";

/** `host[:port]/path` of a webhook URL: enough to recognise the app, short enough for the bar. */
export function shortWebhookUrl(url: string): string {
	if (!URL.canParse(url)) {
		return url;
	}

	const parsed = new URL(url);

	return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
}

/**
 * Where WaSandbox sends its webhooks (`WASANDBOX_WEBHOOK_URL`), in the corner of every view (SPEC §5).
 *
 * A reply in a chat comes from whatever app receives these deliveries, never from
 * WaSandbox itself; naming the receiver next to the connection indicator is what keeps that
 * obvious. With no URL configured, deliveries are only logged, and the badge says so. Either
 * way it links to the Webhooks view, which has the full URL, the handshake and the log.
 */
export function WebhookBadge() {
	const { server } = useAppState();

	if (server === null) {
		return null;
	}

	const { url, appSecretConfigured } = server.webhook;
	const title =
		url === null
			? "WASANDBOX_WEBHOOK_URL is not set: webhook payloads are logged on the Webhooks view, not sent anywhere"
			: `Webhooks are sent to ${url} (${appSecretConfigured ? "signed" : "unsigned"})`;

	return (
		<NavLink
			to="/webhooks"
			className={clsx("webhook-badge", url === null && "webhook-badge--off")}
			title={title}
			data-testid="webhook-badge"
		>
			<span className="webhook-badge__dot" aria-hidden="true" />
			<span>{url === null ? "webhooks: not sent" : `webhooks → ${shortWebhookUrl(url)}`}</span>
		</NavLink>
	);
}
