/**
 * The version whaloc stamps on a state snapshot (SPEC §5).
 *
 * The release tag is the only source of truth: the Docker build passes it in as the
 * `WASANDBOX_VERSION` build argument, which the image carries as an environment variable
 * (`MOCKWA_VERSION` and `WHALOC_VERSION` are still read as aliases, SPEC §7). Nothing in the repository is bumped
 * for a release, so there is nothing to forget — the workspace
 * `package.json` versions stay `0.0.0`, which is fine for packages that are never published. A
 * run from source is `0.0.0-dev`. Nothing depends on it being right: an import is gated on the
 * snapshot's *schema* version, not on this.
 */
export function whalocVersion(env: Readonly<Record<string, string | undefined>>): string {
	for (const key of ["WASANDBOX_VERSION", "MOCKWA_VERSION", "WHALOC_VERSION"]) {
		const version = env[key]?.trim();

		if (version !== undefined && version !== "") {
			return version;
		}
	}

	return "0.0.0-dev";
}

export const WASANDBOX_VERSION = whalocVersion(process.env);
