import type { InboundRequest, Message } from "@wasandbox/shared";
import { createContext, use, useRef, useState } from "react";
import { api } from "../../api/endpoints.ts";
import { useToasts } from "../../store/store.tsx";
import type { BuildResult, ComposerContext } from "./composer-payload.ts";

/**
 * Where a tapped reply goes. The console posts to `POST /api/inbound`, free to speak for any
 * contact; the virtual phone swaps in its own route, which only ever sends as the identity the
 * phone is signed in as.
 */
export type InboundSender = (request: InboundRequest) => Promise<unknown>;

export const InboundSenderContext = createContext<InboundSender>(async request => api.sendInbound(request));

/**
 * A reply the user sends by tapping something on an outbound message — a menu choice, a
 * template's quick reply — through the same `POST /api/inbound` the composer uses, as the contact
 * the message went to, quoting it the way Meta's `context` does on a real tap.
 */
export interface QuotedReplier {
	send: (build: (context: ComposerContext) => BuildResult) => void;
	/** A reply is in flight; the message's taps are disabled until it lands or fails. */
	pending: boolean;
}

/**
 * A refusal surfaces as a toast, like the composer's. One reply at a time: the ref turns away a
 * second tap in the same tick, before the disabled state has rendered, so a double click cannot
 * send the reply twice.
 */
export function useQuotedReply(message: Message): QuotedReplier {
	const toasts = useToasts();
	const sendInbound = use(InboundSenderContext);
	const inFlight = useRef(false);
	const [pending, setPending] = useState(false);

	const send = (build: (context: ComposerContext) => BuildResult) => {
		if (inFlight.current) {
			return;
		}

		const built = build({ phoneNumberId: message.phoneNumberId, from: message.contactWaId, replyTo: message.id });

		if (!built.ok) {
			toasts.error(new Error(built.error));

			return;
		}

		inFlight.current = true;
		setPending(true);
		void (async () => {
			try {
				await sendInbound(built.request);
			} catch (error_) {
				toasts.error(error_);
			} finally {
				inFlight.current = false;
				setPending(false);
			}
		})();
	};

	return { send, pending };
}
