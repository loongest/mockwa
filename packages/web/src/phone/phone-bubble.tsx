import type { Message } from "@mockwa/shared";
import clsx from "clsx";
import { formatClock } from "../lib/format.ts";
import { readString } from "../lib/json.ts";
import { MessageBody } from "../features/chats/message-body.tsx";
import { summarize } from "../features/chats/message-bubble.tsx";
import { StatusTicks } from "../features/chats/status-ticks.tsx";

export interface PhoneBubbleProps {
	message: Message;
	reactions: Message[];
	repliedTo: Message | null;
	businessName: string;
}

/**
 * One message, from the phone's side: what this contact sent (inbound, to the business) sits on
 * the right with its ticks; what the business sent sits on the left. The bodies are the
 * console's own renderers, so a template or a button looks the same in both places.
 */
export function PhoneBubble(props: PhoneBubbleProps) {
	const { message } = props;
	const isMine = message.direction === "inbound";
	const sentAt = new Date(message.timestamp);

	return (
		<div
			className={clsx("bubble-row", isMine ? "bubble-row--out" : "bubble-row--in")}
			data-testid="phone-message"
			data-message-id={message.id}
			data-direction={isMine ? "sent" : "received"}
			data-status={message.status}
		>
			<div className={clsx("bubble", isMine ? "bubble--out" : "bubble--in", `bubble--${message.type}`)}>
				{props.repliedTo !== null && (
					<div className="bubble__quote">
						<span className="bubble__quote-author">
							{props.repliedTo.direction === "inbound" ? "You" : props.businessName}
						</span>
						<span className="bubble__quote-text">{summarize(props.repliedTo)}</span>
					</div>
				)}

				<MessageBody message={message} />

				<div className="bubble__meta">
					<time dateTime={message.timestamp} title={sentAt.toLocaleString()}>
						{formatClock(message.timestamp)}
					</time>
					{isMine && <StatusTicks status={message.status} error={message.error} />}
				</div>

				{props.reactions.length > 0 && (
					<div className="bubble__reactions">
						{props.reactions.map(reaction => (
							<span key={reaction.id} className="bubble__reaction">
								{readString(reaction.payload, "reaction", "emoji") ?? "∅"}
							</span>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
