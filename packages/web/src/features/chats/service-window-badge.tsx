import type { ServiceWindow } from "@mockwa/shared";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { api } from "../../api/endpoints.ts";

/**
 * The customer service window of the open conversation (SPEC §4): whether the app under test may
 * send this contact free-form messages right now, or only templates.
 *
 * The server is asked again whenever `refreshKey` changes — the parent passes the latest inbound
 * message, the only thing that opens or refreshes a window — and the badge flips to closed on
 * its own at `expiresAt`, so a window that runs out while the view is open does not lie.
 */
export interface ServiceWindowBadgeProps {
	phoneNumberId: string;
	waId: string;
	refreshKey: string | null;
}

function clockTime(iso: string): string {
	const at = new Date(iso);

	return at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function describeServiceWindow(serviceWindow: ServiceWindow, now: number): { label: string; tone: string } {
	if (!serviceWindow.isEnforced) {
		return { label: "Service window not enforced", tone: "" };
	}

	const { expiresAt } = serviceWindow;
	const isOpen = expiresAt !== null && now < Date.parse(expiresAt);

	if (isOpen) {
		return { label: `Service window open until ${clockTime(expiresAt)}`, tone: "badge--ok" };
	}

	return {
		label:
			expiresAt === null
				? "No service window: templates only"
				: `Service window closed ${clockTime(expiresAt)}: templates only`,
		tone: "badge--warn",
	};
}

export function ServiceWindowBadge(props: ServiceWindowBadgeProps) {
	const { phoneNumberId, waId, refreshKey } = props;
	const [serviceWindow, setServiceWindow] = useState<ServiceWindow | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				setServiceWindow(await api.getServiceWindow(phoneNumberId, waId, { signal: controller.signal }));
				setNow(Date.now());
			} catch {
				// An aborted or failed read leaves the badge as it was; it is a hint, not a gate.
			}
		})();

		return () => {
			controller.abort();
		};
	}, [phoneNumberId, waId, refreshKey]);

	useEffect(() => {
		const closesAt = serviceWindow?.expiresAt ?? null;
		const expiresAt = closesAt === null ? null : Date.parse(closesAt);

		if (expiresAt === null || expiresAt <= now) {
			return;
		}

		const timer = setTimeout(
			() => {
				setNow(Date.now());
			},
			Math.min(expiresAt - now, 2_147_483_647),
		);

		return () => {
			clearTimeout(timer);
		};
	}, [serviceWindow, now]);

	if (serviceWindow === null) {
		return null;
	}

	const { label, tone } = describeServiceWindow(serviceWindow, now);

	return (
		<span className={clsx("badge", tone)} title="Meta's 24-hour customer service window (SPEC §4)">
			{label}
		</span>
	);
}
