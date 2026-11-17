import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "../create-database.ts";
import { JsonColumnError } from "../json-column.ts";
import { runMigrations } from "../migrator.ts";
import { WebhookDeliveryRepository, type InsertWebhookDeliveryInput } from "./webhook-delivery-repository.ts";

const HEADERS = {
	"content-type": "application/json",
	"user-agent": "facebookexternalua",
	"x-hub-signature-256": "sha256=0f1e2d",
};

describe("WebhookDeliveryRepository", () => {
	let handle: DatabaseHandle;
	let repository: WebhookDeliveryRepository;

	beforeEach(async () => {
		handle = createDatabase({ dbPath: ":memory:" });
		await runMigrations({ db: handle.db });
		repository = new WebhookDeliveryRepository(handle.db);
	});

	afterEach(async () => {
		await handle.close();
	});

	function insertDefault(overrides: Partial<InsertWebhookDeliveryInput> = {}) {
		return repository.insert({
			id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
			eventType: "messages",
			url: "http://meta-webhook-receiver:3001/meta-webhooks",
			requestBody: '{"object":"whatsapp_business_account"}',
			requestHeaders: HEADERS,
			responseStatus: 200,
			durationMs: 12,
			...overrides,
		});
	}

	it("stores one attempt with its headers and response", async () => {
		const inserted = await insertDefault({ createdAt: "2026-01-01T00:00:00.000Z" });

		expect(inserted).toEqual({
			id: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
			eventType: "messages",
			url: "http://meta-webhook-receiver:3001/meta-webhooks",
			requestBody: '{"object":"whatsapp_business_account"}',
			requestHeaders: HEADERS,
			responseStatus: 200,
			responseBody: null,
			error: null,
			attempt: 1,
			durationMs: 12,
			createdAt: "2026-01-01T00:00:00.000Z",
			appKey: null,
			// A first attempt starts its own chain, and nothing is owed until a retry is scheduled.
			chainId: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
			nextAttemptAt: null,
		});
	});

	it("stores a failed attempt without a response", async () => {
		const failed = await insertDefault({
			id: "1",
			responseStatus: null,
			error: "connect ECONNREFUSED",
			attempt: 3,
			durationMs: null,
		});

		expect(failed).toMatchObject({ responseStatus: null, error: "connect ECONNREFUSED", attempt: 3, durationMs: null });
	});

	it("round-trips the request headers through the JSON column", async () => {
		await insertDefault();

		const found = await repository.findById("0f1e2d3c4b5a69788796a5b4c3d2e1f0");

		expect(found?.requestHeaders).toEqual(HEADERS);
	});

	it("rejects headers that are not a string map", async () => {
		await insertDefault();
		await handle.db.updateTable("webhook_deliveries").set({ request_headers: '{"retries":3}' }).execute();

		await expect(repository.findById("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).rejects.toThrow(JsonColumnError);
	});

	it("lists deliveries newest first and pages with a before cursor", async () => {
		for (const index of [1, 2, 3]) {
			await insertDefault({ id: String(index), createdAt: `2026-01-0${String(index)}T00:00:00.000Z` });
		}

		const all = await repository.list();
		const firstPage = await repository.list({ limit: 2 });
		const older = await repository.list({ before: "2026-01-02T00:00:00.000Z" });

		expect(all.map(delivery => delivery.id)).toEqual(["3", "2", "1"]);
		expect(firstPage.map(delivery => delivery.id)).toEqual(["3", "2"]);
		expect(older.map(delivery => delivery.id)).toEqual(["1"]);
	});

	describe("the retry queue (SPEC §3)", () => {
		async function pending(id: string, nextAttemptAt: string, extra: Partial<InsertWebhookDeliveryInput> = {}) {
			return insertDefault({ id, responseStatus: 500, nextAttemptAt, ...extra });
		}

		it("reports the earliest due retry, or null when nothing is owed", async () => {
			expect(await repository.nextDueAt()).toBeNull();

			await pending("a", "2026-01-01T00:05:00.000Z");
			await pending("b", "2026-01-01T00:01:00.000Z");
			await insertDefault({ id: "c" });

			expect(await repository.nextDueAt()).toBe("2026-01-01T00:01:00.000Z");
		});

		it("lists only the retries due by now, the most overdue first", async () => {
			await pending("late", "2026-01-01T00:05:00.000Z");
			await pending("due", "2026-01-01T00:01:00.000Z");
			await pending("future", "2026-01-02T00:00:00.000Z");

			const due = await repository.listDue("2026-01-01T00:10:00.000Z");

			expect(due.map(row => row.id)).toEqual(["due", "late"]);
		});

		it("claims a pending retry once, so it can never be sent twice", async () => {
			await pending("a", "2026-01-01T00:01:00.000Z");

			expect(await repository.claim("a")).toBe(true);
			expect(await repository.claim("a")).toBe(false);
			const claimed = await repository.findById("a");

			expect(claimed?.nextAttemptAt).toBeNull();
		});

		it("lists a chain in attempt order and cancels what it still owes", async () => {
			await insertDefault({ id: "first", responseStatus: 500, appKey: "123" });
			await pending("second", "2026-01-01T00:01:00.000Z", { chainId: "first", attempt: 2, appKey: "123" });
			await pending("other", "2026-01-01T00:01:00.000Z", { appKey: "456" });

			const chain = await repository.listChain("first");

			expect(chain.map(row => row.id)).toEqual(["first", "second"]);
			expect(await repository.cancelPending({ chainId: "first" })).toBe(1);
			expect(await repository.cancelPending({ appKey: "456" })).toBe(1);
			expect(await repository.nextDueAt()).toBeNull();
		});
	});
});
