import { visitorSessionResponseSchema, type Contact, type VisitorSession } from "@wasandbox/shared";
import type { Hono } from "hono";
import type { AppEnv } from "../app-env.ts";
import type { Scheduler } from "../domain/index.ts";

/**
 * Public demo mode in the specs (SPEC §5, §7): the environment a public instance needs, and a
 * visitor that drives the console app through `app.request()` the way a browser would — its
 * session cookie, its CSRF token, and this listener's own origin on every request.
 */

/** The admin token the public-mode specs configure. */
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789";

/** The Graph token the public-mode specs register; public mode requires a registry. */
export const TEST_GRAPH_TOKEN = "test-token";

/** What `app.request("/…")` resolves against, and so the listener's own origin. */
export const TEST_ORIGIN = "http://localhost";

export const PUBLIC_ENV: Readonly<Record<string, string>> = {
	WASANDBOX_MODE: "public",
	WASANDBOX_ADMIN_TOKEN: TEST_ADMIN_TOKEN,
	WASANDBOX_TOKENS: TEST_GRAPH_TOKEN,
};

export const ADMIN_HEADERS = { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } as const;

/** The Node binding `clientIpOf` reads the peer address from. */
export function fromAddress(address: string): { incoming: { socket: { remoteAddress: string } } } {
	return { incoming: { socket: { remoteAddress: address } } };
}

/**
 * A scheduler whose `now` the spec moves, with real timers underneath: the visitor TTL, the
 * rate windows and the session timestamps all follow the moved clock, while the status ladder
 * and the cleanup job still run on timers.
 */
export interface MovableScheduler extends Scheduler {
	advance: (ms: number) => void;
}

export function createMovableScheduler(): MovableScheduler {
	let offset = 0;

	return {
		now: () => new Date(Date.now() + offset),
		advance: ms => {
			offset += ms;
		},
		schedule: (delayMs, task) => {
			const timer = setTimeout(task, delayMs);

			timer.unref();

			return {
				cancel: () => {
					clearTimeout(timer);
				},
			};
		},
		sleep: async delayMs => {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, delayMs);

				timer.unref();
			});
		},
	};
}

function cookieOf(response: Response, name: string): string | undefined {
	for (const header of response.headers.getSetCookie()) {
		const [pair] = header.split(";", 1);
		const [key, value] = (pair ?? "").split("=", 2);

		if (key?.trim() === name) {
			return value ?? "";
		}
	}

	return undefined;
}

export interface VisitorRequestInit {
	method?: string;
	body?: unknown;
	form?: FormData;
	headers?: Record<string, string>;
	/** Leave out the CSRF header (to test the check). */
	withoutCsrf?: boolean;
	/** Send another origin (or none, with `null`). */
	origin?: string | null;
}

/** One browser: a cookie jar holding the visitor cookie, and the CSRF token from the last session read. */
export class TestVisitor {
	readonly #app: Hono<AppEnv>;
	readonly #address: string;
	cookie: string | undefined;
	session: VisitorSession | undefined;

	constructor(app: Hono<AppEnv>, address = "198.51.100.10") {
		this.#app = app;
		this.#address = address;
	}

	get identities(): Contact[] {
		return this.session?.identities ?? [];
	}

	/** The visitor's first identity (the template's first role). */
	get waId(): string {
		const identity = this.identities[0];

		if (identity === undefined) {
			throw new Error("the visitor has no session yet");
		}

		return identity.waId;
	}

	async request(path: string, init: VisitorRequestInit = {}): Promise<Response> {
		const method = init.method ?? (init.body === undefined && init.form === undefined ? "GET" : "POST");
		const headers: Record<string, string> = { ...init.headers };

		if (this.cookie !== undefined) {
			headers["cookie"] = `wasandbox_visitor=${this.cookie}`;
		}

		if (init.origin !== null) {
			headers["origin"] = init.origin ?? TEST_ORIGIN;
		}

		if (method !== "GET" && init.withoutCsrf !== true && this.session !== undefined) {
			headers["x-csrf-token"] = this.session.csrfToken;
		}

		let body: RequestInit["body"];

		if (init.form !== undefined) {
			body = init.form;
		} else if (init.body !== undefined) {
			headers["content-type"] = "application/json";
			body = JSON.stringify(init.body);
		}

		const response = await this.#app.request(
			path,
			{ method, headers, ...(body !== undefined && { body }) },
			fromAddress(this.#address),
		);
		const cookie = cookieOf(response, "wasandbox_visitor");

		if (cookie !== undefined) {
			this.cookie = cookie === "" ? undefined : cookie;
		}

		return response;
	}

	/** `POST /api/public/session`; throws unless a session came back. */
	async start(): Promise<VisitorSession> {
		const response = await this.request("/api/public/session", { method: "POST" });

		if (response.status !== 201 && response.status !== 200) {
			throw new Error(`could not start a visitor session: ${String(response.status)} ${await response.text()}`);
		}

		this.session = visitorSessionResponseSchema.parse(await response.json()).data;

		return this.session;
	}

	chatPath(phoneNumberId: string, waId = this.waId): string {
		return `/api/phone/identities/${waId}/chats/${phoneNumberId}`;
	}

	async sendText(phoneNumberId: string, text: string, waId = this.waId): Promise<Response> {
		return this.request(`${this.chatPath(phoneNumberId, waId)}/messages`, {
			body: { type: "text", text: { body: text } },
		});
	}
}
