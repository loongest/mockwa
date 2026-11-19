import clsx from "clsx";
import { Link } from "react-router";
import { displayTimeZone, useClockSync, useSimulatorNow } from "../lib/sim-clock.tsx";

const stamp = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The simulator clock in the top bar (SPEC §4): its mode and what time it is for mockwa — which
 * under a virtual clock is not the time on the wall. A link to the Clock view, where it is moved.
 */
export function ClockBadge() {
	const sync = useClockSync();
	const now = useSimulatorNow();

	if (sync === null) {
		return null;
	}

	const isVirtual = sync.clock.mode === "virtual";
	const instant = new Date(now);
	const zone = displayTimeZone();

	return (
		<Link
			to="/clock"
			className={clsx("badge", isVirtual ? "badge--info" : "")}
			data-testid="clock-badge"
			data-mode={sync.clock.mode}
			data-now={isVirtual ? sync.clock.now : undefined}
			title={`Simulator time, shown in ${zone}${isVirtual ? " — virtual: it only moves when told to" : " — real time"}`}
		>
			{isVirtual ? "virtual" : "real time"} · {stamp.format(instant)} <span className="faint">{zone}</span>
		</Link>
	);
}
