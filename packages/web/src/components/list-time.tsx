import { formatListTime } from "../lib/format.ts";
import { useSimulatorNow } from "../lib/sim-clock.tsx";

/** A list's timestamp — the time today, the day before that — where "today" is simulator time. */
export function ListTime(props: { iso: string; className?: string }) {
	const now = useSimulatorNow();

	return (
		<time className={props.className} dateTime={props.iso}>
			{formatListTime(props.iso, new Date(now))}
		</time>
	);
}
