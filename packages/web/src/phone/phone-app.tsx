import type { Contact, Message, PhoneChat, PhoneMode, VisitorSession, WsEvent } from "@mockwa/shared";
import clsx from "clsx";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { connectEvents, type ConnectionStatus } from "../api/ws-client.ts";
import { ListTime } from "../components/list-time.tsx";
import { Toasts } from "../components/toasts.tsx";
import { summarize } from "../features/chats/message-bubble.tsx";
import { SimClockContext, type ClockSync } from "../lib/sim-clock.tsx";
import { describeError } from "../api/client.ts";
import { useToasts } from "../store/store.tsx";
import { ChatView } from "./chat-view.tsx";
import { isSessionLost, onSessionLost, phoneApi, phoneWsUrl } from "./phone-api.ts";
import { displayNumberOf, phoneSearch, readPhoneLocation, upsertMessage, type PhoneLocation } from "./phone-state.ts";

type Navigate = (next: PhoneLocation, options?: { replace?: boolean }) => void;

function initialOf(name: string): string {
	return name.trim().charAt(0).toUpperCase() || "?";
}

function RoleBadge(props: { role: string | null }) {
	return props.role === null ? null : <span className="phone-role">{props.role}</span>;
}

interface IdentityPickerProps {
	onPick: (waId: string) => void;
	/** A demo visitor's own identities; without them, every contact (developer mode). */
	identities?: Contact[];
	subtitle?: string;
	footer?: ReactNode;
}

/** Developer mode: nobody signs in, the tester picks which contact this tab is. */
function IdentityPicker(props: IdentityPickerProps) {
	const toasts = useToasts();
	const [loaded, setLoaded] = useState<Contact[] | null>(null);
	const identities = props.identities ?? loaded;
	const isGiven = props.identities !== undefined;

	useEffect(() => {
		if (isGiven) {
			return;
		}

		const controller = new AbortController();

		void (async () => {
			try {
				setLoaded(await phoneApi.identities({ signal: controller.signal }));
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [toasts, isGiven]);

	return (
		<section className="phone-picker" aria-label="Choose an identity">
			<header className="phone-bar">
				<div className="phone-bar__title">
					<strong>Virtual phone</strong>
					<span className="phone-bar__subtitle">{props.subtitle ?? "Developer mode: choose who you are"}</span>
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
			{props.footer}
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
	/** Public mode: the demo session ended while this phone was open (its socket closed with 4401). */
	onSessionEnded?: () => void;
}

/** The close code a visitor's socket gets when its demo session ends (SPEC §5). */
const SESSION_ENDED_CLOSE_CODE = 4401;

/**
 * One signed-in phone: its chats, the open chat, and the socket that keeps both live. The
 * socket is the phone's own (`/api/phone/identities/:waId/ws`), so nothing from another
 * identity's conversations ever reaches this tab.
 */
function PhoneScreen(props: PhoneScreenProps) {
	const { waId, phoneNumberId, navigate, onSessionEnded } = props;
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
			if (!isSessionLost(error)) {
				toasts.error(error);
			}
		}
	}, [waId, toasts]);

	useEffect(() => {
		void (async () => {
			let identities: Contact[];

			try {
				identities = await phoneApi.identities();
			} catch (error) {
				if (!isSessionLost(error)) {
					toasts.error(error);
				}

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
				if (!controller.signal.aborted && !isSessionLost(error)) {
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
				const state = await phoneApi.clock({ signal: controller.signal });

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
			shouldReconnect: code => {
				if (code === SESSION_ENDED_CLOSE_CODE) {
					onSessionEnded?.();

					return false;
				}

				return true;
			},
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
	}, [waId, reloadChats, navigate, onSessionEnded]);

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

function usePhoneLocation(): [PhoneLocation, Navigate] {
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

	return [location, navigate];
}

/** Developer mode: any contact, picked per tab. */
function DevPhone() {
	const [location, navigate] = usePhoneLocation();

	return location.waId === undefined ? (
		<IdentityPicker
			onPick={waId => {
				navigate({ waId });
			}}
		/>
	) : (
		<PhoneScreen key={location.waId} waId={location.waId} phoneNumberId={location.phoneNumberId} navigate={navigate} />
	);
}

type DemoState =
	| { kind: "loading" }
	| { kind: "welcome"; ended: boolean }
	| { kind: "starting"; ended: boolean }
	| { kind: "active"; session: VisitorSession };

function minutesOf(seconds: number): string {
	const minutes = Math.max(1, Math.round(seconds / 60));

	return `${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
}

function DemoWelcome(props: { ended: boolean; isStarting: boolean; onStart: () => void }) {
	return (
		<section className="phone-picker phone-welcome" aria-label="Start the demo" data-testid="phone-welcome">
			<header className="phone-bar">
				<div className="phone-bar__title">
					<strong>Virtual phone</strong>
					<span className="phone-bar__subtitle">Public demo</span>
				</div>
			</header>
			<div className="phone-welcome__body">
				{props.ended && (
					<p className="phone-notice" role="alert" data-testid="phone-session-ended">
						Your demo session has ended, so its chats and files were removed. Start a new demo to continue.
					</p>
				)}
				<p>
					You get your own demo phone numbers to message the business with. Nobody else can see your chats, and they are
					removed when you leave or stop using the demo.
				</p>
				<button
					type="button"
					className="button button--primary"
					data-testid="phone-start-demo"
					disabled={props.isStarting}
					onClick={props.onStart}
				>
					{props.isStarting ? "Starting…" : props.ended ? "Start a new demo" : "Start demo"}
				</button>
			</div>
		</section>
	);
}

/**
 * Public mode (SPEC §5): the visitor's own session decides which identities this tab may be.
 * The session lives in an HttpOnly cookie; when any request or the socket finds it gone, the
 * phone drops back to the welcome screen with an explanation instead of failing request by request.
 */
function PublicPhone() {
	const toasts = useToasts();
	const [location, navigate] = usePhoneLocation();
	const [state, setState] = useState<DemoState>({ kind: "loading" });

	const endDemo = useCallback(() => {
		setState({ kind: "welcome", ended: true });
		navigate({}, { replace: true });
	}, [navigate]);

	useEffect(() => onSessionLost(endDemo), [endDemo]);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				const session = await phoneApi.session({ signal: controller.signal });

				setState({ kind: "active", session });
			} catch (error) {
				if (controller.signal.aborted) {
					return;
				}

				if (isSessionLost(error)) {
					setState({ kind: "welcome", ended: error.code === "session_expired" });
				} else {
					toasts.error(error);
					setState({ kind: "welcome", ended: false });
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [toasts]);

	if (state.kind === "loading") {
		return <p className="phone-empty">Loading…</p>;
	}

	/** A new session opens straight onto its first identity. */
	const begin = (session: VisitorSession): void => {
		setState({ kind: "active", session });

		const [first] = session.identities;

		if (first !== undefined) {
			navigate({ waId: first.waId }, { replace: true });
		}
	};

	const start = (): void => {
		const isEnded = state.kind === "welcome" && state.ended;

		setState({ kind: "starting", ended: isEnded });
		void (async () => {
			try {
				begin(await phoneApi.startSession());
			} catch (error) {
				toasts.error(error);
				setState({ kind: "welcome", ended: isEnded });
			}
		})();
	};

	if (state.kind !== "active") {
		return <DemoWelcome ended={state.ended} isStarting={state.kind === "starting"} onStart={start} />;
	}

	const { session } = state;

	const leave = (): void => {
		void (async () => {
			try {
				await phoneApi.leaveSession();
			} catch (error) {
				if (!isSessionLost(error)) {
					toasts.error(new Error(`could not leave the demo: ${describeError(error)}`));

					return;
				}
			}

			setState({ kind: "welcome", ended: false });
			navigate({}, { replace: true });
		})();
	};
	const isOwn = session.identities.some(identity => identity.waId === location.waId);

	if (!isOwn || location.waId === undefined) {
		return (
			<IdentityPicker
				identities={session.identities}
				subtitle="Public demo: choose which of your numbers to use"
				onPick={waId => {
					navigate({ waId });
				}}
				footer={
					<div className="phone-demo-footer">
						<p className="phone-row__subtitle" data-testid="phone-demo-limits">
							The demo ends after {minutesOf(session.limits.sessionTtlSeconds)} without activity. Up to{" "}
							{session.limits.messagesPerMinute} messages a minute; images and PDFs up to{" "}
							{Math.floor(session.limits.mediaMaxBytes / 1024)} KB.
						</p>
						<button type="button" className="button button--ghost" data-testid="phone-leave-demo" onClick={leave}>
							Leave demo
						</button>
					</div>
				}
			/>
		);
	}

	return (
		<PhoneScreen
			key={location.waId}
			waId={location.waId}
			phoneNumberId={location.phoneNumberId}
			navigate={navigate}
			onSessionEnded={endDemo}
		/>
	);
}

/** The virtual phone at `/phone` on the console port (SPEC §5): one identity per tab. */
export function PhoneApp() {
	const toasts = useToasts();
	const [mode, setMode] = useState<PhoneMode | null>(null);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				setMode(await phoneApi.config({ signal: controller.signal }));
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
		<main className="phone-page" data-mode={mode ?? "loading"}>
			<div className="phone-frame">
				{mode === null && <p className="phone-empty">Loading…</p>}
				{mode === "dev" && <DevPhone />}
				{mode === "public" && <PublicPhone />}
			</div>
			<Toasts />
		</main>
	);
}
