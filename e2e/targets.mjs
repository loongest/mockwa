// Where an end-to-end suite points, read from the environment and checked before anything runs.
//
// There are no defaults on purpose. A developer's own mockwa usually holds the familiar ports
// (8025, 8888, 18025…), and a suite that quietly fell back to them would send test traffic to,
// and restart, somebody's working instance. So every URL and container a suite touches must be
// named explicitly, and a missing or malformed one stops the suite before its first request or
// Docker command.

export class TargetConfigError extends Error {
	name = "TargetConfigError";
}

function urlProblem(name, value) {
	let url;

	try {
		url = new URL(value);
	} catch {
		return `${name} is not a URL: ${JSON.stringify(value)}`;
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return `${name} must be an http(s) URL, got ${JSON.stringify(value)}`;
	}

	// `new URL` drops a port that is the scheme's default, so an empty port means none was named.
	if (url.port === "") {
		return `${name} must name its port explicitly, such as http://127.0.0.1:58025, got ${JSON.stringify(value)}`;
	}

	return null;
}

/**
 * Reads `urls` (each must be an http(s) URL with an explicit port, returned without a trailing
 * slash) and `names` (any non-blank value) from `env`. Throws one {@link TargetConfigError}
 * listing every problem, so a run never stops at the first of several.
 */
export function readTargets(env, { suite, urls = [], names = [] }) {
	const problems = [];
	const targets = {};
	const entries = [...urls.map(name => ({ name, isUrl: true })), ...names.map(name => ({ name, isUrl: false }))];

	for (const { name, isUrl } of entries) {
		const value = env[name]?.trim() ?? "";
		const problem = value === "" ? `${name} is not set` : isUrl ? urlProblem(name, value) : null;

		if (problem === null) {
			targets[name] = isUrl ? value.replace(/\/+$/, "") : value;
		} else {
			problems.push(problem);
		}
	}

	if (problems.length > 0) {
		throw new TargetConfigError(
			`${suite}: the test targets are not configured, so nothing was run:\n` +
				problems.map(problem => `  - ${problem}`).join("\n") +
				"\nPoint each one at a dedicated test container (see .github/workflows/docker.yml).",
		);
	}

	return targets;
}

/** For the Node scripts: {@link readTargets}, or print the problems and exit 2. */
export function requireTargets(spec) {
	try {
		return readTargets(process.env, spec);
	} catch (error) {
		if (!(error instanceof TargetConfigError)) {
			throw error;
		}

		process.stderr.write(`${error.message}\n`);
		process.exit(2);
	}
}
