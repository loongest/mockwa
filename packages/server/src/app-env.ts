import type { RequestLoggerVariables } from "./logging/index.ts";

/** Hono environment shared by every router mounted on the app. */
export interface AppEnv {
	Variables: RequestLoggerVariables & {
		/**
		 * How the console's access gate authenticated this request as the admin (SPEC §7):
		 * `bearer`, `cookie`, or `null` for nobody. Unset when no gate runs (dev mode, no token).
		 */
		adminAuth?: "bearer" | "cookie" | null;
		/** The visitor a public-mode phone request was authenticated as (SPEC §5). */
		visitor?: { sessionId: string; clientIp: string };
	};
}
