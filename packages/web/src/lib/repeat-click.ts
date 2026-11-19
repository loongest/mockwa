/**
 * Whether a click is the second (or later) click of a double click. Buttons that change the
 * simulator — move the clock, close a window, reset and run — ignore it: a person who double
 * clicks means it once, and a local server can finish the first request before the second click
 * arrives, so a busy lock alone does not catch it. Keyboard and programmatic clicks report 0.
 */
export function isRepeatClick(event: { detail: number }): boolean {
	return event.detail > 1;
}
