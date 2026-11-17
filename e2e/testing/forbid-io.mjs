// Preloaded (`node --import`) by e2e/targets.test.mjs into a suite that must stop before doing
// anything: every way the suites reach the outside — fetch, a raw socket, a Docker command —
// is replaced by a tripwire that reports the attempt on stderr and throws.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";

const TRIPWIRE = "FORBIDDEN-IO-ATTEMPTED";

function tripwire(what) {
	return (...args) => {
		process.stderr.write(`${TRIPWIRE} ${what} ${JSON.stringify(String(args[0]))}\n`);

		throw new Error(`${TRIPWIRE}: ${what}`);
	};
}

Object.defineProperty(globalThis, "fetch", { value: tripwire("fetch"), writable: true, configurable: true });
net.Socket.prototype.connect = tripwire("net.connect");

for (const name of ["exec", "execFile", "execFileSync", "execSync", "spawn", "spawnSync", "fork"]) {
	childProcess[name] = tripwire(`child_process.${name}`);
}

syncBuiltinESMExports();
