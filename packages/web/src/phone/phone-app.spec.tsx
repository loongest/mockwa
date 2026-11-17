import type { Contact, Message, PhoneChat, WsEvent } from "@mockwa/shared";
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

	beforeEach(() => {
		FakeWebSocket.instances.length = 0;
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
			if (path === "/api/phone/identities") {
				return jsonResponse({ data: IDENTITIES });
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
});
