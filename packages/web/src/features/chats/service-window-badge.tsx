import type { ServiceWindow } from "@wasandbox/shared";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { describeError } from "../../api/client.ts";
import { formatRemaining, useSimulatorNow } from "../../lib/sim-clock.tsx";
import { isRepeatClick } from "../../lib/repeat-click.ts";

/**
 * The customer service window of the open conversation (SPEC §4): whether the app under test may
 * send this contact free-form messages right now, or only templates.
 *
 * "Now" is **simulator time** — the server's clock, virtual or real — compared exactly as the
 * server compares it (open while `now < expiresAt`), so the badge and a send never disagree. The
 * server is asked again whenever `refreshKey` changes (the parent passes the latest inbound
 * message, the only thing that opens or refreshes a window) and adopts a window closed by hand
 * in any tab (`serviceWindowChange`). Under a virtual clock nothing ticks: the badge flips when
 * the clock is moved past the boundary, not when the wall clock gets there.
 */
export interface ServiceWindowBadgeProps {
	phoneNumberId: string;
	waId: string;
	refreshKey: string | null;
	/** The latest `service_window.changed` frame, for whichever conversation it was. */
	serviceWindowChange?: ServiceWindow | null;
}

export type ServiceWindowState = "open" | "closed" | "expired" | "none" | "off";

function clockTime(iso: string): string {
	const at = new Date(iso);

	return at.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function serviceWindowState(serviceWindow: ServiceWindow, now: number): ServiceWindowState {
	const { expiresAt } = serviceWindow;

	if (!serviceWindow.isEnforced) {
		return "off";
	}

	if (expiresAt === null) {
		return "none";
	}

	if (now < Date.parse(expiresAt)) {
		return "open";
	}

	return serviceWindow.expiredManuallyAt === null ? "closed" : "expired";
}

export function describeServiceWindow(
	serviceWindow: ServiceWindow,
	now: number,
): { label: string; tone: string; remaining: string | null } {
	const state = serviceWindowState(serviceWindow, now);
	const { expiresAt } = serviceWindow;

	switch (state) {
		case "off": {
			return { label: "Service window not enforced", tone: "", remaining: null };
		}

		case "none": {
			return { label: "No service window: templates only", tone: "badge--warn", remaining: null };
		}

		case "open": {
			return {
				label: `Service window open until ${clockTime(expiresAt!)}`,
				tone: "badge--ok",
				remaining: `${formatRemaining(Date.parse(expiresAt!) - now)} left`,
			};
		}

		case "expired": {
			return {
				label: `Service window expired by hand ${clockTime(expiresAt!)}: templates only`,
				tone: "badge--warn",
				remaining: null,
			};
		}

		case "closed": {
			return {
				label: `Service window closed ${clockTime(expiresAt!)}: templates only`,
				tone: "badge--warn",
				remaining: null,
			};
		}
	}
}

const EXPIRE_TITLE =
	"Closes the window between this business number and this contact only, at the current simulator time. " +
	"The clock does not move, other contacts keep their windows, and the contact's next message reopens it.";

export function ServiceWindowBadge(props: ServiceWindowBadgeProps) {
	const { phoneNumberId, waId, refreshKey, serviceWindowChange } = props;
	const [serviceWindow, setServiceWindow] = useState<ServiceWindow | null>(null);
	const [isExpiring, setIsExpiring] = useState(false);
	// What refuses a second click before the disabled button has rendered.
	const inFlight = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const now = useSimulatorNow(1000);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				setServiceWindow(await api.getServiceWindow(phoneNumberId, waId, { signal: controller.signal }));
			} catch {
				// An aborted or failed read leaves the badge as it was; it is a hint, not a gate.
			}
		})();

		return () => {
			controller.abort();
		};
	}, [phoneNumberId, waId, refreshKey]);

	useEffect(() => {
		if (serviceWindowChange?.phoneNumberId === phoneNumberId && serviceWindowChange.waId === waId) {
			setServiceWindow(serviceWindowChange);
		}
	}, [serviceWindowChange, phoneNumberId, waId]);

	if (serviceWindow === null) {
		return null;
	}

	const state = serviceWindowState(serviceWindow, now);
	const { label, tone, remaining } = describeServiceWindow(serviceWindow, now);

	const expire = (): void => {
		if (inFlight.current) {
			return;
		}

		inFlight.current = true;
		setIsExpiring(true);
		setError(null);

		void (async () => {
			try {
				setServiceWindow(await api.expireServiceWindow(phoneNumberId, waId));
			} catch (error_) {
				setError(describeError(error_));
			} finally {
				inFlight.current = false;
				setIsExpiring(false);
			}
		})();
	};

	return (
		<span
			className="row"
			data-testid="service-window"
			data-state={state}
			data-expires-at={serviceWindow.expiresAt ?? ""}
		>
			<span className={clsx("badge", tone)} title="Meta's 24-hour customer service window (SPEC §4), by simulator time">
				{label}
				{remaining !== null && <span className="faint"> · {remaining}</span>}
			</span>
			{state === "open" && (
				<button
					type="button"
					className="button button--sm"
					disabled={isExpiring}
					title={EXPIRE_TITLE}
					onClick={event => {
						if (!isRepeatClick(event)) {
							expire();
						}
					}}
				>
					{isExpiring ? "Expiring…" : "Expire now"}
				</button>
			)}
			{error !== null && (
				<span className="badge badge--danger" role="alert">
					{error}
				</span>
			)}
		</span>
	);
}
