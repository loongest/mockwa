/**
 * The scenarios that ship in `examples/scenarios/` (SPEC §4, "Scenarios"), bundled into the UI
 * at build time so the console can offer them without the server reading files for it.
 */

const files: Record<string, string> = import.meta.glob("../../../../../examples/scenarios/*.json", {
	query: "?raw",
	import: "default",
	eager: true,
});

export interface ScenarioExample {
	file: string;
	text: string;
}

export const SCENARIO_EXAMPLES: readonly ScenarioExample[] = Object.entries(files)
	.map(([path, text]) => ({ file: path.slice(path.lastIndexOf("/") + 1), text }))
	.toSorted((a, b) => a.file.localeCompare(b.file));
