import type { Contact, Message, PhoneChat, VisitorSession, WsEvent } from "@mockwa/shared";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "../store/store.tsx";
import {
	jsonResponse,
	makeContact,
	makeMessage,
	PHONE_NUMBER_ID,
	stubFetch,
	type FetchMock,
} from "../test/factories.ts";
import { PhoneApp } from "./phone-app.tsx";

/**
 * The virtual phone through the DOM: pick an identity, open a chat, send and receive. The REST
 * calls go to a stubbed `fetch` and the socket is a fake one the test pushes frames into.
 */

const ANA = "5571990000001";
const BRUNO = "5571990000002";
const IDENTITIES: Contact[] = [
	makeContact({ waId: ANA, profileName: "Customer A", role: "CUSTOMER", displayNumber: "+60 12-345 0001" }),
	makeContact({ waId: BRUNO, profileName: "Ah Mad", role: "TECHNICIAN" }),
];
const CHAT_PATH = `/api/phone/identities/${ANA}/chats/${PHONE_NUMBER_ID}`;
const VISITOR_SESSION: VisitorSession = {
	identities: [IDENTITIES[0]!],
	csrfToken: "csrf-for-this-browser",
	expiresAt: "2026-08-31T12:30:00.000Z",
	limits: {
		sessionTtlSeconds: 1800,
		messagesPerMinute: 20,
		mediaMaxBytes: 1_048_576,
		mediaPerSession: 10,
		mediaTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
	},
};

class FakeWebSocket extends EventTarget {
	static readonly instances: FakeWebSocket[] = [];
	readonly url: string;

	constructor(url: string) {
		super();
		this.url = url;
		FakeWebSocket.instances.push(this);
		queueMicrotask(() => {
			this.dispatchEvent(new Event("open"));
		});
	}

	push(event: WsEvent): void {
		this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
	}

	close(): void {
		// The client stops for good before closing; nothing to report back.
	}

	/** The server closing the socket, e.g. with 4401 when a demo session ends. */
	serverClose(code: number): void {
		this.dispatchEvent(Object.assign(new Event("close"), { code }));
	}
}

function chatOf(lastMessage: Message | null = null, unreadCount = 0): PhoneChat {
	return {
		id: `${PHONE_NUMBER_ID}:${ANA}`,
		phoneNumberId: PHONE_NUMBER_ID,
		businessName: "Acme Support",
		displayPhoneNumber: "+1 555 0100",
		lastMessage,
		unreadCount,
	};
}

describe("the virtual phone", () => {
	let fetchMock: FetchMock;
	let history: Message[];
	let mode: "dev" | "public";
	/** Public mode: whether this browser has a live demo session, and what a read answers without one. */
	let session: "none" | "expired" | "live";

	beforeEach(() => {
		FakeWebSocket.instances.length = 0;
		mode = "dev";
		session = "none";
		vi.stubGlobal("WebSocket", FakeWebSocket);
		globalThis.history.replaceState(null, "", "/phone");
		history = [
			makeMessage({
				id: "wamid.in",
				direction: "inbound",
				contactWaId: ANA,
				status: "delivered",
				payload: { text: { body: "Is my order ready?" } },
			}),
			makeMessage({
				id: "wamid.out",
				contactWaId: ANA,
				status: "sent",
				timestamp: "2026-08-31T12:00:05.000Z",
				payload: { text: { body: "echo: Is my order ready?" } },
			}),
		];
		const respond = (path: string, init?: RequestInit): Response => {
			if (path === "/api/phone/config") {
				return jsonResponse({ data: { mode } });
			}

			if (path === "/api/public/session") {
				if (init?.method === "POST") {
					session = "live";

					return jsonResponse({ data: VISITOR_SESSION }, 201);
				}

				if (init?.method === "DELETE") {
					session = "none";

					return new Response(null, { status: 204 });
				}

				return session === "live"
					? jsonResponse({ data: VISITOR_SESSION })
					: jsonResponse(
							{
								error: {
									message: "this demo session has ended; start a new one",
									code: session === "expired" ? "session_expired" : "session_required",
								},
							},
							401,
						);
			}

			if (path === "/api/phone/clock") {
				return jsonResponse({ error: { message: "no clock in this stub" } }, 500);
			}

			if (path === "/api/phone/identities") {
				return jsonResponse({ data: mode === "public" ? VISITOR_SESSION.identities : IDENTITIES });
			}

			if (path === `${CHAT_PATH}/media`) {
				return jsonResponse(
					{
						data: {
							id: "1234567890",
							phoneNumberId: PHONE_NUMBER_ID,
							mimeType: "image/png",
							sha256: "00",
							fileSize: 4,
							createdAt: "2026-08-31T12:00:00.000Z",
						},
					},
					201,
				);
			}

			if (path === `/api/phone/identities/${ANA}/chats`) {
				return jsonResponse({ data: [chatOf(history.at(-1) ?? null)] });
			}

			if (path === `${CHAT_PATH}/messages` && init?.method === "POST") {
				return jsonResponse({ data: makeMessage({ id: "wamid.new", direction: "inbound" }) }, 201);
			}

			if (path.startsWith(`${CHAT_PATH}/messages`)) {
				return jsonResponse({ data: history, paging: { before: null } });
			}

			if (path === `${CHAT_PATH}/read`) {
				return jsonResponse({ data: { read: 1 } });
			}

			return jsonResponse({ error: { message: `unexpected ${path}` } }, 500);
		};

		fetchMock = stubFetch((path, init) => Promise.resolve(respond(path, init)));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function renderPhone(): void {
		render(
			<StoreProvider isLive={false}>
				<PhoneApp />
			</StoreProvider>,
		);
	}

	async function openAnasChat(): Promise<void> {
		renderPhone();
		fireEvent.click(await screen.findByText("Customer A"));
		fireEvent.click(await screen.findByText("Acme Support"));
		await screen.findByText("Is my order ready?");
	}

	it("lists every identity with its role and number, and signs this tab in as the one picked", async () => {
		renderPhone();

		const rows = await screen.findAllByTestId("phone-identity");

		expect(rows).toHaveLength(2);
		expect(within(rows[0]!).getByText("CUSTOMER")).toBeTruthy();
		expect(within(rows[0]!).getByText("+60 12-345 0001")).toBeTruthy();
		expect(within(rows[1]!).getByText(`+${BRUNO}`)).toBeTruthy();

		fireEvent.click(rows[0]!);

		expect(await screen.findByText("Acme Support")).toBeTruthy();
		expect(globalThis.location.search).toBe(`?as=${ANA}`);
		expect(FakeWebSocket.instances.at(-1)!.url).toMatch(new RegExp(`/api/phone/identities/${ANA}/ws$`));
	});

	it("shows both sides of the chat, its own messages with ticks", async () => {
		await openAnasChat();

		const messages = screen.getAllByTestId("phone-message");

		expect(messages.map(element => element.dataset["direction"])).toEqual(["sent", "received"]);
		expect(within(messages[0]!).getByRole("img", { name: "delivered" })).toBeTruthy();
		expect(within(messages[1]!).queryByRole("img")).toBeNull();
		expect(globalThis.location.search).toBe(`?as=${ANA}&chat=${PHONE_NUMBER_ID}`);
	});

	it("sends a text as the signed-in identity, through the phone's own route", async () => {
		await openAnasChat();

		fireEvent.change(screen.getByLabelText("Message"), { target: { value: "  Thanks!  " } });
		fireEvent.click(screen.getByRole("button", { name: "Send" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`${CHAT_PATH}/messages`, expect.objectContaining({ method: "POST" }));
		});

		const call = fetchMock.mock.calls.find(
			([path, init]) => path === `${CHAT_PATH}/messages` && init?.method === "POST",
		);

		expect(JSON.parse(call![1]!.body as string)).toEqual({
			phoneNumberId: PHONE_NUMBER_ID,
			from: ANA,
			type: "text",
			text: { body: "Thanks!" },
		});
	});

	it("shows a pushed reply live and reads it once it is delivered", async () => {
		await openAnasChat();

		const socket = FakeWebSocket.instances.at(-1)!;
		const reply = makeMessage({
			id: "wamid.reply",
			contactWaId: ANA,
			status: "sent",
			timestamp: "2026-08-31T12:00:09.000Z",
			payload: { text: { body: "Your order ships today" } },
		});

		act(() => {
			socket.push({ type: "message.created", payload: { message: reply } });
		});

		expect(await screen.findByText("Your order ships today")).toBeTruthy();
		expect(fetchMock).not.toHaveBeenCalledWith(`${CHAT_PATH}/read`, expect.anything());

		act(() => {
			socket.push({
				type: "message.status_changed",
				payload: { message: { ...reply, status: "delivered" }, previousStatus: "sent" },
			});
		});

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`${CHAT_PATH}/read`, expect.objectContaining({ method: "POST" }));
		});
	});

	it("sends a tapped reply button as this phone", async () => {
		history = [
			makeMessage({
				id: "wamid.menu",
				contactWaId: ANA,
				type: "interactive",
				status: "read",
				payload: {
					interactive: {
						type: "button",
						body: { text: "Is my order ready?" },
						action: { buttons: [{ type: "reply", reply: { id: "confirm", title: "Confirm" } }] },
					},
				},
			}),
		];
		await openAnasChat();

		fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

		await waitFor(() => {
			expect(fetchMock).toHaveBeenCalledWith(`${CHAT_PATH}/messages`, expect.objectContaining({ method: "POST" }));
		});
		expect(fetchMock).not.toHaveBeenCalledWith("/api/inbound", expect.anything());
	});

	describe("in public mode", () => {
		beforeEach(() => {
			mode = "public";
		});

		it("starts a demo, then opens the visitor's own identity and nothing else", async () => {
			renderPhone();

			fireEvent.click(await screen.findByTestId("phone-start-demo"));

			expect(await screen.findByText("Acme Support")).toBeTruthy();
			expect(globalThis.location.search).toBe(`?as=${ANA}`);

			fireEvent.click(screen.getByRole("button", { name: "Switch" }));

			const rows = await screen.findAllByTestId("phone-identity");

			expect(rows.map(row => row.dataset["waId"])).toEqual([ANA]);
			expect(screen.getByTestId("phone-demo-limits").textContent).toMatch(/30 minutes/);
		});

		it("never shows a contact outside the session, even when the URL names one", async () => {
			session = "live";
			globalThis.history.replaceState(null, "", `/phone?as=${BRUNO}`);
			renderPhone();

			const rows = await screen.findAllByTestId("phone-identity");

			expect(rows.map(row => row.dataset["waId"])).toEqual([ANA]);
			expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining(BRUNO), expect.anything());
		});

		it("sends the session's CSRF token on every write", async () => {
			session = "live";
			globalThis.history.replaceState(null, "", `/phone?as=${ANA}&chat=${PHONE_NUMBER_ID}`);
			renderPhone();
			await screen.findByText("Is my order ready?");

			fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hi" } });
			fireEvent.click(screen.getByRole("button", { name: "Send" }));

			await waitFor(() => {
				const call = fetchMock.mock.calls.find(
					([path, init]) => path === `${CHAT_PATH}/messages` && init?.method === "POST",
				);

				const headers = new Headers(call?.[1]?.headers);

				expect(headers.get("x-csrf-token")).toBe("csrf-for-this-browser");
			});
		});

		it("explains an expired session and offers a new demo", async () => {
			session = "expired";
			renderPhone();

			const notice = await screen.findByTestId("phone-session-ended");

			expect(notice.textContent).toMatch(/has ended/);
			expect(screen.getByTestId("phone-start-demo").textContent).toBe("Start a new demo");
		});

		it("drops back to the welcome screen when the server ends the session under an open phone", async () => {
			session = "live";
			globalThis.history.replaceState(null, "", `/phone?as=${ANA}`);
			renderPhone();
			await screen.findByText("Acme Support");

			const socket = FakeWebSocket.instances.at(-1)!;

			act(() => {
				socket.serverClose(4401);
			});

			expect(await screen.findByTestId("phone-session-ended")).toBeTruthy();
			expect(globalThis.location.search).toBe("");
		});

		it("leaves the demo on request", async () => {
			session = "live";
			renderPhone();

			fireEvent.click(await screen.findByTestId("phone-leave-demo"));

			await waitFor(() => {
				expect(fetchMock).toHaveBeenCalledWith("/api/public/session", expect.objectContaining({ method: "DELETE" }));
			});
			expect(await screen.findByTestId("phone-start-demo")).toBeTruthy();
			expect(screen.queryByTestId("phone-session-ended")).toBeNull();
		});

		it("uploads an attached image and sends it as this phone", async () => {
			session = "live";
			globalThis.history.replaceState(null, "", `/phone?as=${ANA}&chat=${PHONE_NUMBER_ID}`);
			renderPhone();
			await screen.findByText("Is my order ready?");

			const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "receipt.png", { type: "image/png" });

			fireEvent.change(screen.getByTestId("phone-attach-input"), { target: { files: [file] } });

			await waitFor(() => {
				const call = fetchMock.mock.calls.find(
					([path, init]) => path === `${CHAT_PATH}/messages` && init?.method === "POST",
				);

				expect(JSON.parse((call?.[1]?.body as string | undefined) ?? "null")).toEqual({
					phoneNumberId: PHONE_NUMBER_ID,
					from: ANA,
					type: "image",
					media: { id: "1234567890" },
				});
			});
		});
	});
});
