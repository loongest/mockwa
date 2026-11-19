import type { Contact, Message, PhoneChat, WsEvent } from "@mockwa/shared";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints.ts";
import { connectEvents, type ConnectionStatus } from "../api/ws-client.ts";
import { ListTime } from "../components/list-time.tsx";
import { Toasts } from "../components/toasts.tsx";
import { summarize } from "../features/chats/message-bubble.tsx";
import { SimClockContext, type ClockSync } from "../lib/sim-clock.tsx";
import { useToasts } from "../store/store.tsx";
import { ChatView } from "./chat-view.tsx";
import { phoneApi, phoneWsUrl } from "./phone-api.ts";
import { displayNumberOf, phoneSearch, readPhoneLocation, upsertMessage, type PhoneLocation } from "./phone-state.ts";

type Navigate = (next: PhoneLocation, options?: { replace?: boolean }) => void;

function initialOf(name: string): string {
	return name.trim().charAt(0).toUpperCase() || "?";
}

function RoleBadge(props: { role: string | null }) {
	return props.role === null ? null : <span className="phone-role">{props.role}</span>;
}

/** Developer mode: nobody signs in, the tester picks which contact this tab is. */
function IdentityPicker(props: { onPick: (waId: string) => void }) {
	const toasts = useToasts();
	const [identities, setIdentities] = useState<Contact[] | null>(null);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				setIdentities(await phoneApi.identities({ signal: controller.signal }));
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [toasts]);

	return (
		<section className="phone-picker" aria-label="Choose an identity">
			<header className="phone-bar">
				<div className="phone-bar__title">
					<strong>Virtual phone</strong>
					<span className="phone-bar__subtitle">Developer mode: choose who you are</span>
				</div>
			</header>
			{identities === null && <p className="phone-empty">Loading…</p>}
			{identities?.length === 0 && (
				<p className="phone-empty">No contacts yet. Add one in the console&apos;s Settings, or in the seed.</p>
			)}
			<ul className="phone-list">
				{identities?.map(identity => (
					<li key={identity.waId}>
						<button
							type="button"
							className="phone-row"
							data-testid="phone-identity"
							data-wa-id={identity.waId}
							onClick={() => {
								props.onPick(identity.waId);
							}}
						>
							<span className="phone-avatar" aria-hidden="true">
								{initialOf(identity.profileName)}
							</span>
							<span className="phone-row__main">
								<span className="phone-row__title">
									{identity.profileName} <RoleBadge role={identity.role} />
								</span>
								<span className="phone-row__subtitle">{displayNumberOf(identity)}</span>
							</span>
						</button>
					</li>
				))}
			</ul>
		</section>
	);
}

function ChatList(props: { chats: PhoneChat[] | null; onOpen: (phoneNumberId: string) => void }) {
	if (props.chats === null) {
		return <p className="phone-empty">Loading…</p>;
	}

	if (props.chats.length === 0) {
		return <p className="phone-empty">No business numbers to chat with.</p>;
	}

	return (
		<ul className="phone-list" aria-label="Chats">
			{props.chats.map(chat => (
				<li key={chat.id}>
					<button
						type="button"
						className="phone-row"
						data-testid="phone-chat"
						data-phone-number-id={chat.phoneNumberId}
						onClick={() => {
							props.onOpen(chat.phoneNumberId);
						}}
					>
						<span className="phone-avatar" aria-hidden="true">
							{initialOf(chat.businessName)}
						</span>
						<span className="phone-row__main">
							<span className="phone-row__title">{chat.businessName}</span>
							<span className="phone-row__subtitle">
								{chat.lastMessage === null
									? chat.displayPhoneNumber
									: `${chat.lastMessage.direction === "inbound" ? "You: " : ""}${summarize(chat.lastMessage)}`}
							</span>
						</span>
						<span className="phone-row__side">
							{chat.lastMessage !== null && <ListTime iso={chat.lastMessage.timestamp} />}
							{chat.unreadCount > 0 && (
								<span className="phone-unread" aria-label={`${String(chat.unreadCount)} unread`}>
									{chat.unreadCount}
								</span>
							)}
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

interface PhoneScreenProps {
	waId: string;
	phoneNumberId: string | undefined;
	navigate: Navigate;
}

/**
 * One signed-in phone: its chats, the open chat, and the socket that keeps both live. The
 * socket is the phone's own (`/api/phone/identities/:waId/ws`), so nothing from another
 * identity's conversations ever reaches this tab.
 */
function PhoneScreen(props: PhoneScreenProps) {
	const { waId, phoneNumberId, navigate } = props;
	const toasts = useToasts();
	const [identity, setIdentity] = useState<Contact | null>(null);
	const [chats, setChats] = useState<PhoneChat[] | null>(null);
	const [messages, setMessages] = useState<Message[] | null>(null);
	const [typing, setTyping] = useState<ReadonlySet<string>>(new Set());
	const [connection, setConnection] = useState<ConnectionStatus>("connecting");
	const [reloads, setReloads] = useState(0);
	// The phone labels its chats by simulator time, like the console (SPEC §4).
	const [clock, setClock] = useState<ClockSync | null>(null);
	const openChat = useRef(phoneNumberId);

	openChat.current = phoneNumberId;

	const reloadChats = useCallback(async () => {
		try {
			setChats(await phoneApi.chats(waId));
		} catch (error) {
			toasts.error(error);
		}
	}, [waId, toasts]);

	useEffect(() => {
		void (async () => {
			let identities: Contact[];

			try {
				identities = await phoneApi.identities();
			} catch (error) {
				toasts.error(error);

				return;
			}

			const found = identities.find(contact => contact.waId === waId);

			if (found === undefined) {
				toasts.error(new Error(`no contact with wa_id ${waId}: pick another identity`));
				navigate({}, { replace: true });
			} else {
				setIdentity(found);
			}
		})();
		void reloadChats();
	}, [waId, reloads, reloadChats, navigate, toasts]);

	useEffect(() => {
		if (phoneNumberId === undefined) {
			setMessages(null);

			return;
		}

		const controller = new AbortController();

		setMessages(null);
		void (async () => {
			try {
				const page = await phoneApi.messages(waId, phoneNumberId, {}, { signal: controller.signal });

				setMessages(page.data);
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [waId, phoneNumberId, reloads, toasts]);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				const state = await api.getClock({ signal: controller.signal });

				setClock({ clock: state, syncedAt: Date.now() });
			} catch {
				// Without a reading the browser's clock stands in; the next reload tries again.
			}
		})();

		return () => {
			controller.abort();
		};
	}, [reloads]);

	useEffect(() => {
		let hasConnected = false;

		const onEvent = (event: WsEvent): void => {
			switch (event.type) {
				case "clock.changed": {
					setClock({ clock: event.payload.clock, syncedAt: Date.now() });
					break;
				}

				case "message.created":
				case "message.status_changed": {
					const { message } = event.payload;

					if (message.phoneNumberId === openChat.current) {
						setMessages(current => (current === null ? current : upsertMessage(current, message)));
					}

					void reloadChats();
					break;
				}

				case "typing.changed": {
					const { typing: indicator } = event.payload;

					setTyping(current => {
						const next = new Set(current);

						if (indicator.expiresAt === null) {
							next.delete(indicator.phoneNumberId);
						} else {
							next.add(indicator.phoneNumberId);
						}

						return next;
					});
					break;
				}

				case "contact.changed": {
					if (event.payload.contact.waId === waId) {
						setIdentity(event.payload.contact);
					} else if (event.payload.previousWaId === waId) {
						// The person moved to a new number: the phone follows them.
						navigate({ waId: event.payload.contact.waId, phoneNumberId: openChat.current }, { replace: true });
					}

					break;
				}

				case "phone_number.changed":
				case "waba.changed": {
					void reloadChats();
					break;
				}

				case "state.reset":
				case "state.imported": {
					setReloads(count => count + 1);
					break;
				}

				default: {
					break;
				}
			}
		};

		return connectEvents({
			url: phoneWsUrl(waId),
			onEvent,
			onStatus: status => {
				setConnection(status);

				// Events were missed while the socket was down: re-read rather than guess.
				if (status === "open" && hasConnected) {
					setReloads(count => count + 1);
				}

				if (status === "open") {
					hasConnected = true;
				}
			},
		});
	}, [waId, reloadChats, navigate]);

	const chat = chats?.find(candidate => candidate.phoneNumberId === phoneNumberId);

	return (
		<SimClockContext value={clock}>
			<div className="phone-screen" data-testid="phone-screen" data-wa-id={waId}>
				<header className="phone-identity">
					<span className="phone-avatar" aria-hidden="true">
						{initialOf(identity?.profileName ?? "")}
					</span>
					<span className="phone-row__main">
						<span className="phone-row__title" data-testid="phone-identity-name">
							{identity?.profileName ?? waId} <RoleBadge role={identity?.role ?? null} />
						</span>
						<span className="phone-row__subtitle">{identity === null ? "" : displayNumberOf(identity)}</span>
					</span>
					<span
						className={clsx("connection", `connection--${connection}`)}
						data-testid="phone-connection"
						data-connection={connection}
					>
						<span className="connection__dot" aria-hidden="true" />
						<span>{connection === "open" ? "live" : connection}</span>
					</span>
					<button
						type="button"
						className="button button--ghost"
						onClick={() => {
							navigate({});
						}}
					>
						Switch
					</button>
				</header>

				{phoneNumberId === undefined ? (
					<ChatList
						chats={chats}
						onOpen={id => {
							navigate({ waId, phoneNumberId: id });
						}}
					/>
				) : (
					<ChatView
						waId={waId}
						phoneNumberId={phoneNumberId}
						chat={chat}
						messages={messages}
						isTyping={typing.has(phoneNumberId)}
						onBack={() => {
							navigate({ waId });
						}}
					/>
				)}
			</div>
		</SimClockContext>
	);
}

/** The virtual phone at `/phone` on the console port (SPEC §5): one identity per tab. */
export function PhoneApp() {
	const [location, setLocation] = useState(() => readPhoneLocation(globalThis.location.search));

	useEffect(() => {
		const onPopState = (): void => {
			setLocation(readPhoneLocation(globalThis.location.search));
		};

		globalThis.addEventListener("popstate", onPopState);

		return () => {
			globalThis.removeEventListener("popstate", onPopState);
		};
	}, []);

	const navigate = useCallback<Navigate>((next, options) => {
		const url = `${globalThis.location.pathname}${phoneSearch(next)}`;

		if (options?.replace === true) {
			globalThis.history.replaceState(null, "", url);
		} else {
			globalThis.history.pushState(null, "", url);
		}

		setLocation(next);
	}, []);

	return (
		<main className="phone-page">
			<div className="phone-frame">
				{location.waId === undefined ? (
					<IdentityPicker
						onPick={waId => {
							navigate({ waId });
						}}
					/>
				) : (
					<PhoneScreen
						key={location.waId}
						waId={location.waId}
						phoneNumberId={location.phoneNumberId}
						navigate={navigate}
					/>
				)}
			</div>
			<Toasts />
		</main>
	);
}
