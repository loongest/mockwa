import { parseDurationMs, type ClockMove, type ClockState } from "@wasandbox/shared";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { api } from "../../api/endpoints.ts";
import { describeError } from "../../api/client.ts";
import { displayTimeZone, useClockSync, useSimulatorNow } from "../../lib/sim-clock.tsx";
import { formatTimestamp } from "../../lib/format.ts";
import { useDispatch } from "../../store/store.tsx";
import { isRepeatClick } from "../../lib/repeat-click.ts";

/**
 * The simulator clock (SPEC §4, "Virtual clock"): where it is, what is waiting on it, and — with
 * `WASANDBOX_CLOCK=virtual` — the three ways to move it. Every move is one request at a time: the
 * controls lock while one is in flight, so a double click cannot advance twice.
 */

const QUICK_STEPS = ["1m", "5m", "1h", "24h"] as const;

type Busy = "advance" | "set" | "next" | null;

const BUSY_LABEL: Record<Exclude<Busy, null>, string> = {
	advance: "Advancing…",
	set: "Moving…",
	next: "Running the next event…",
};

/** `2026-06-01T08:00` in the browser's zone, as a `datetime-local` input wants it. */
export function toLocalInput(iso: string): string {
	const date = new Date(iso);
	const pad = (value: number): string => String(value).padStart(2, "0");

	return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function MoveResult(props: { move: ClockMove }) {
	const { move } = props;
	const failed = move.fired.filter(event => event.error !== undefined).length;

	return (
		<div className="card stack" data-testid="clock-move">
			<div className="row row--wrap">
				<strong>
					{formatTimestamp(move.from)} → {formatTimestamp(move.to)}
				</strong>
				<span className={clsx("badge", failed > 0 ? "badge--danger" : "badge--ok")}>
					{move.fired.length} event{move.fired.length === 1 ? "" : "s"} ran
					{failed > 0 ? `, ${String(failed)} with an error` : ""}
				</span>
			</div>
			{move.fired.length > 0 && (
				<table className="table">
					<thead>
						<tr>
							<th>Due</th>
							<th>Event</th>
							<th>Outcome</th>
						</tr>
					</thead>
					<tbody>
						{move.fired.map(event => (
							<tr key={event.sequence} data-testid="clock-fired">
								<td className="mono">{formatTimestamp(event.dueAt)}</td>
								<td className="mono">{event.label}</td>
								<td>
									{event.error === undefined ? (
										<span className="badge badge--ok">ran</span>
									) : (
										<span className="badge badge--danger badge--wrap">{event.error}</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

function PendingEvents(props: { clock: ClockState }) {
	const { pending } = props.clock;

	if (pending === null) {
		return <p className="faint">The real clock does not list its timers.</p>;
	}

	if (pending.length === 0) {
		return (
			<p className="empty" data-testid="clock-pending-empty">
				Nothing is waiting on the clock.
			</p>
		);
	}

	return (
		<table className="table" data-testid="clock-pending">
			<thead>
				<tr>
					<th>#</th>
					<th>Due</th>
					<th>Event</th>
				</tr>
			</thead>
			<tbody>
				{pending.map(event => (
					<tr key={event.sequence}>
						<td className="mono">{event.sequence}</td>
						<td className="mono">{formatTimestamp(event.dueAt)}</td>
						<td className="mono">{event.label}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

/** A submit button's second click of a double click submits nothing. */
function preventRepeatSubmit(event: MouseEvent<HTMLButtonElement>): void {
	if (isRepeatClick(event)) {
		event.preventDefault();
	}
}

export function ClockPage() {
	const sync = useClockSync();
	const now = useSimulatorNow(1000);
	const dispatch = useDispatch();
	const [busy, setBusy] = useState<Busy>(null);
	// `busy` is what the buttons render from; this is what refuses a second click. Two clicks can
	// arrive before React re-renders the disabled buttons (a double click does), and both would
	// read the same stale `busy`.
	const inFlight = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [move, setMove] = useState<ClockMove | null>(null);
	const [by, setBy] = useState("5m");
	const [to, setTo] = useState("");
	const clock = sync?.clock ?? null;
	const isVirtual = clock?.mode === "virtual";

	const adopt = useCallback(
		(state: ClockState) => {
			dispatch({ type: "clock/loaded", clock: state, syncedAt: Date.now() });
		},
		[dispatch],
	);

	// Pending events change without the clock moving (a send schedules its status rungs), so the
	// view reads the clock again when it opens and on request, rather than trusting the last move.
	const refresh = useCallback(async () => {
		adopt(await api.getClock());
	}, [adopt]);

	useEffect(() => {
		void refresh().catch(() => {
			// The top bar still shows the last reading; the Refresh button retries.
		});
	}, [refresh]);

	useEffect(() => {
		if (clock !== null && to === "") {
			setTo(toLocalInput(clock.now));
		}
	}, [clock, to]);

	if (clock === null) {
		return (
			<div className="page">
				<p className="empty">Reading the clock…</p>
			</div>
		);
	}

	const perform = (kind: Exclude<Busy, null>, action: () => Promise<ClockMove>): void => {
		if (inFlight.current) {
			return;
		}

		inFlight.current = true;
		setBusy(kind);
		setError(null);

		void (async () => {
			try {
				const result = await action();

				setMove(result);
				adopt(result.clock);
			} catch (error_) {
				setError(describeError(error_));
			} finally {
				inFlight.current = false;
				setBusy(null);
			}
		})();
	};

	const instant = new Date(now);
	const nowIso = instant.toISOString();
	const isValidBy = parseDurationMs(by) !== undefined;
	const target = to === "" ? null : new Date(to);
	const isValidTarget = target !== null && Number.isFinite(target.getTime());
	const isLocked = busy !== null || !isVirtual;

	return (
		<div className="page">
			<header className="page__header">
				<div className="page__title">
					<h1>Clock</h1>
					<span className={clsx("badge", isVirtual ? "badge--info" : "")} data-testid="clock-mode">
						{isVirtual ? "virtual" : "real time"}
					</span>
				</div>
				<button
					type="button"
					className="button button--sm"
					onClick={() => {
						void refresh().catch((error_: unknown) => {
							setError(describeError(error_));
						});
					}}
				>
					Refresh
				</button>
			</header>

			<div className="page__body stack">
				<div className="card stack">
					<dl className="facts">
						<dt>Simulator time</dt>
						<dd data-testid="clock-now" data-now={nowIso}>
							{formatTimestamp(nowIso)} <span className="faint mono">{nowIso}</span>
						</dd>
						<dt>Shown in</dt>
						<dd>{displayTimeZone()} (this browser's time zone; the server stores UTC)</dd>
						<dt>Start</dt>
						<dd>
							{clock.start === null ? (
								<span className="faint">— (real time)</span>
							) : (
								<>
									{formatTimestamp(clock.start)} <span className="faint">where a reset puts the clock</span>
								</>
							)}
						</dd>
						<dt>IDs</dt>
						<dd>{clock.deterministicIds ? "deterministic (seeded stream)" : "random"}</dd>
					</dl>
					<p className="muted" data-testid="clock-explainer">
						{isVirtual
							? "This clock stands still until you move it. Moving it runs whatever falls due (status webhooks, retries, template approvals) in order."
							: "wasandbox runs on real time. Start it with WASANDBOX_CLOCK=virtual to stop time and move it from here."}{" "}
						These controls move <strong>WaSandbox's</strong> clock only: the app under test keeps its own clock, so its
						own timers (an OTP's expiry, a session timeout) are not affected.
					</p>
				</div>

				<div className={clsx("card stack", !isVirtual && "is-disabled")} aria-disabled={!isVirtual}>
					<h2 className="card__title">Move the clock</h2>
					<form
						className="row row--wrap"
						onSubmit={event => {
							event.preventDefault();

							if (isValidBy) {
								perform("advance", async () => api.advanceClock(by.trim()));
							}
						}}
					>
						<label className="field">
							<span className="field__label">Advance by</span>
							<input
								className="input"
								value={by}
								disabled={isLocked}
								aria-invalid={!isValidBy}
								onChange={event => {
									setBy(event.target.value);
								}}
							/>
							<span className="field__hint">500ms, 30s, 5m, 24h or 7d</span>
						</label>
						<button
							type="submit"
							className="button button--primary"
							disabled={isLocked || !isValidBy}
							onClick={preventRepeatSubmit}
						>
							Advance
						</button>
						{QUICK_STEPS.map(step => (
							<button
								key={step}
								type="button"
								className="button button--sm"
								disabled={isLocked}
								onClick={event => {
									if (!isRepeatClick(event)) {
										perform("advance", async () => api.advanceClock(step));
									}
								}}
							>
								+{step}
							</button>
						))}
					</form>

					<form
						className="row row--wrap"
						onSubmit={event => {
							event.preventDefault();

							if (isValidTarget) {
								perform("set", async () => api.setClock(target.toISOString()));
							}
						}}
					>
						<label className="field">
							<span className="field__label">Move forward to ({displayTimeZone()})</span>
							<input
								className="input"
								type="datetime-local"
								value={to}
								disabled={isLocked}
								onChange={event => {
									setTo(event.target.value);
								}}
							/>
							<span className="field__hint">Forward only: a reset is the way back.</span>
						</label>
						<button
							type="submit"
							className="button"
							disabled={isLocked || !isValidTarget}
							onClick={preventRepeatSubmit}
						>
							Move
						</button>
					</form>

					<div className="row row--wrap">
						<button
							type="button"
							className="button"
							disabled={isLocked || clock.pending?.length === 0}
							onClick={event => {
								if (!isRepeatClick(event)) {
									perform("next", async () => api.runNextClockEvent());
								}
							}}
						>
							Run the next event
						</button>
						{busy !== null && (
							<span className="badge badge--info" role="status" data-testid="clock-busy">
								{BUSY_LABEL[busy]}
							</span>
						)}
					</div>

					{error !== null && (
						<p className="field__error" role="alert" data-testid="clock-error">
							{error}
						</p>
					)}
				</div>

				{move !== null && <MoveResult move={move} />}

				<div className="card stack">
					<h2 className="card__title">Waiting on the clock</h2>
					<PendingEvents clock={clock} />
				</div>
			</div>
		</div>
	);
}
