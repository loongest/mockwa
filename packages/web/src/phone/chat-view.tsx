import type { InboundRequest, Message, PhoneChat } from "@mockwa/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from "react";
import { MediaResolverContext, type MediaResolver } from "../features/chats/media-preview.tsx";
import { InboundSenderContext, type InboundSender } from "../features/chats/use-quoted-reply.ts";
import { useToasts } from "../store/store.tsx";
import { phoneApi } from "./phone-api.ts";
import { PhoneBubble } from "./phone-bubble.tsx";
import { hasUnreadBusinessMessages, reactionTargetOf } from "./phone-state.ts";

export interface ChatViewProps {
	waId: string;
	phoneNumberId: string;
	chat: PhoneChat | undefined;
	/** `null` while the history loads. */
	messages: Message[] | null;
	isTyping: boolean;
	onBack: () => void;
}

/**
 * Reads the chat the way a person looking at it would: whenever a delivered business message is
 * on screen and the tab is visible. Each read is a real `read` status, with its webhook, so the
 * app under test sees exactly when its message was seen.
 */
function useReadReceipts(waId: string, phoneNumberId: string, messages: Message[] | null): void {
	const toasts = useToasts();
	const inFlight = useRef(false);
	const [isVisible, setIsVisible] = useState(() => document.visibilityState === "visible");

	useEffect(() => {
		const onChange = (): void => {
			setIsVisible(document.visibilityState === "visible");
		};

		document.addEventListener("visibilitychange", onChange);

		return () => {
			document.removeEventListener("visibilitychange", onChange);
		};
	}, []);

	useEffect(() => {
		if (!isVisible || messages === null || inFlight.current || !hasUnreadBusinessMessages(messages)) {
			return;
		}

		inFlight.current = true;
		void (async () => {
			try {
				await phoneApi.markRead(waId, phoneNumberId);
			} catch (error) {
				toasts.error(error);
			} finally {
				inFlight.current = false;
			}
		})();
	}, [isVisible, messages, waId, phoneNumberId, toasts]);
}

/** The business typing (SPEC §2.18): on the business's side of the thread, the left here. */
function BusinessTyping() {
	return (
		<div className="bubble-row bubble-row--in">
			<div className="bubble bubble--in bubble--typing" role="status" aria-label="typing">
				<span className="typing-dots" aria-hidden="true">
					<span className="typing-dots__dot" />
					<span className="typing-dots__dot" />
					<span className="typing-dots__dot" />
				</span>
			</div>
		</div>
	);
}

/** What the attach button offers: the types a public demo accepts (SPEC §5), in either mode. */
const ATTACHMENT_TYPES = "image/jpeg, image/png, image/webp, application/pdf";

/** The send for an uploaded attachment: a PDF goes as a document (with its name), the rest as an image. */
function attachmentRequest(
	chat: { waId: string; phoneNumberId: string },
	media: { id: string; mimeType: string },
	filename: string,
	caption: string,
): InboundRequest {
	const base = { phoneNumberId: chat.phoneNumberId, from: chat.waId };
	const withCaption = caption === "" ? {} : { caption };

	return media.mimeType === "application/pdf"
		? { ...base, type: "document", media: { id: media.id, filename, ...withCaption } }
		: { ...base, type: "image", media: { id: media.id, ...withCaption } };
}

function Composer(props: { waId: string; phoneNumberId: string }) {
	const toasts = useToasts();
	const [text, setText] = useState("");
	const [isSending, setIsSending] = useState(false);
	const fileInput = useRef<HTMLInputElement>(null);

	const attach = (file: File): void => {
		setIsSending(true);
		void (async () => {
			try {
				const media = await phoneApi.uploadMedia(props.waId, props.phoneNumberId, file);

				await phoneApi.send(props.waId, attachmentRequest(props, media, file.name, text.trim()));
				setText("");
			} catch (error) {
				toasts.error(error);
			} finally {
				setIsSending(false);
			}
		})();
	};

	const submit = (event: SyntheticEvent): void => {
		event.preventDefault();

		const body = text.trim();

		if (body === "" || isSending) {
			return;
		}

		setIsSending(true);
		void (async () => {
			try {
				await phoneApi.send(props.waId, {
					phoneNumberId: props.phoneNumberId,
					from: props.waId,
					type: "text",
					text: { body },
				});
				setText("");
			} catch (error) {
				toasts.error(error);
			} finally {
				setIsSending(false);
			}
		})();
	};

	return (
		<form className="phone-composer" onSubmit={submit}>
			<input
				ref={fileInput}
				type="file"
				hidden
				accept={ATTACHMENT_TYPES}
				data-testid="phone-attach-input"
				onChange={event => {
					const file = event.target.files?.[0];

					event.target.value = "";

					if (file !== undefined) {
						attach(file);
					}
				}}
			/>
			<button
				type="button"
				className="button button--ghost phone-composer__attach"
				aria-label="Attach an image or PDF"
				disabled={isSending}
				onClick={() => {
					fileInput.current?.click();
				}}
			>
				📎
			</button>
			<input
				className="input phone-composer__input"
				aria-label="Message"
				placeholder="Message"
				value={text}
				onChange={event => {
					setText(event.target.value);
				}}
			/>
			<button className="button button--primary" type="submit" disabled={isSending || text.trim() === ""}>
				Send
			</button>
		</form>
	);
}

/** One open chat: the history, the business's typing bubble, and a text composer. */
export function ChatView(props: ChatViewProps) {
	const { waId, phoneNumberId, messages } = props;
	const thread = useRef<HTMLDivElement>(null);
	const businessName = props.chat?.businessName ?? phoneNumberId;

	useReadReceipts(waId, phoneNumberId, messages);

	useLayoutEffect(() => {
		const element = thread.current;

		if (element !== null) {
			element.scrollTop = element.scrollHeight;
		}
	}, [messages, props.isTyping]);

	const { visible, reactionsByTarget, byId } = useMemo(() => {
		const all = messages ?? [];
		const reactions = new Map<string, Message[]>();
		const shown: Message[] = [];

		for (const message of all) {
			const target = reactionTargetOf(message);

			if (target === undefined) {
				shown.push(message);
			} else {
				reactions.set(target, [...(reactions.get(target) ?? []), message]);
			}
		}

		return {
			visible: shown,
			reactionsByTarget: reactions,
			byId: new Map(all.map(message => [message.id, message])),
		};
	}, [messages]);

	// A tapped button or quick reply goes out as this phone, through its own route.
	const sender = useMemo<InboundSender>(() => async request => phoneApi.send(waId, request), [waId]);
	// Media is looked up through the phone's own route, which only answers for what this phone may see.
	const resolveMedia = useMemo<MediaResolver>(
		() => async (mediaId, options) => phoneApi.media(waId, mediaId, options),
		[waId],
	);

	return (
		<MediaResolverContext value={resolveMedia}>
			<InboundSenderContext value={sender}>
				<section className="phone-chat" aria-label={`Chat with ${businessName}`}>
					<header className="phone-bar">
						<button type="button" className="button button--ghost" aria-label="Back to chats" onClick={props.onBack}>
							←
						</button>
						<div className="phone-bar__title">
							<strong>{businessName}</strong>
							<span className="phone-bar__subtitle">
								{props.isTyping ? "typing…" : (props.chat?.displayPhoneNumber ?? "")}
							</span>
						</div>
					</header>

					<div
						ref={thread}
						className="phone-chat__thread"
						data-testid="phone-thread"
						data-state={messages === null ? "loading" : "ready"}
					>
						{messages === null && <p className="phone-empty">Loading…</p>}
						{messages?.length === 0 && <p className="phone-empty">No messages yet. Say hello.</p>}
						{visible.map(message => (
							<PhoneBubble
								key={message.id}
								message={message}
								businessName={businessName}
								reactions={reactionsByTarget.get(message.id) ?? []}
								repliedTo={message.replyTo === null ? null : (byId.get(message.replyTo) ?? null)}
							/>
						))}
						{props.isTyping && <BusinessTyping />}
					</div>

					<Composer waId={waId} phoneNumberId={phoneNumberId} />
				</section>
			</InboundSenderContext>
		</MediaResolverContext>
	);
}
