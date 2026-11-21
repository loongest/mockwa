#!/usr/bin/env node
import { main } from "./scenario-command.ts";

// The `wasandbox` executable (SPEC §4, "Scenarios"); everything it does is in `scenario-command.ts`.
process.exitCode = await main(process.argv.slice(2), {
	env: process.env,
	fetch,
	out: line => {
		process.stdout.write(`${line}\n`);
	},
	err: line => {
		process.stderr.write(`${line}\n`);
	},
});
