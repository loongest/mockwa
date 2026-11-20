import { VISITOR_WA_ID_LENGTH } from "../config/index.ts";
import type { Repositories } from "../db/repositories/index.ts";

/**
 * Whether a log entry names a visitor who has already left (public mode, SPEC §5). A webhook
 * delivery or a Graph request can be in flight while its visitor leaves: the cleanup deletes
 * the log copies that exist, and this is how the late ones are refused instead of written back.
 */
export interface DepartedNumbers {
	isMentionedIn: (text: string) => Promise<boolean>;
}

/**
 * Departed numbers are the visitor numbers ever handed out (`public_wa_ids`, never reused) that
 * no live session owns. A number is matched as a whole run of digits, so a longer number that
 * happens to contain one is not mistaken for it.
 */
export function createDepartedNumbers(options: { repositories: Repositories; waIdPrefix: string }): DepartedNumbers {
	const digits = VISITOR_WA_ID_LENGTH - options.waIdPrefix.length;
	const pattern = new RegExp(String.raw`(?<!\d)${options.waIdPrefix}\d{${String(digits)}}(?!\d)`, "g");

	return {
		isMentionedIn: async text => {
			const candidates = new Set(text.match(pattern));

			if (candidates.size === 0) {
				return false;
			}

			const departed = await options.repositories.publicSessions.departedAmong([...candidates]);

			return departed.length > 0;
		},
	};
}
