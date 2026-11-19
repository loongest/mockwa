import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf, textOf } from "./testing/expectations.ts";
import { createTestApp, type TestApp } from "./testing/test-app.ts";
import { ADMIN_HEADERS, PUBLIC_ENV } from "./testing/visitor-client.ts";
import { isReservedPath, PHONE_CONTENT_SECURITY_POLICY } from "./web-ui.ts";

const INDEX_HTML = '<!doctype html><title>whaloc</title><div id="root"></div>';
const PHONE_HTML = '<!doctype html><title>mockwa phone</title><div id="root"></div>';
const ASSET_JS = "console.log('whaloc');\n";

describe("the static web UI", () => {
	let fixture: TestApp;
	let webDir: string;

	beforeEach(async () => {
		webDir = await mkdtemp(path.join(tmpdir(), "whaloc-test-web-"));
		await mkdir(path.join(webDir, "assets"));
		await writeFile(path.join(webDir, "index.html"), INDEX_HTML);
		await writeFile(path.join(webDir, "phone.html"), PHONE_HTML);
		await writeFile(path.join(webDir, "assets", "index-abc123.js"), ASSET_JS);
		fixture = await createTestApp({ MOCKWA_WEB_DIR: webDir });
	});

	afterEach(async () => {
		await fixture.close();
		await rm(webDir, { recursive: true, force: true });
	});

	it("serves index.html at the root", async () => {
		const response = await fixture.app.request("/");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toBe(INDEX_HTML);
	});

	it("serves fingerprinted assets as immutable", async () => {
		const response = await fixture.app.request("/assets/index-abc123.js");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(ASSET_JS);
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
	});

	it("never caches the entry document, so a redeploy is picked up", async () => {
		const response = await fixture.app.request("/");

		expect(response.headers.get("cache-control")).toBe("no-cache");
	});

	// The scoped routes the shell uses (SPEC §8) plus the unscoped entry points that redirect
	// into them: every one of these has to survive a reload and a bookmark.
	it.each([
		"/chats",
		"/templates",
		"/w/666635535888644/p/573542517421694/chats",
		"/w/666635535888644/p/573542517421694/chats/5511912345678",
		"/w/666635535888644/chats",
		"/w/666635535888644/templates",
		"/chats/573542517421694:5511912345678",
		"/webhooks",
		"/settings",
	])("falls back to index.html on the in-app route %s", async route => {
		const response = await fixture.app.request(route);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(INDEX_HTML);
	});

	// The virtual phone is its own page; its state is in the query string (SPEC §5).
	it.each(["/phone", "/phone?as=5571990000001", "/phone?as=5571990000001&chat=1", "/phone/anything"])(
		"serves phone.html, not the console, at %s",
		async route => {
			const response = await fixture.app.request(route);

			expect(response.status).toBe(200);
			expect(response.headers.get("cache-control")).toBe("no-cache");
			expect(await response.text()).toBe(PHONE_HTML);
		},
	);

	it.each(["/api/nope", "/api/conversations/x/nope", "/v25.0/nope", "/whaloc-media/nope"])(
		"does not shadow %s with the SPA fallback",
		async reserved => {
			const response = await fixture.app.request(reserved);

			expect(response.status).not.toBe(200);
			expect(await response.text()).not.toBe(INDEX_HTML);
		},
	);

	it("keeps serving the API next to the UI", async () => {
		const response = await fixture.app.request("/api/state");

		expect(response.status).toBe(200);
	});

	it("keeps the health check answering at the root alias", async () => {
		const response = await fixture.app.request("/health");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("application/json");
	});
});

describe("isReservedPath", () => {
	it.each([
		"/api",
		"/api/state",
		"/api/ws",
		"/v25.0",
		"/v25.0/123/messages",
		"/v1.0/x",
		"/whaloc-media/tok",
		"/health",
	])("reserves %s", pathname => {
		expect(isReservedPath(pathname)).toBe(true);
	});

	it.each(["/", "/chats", "/apidocs", "/healthz", "/whaloc-mediax", "/v25", "/assets/index.js"])(
		"leaves %s to the UI",
		pathname => {
			expect(isReservedPath(pathname)).toBe(false);
		},
	);
});

describe("the static web UI in public mode (SPEC §7)", () => {
	let fixture: TestApp;
	let webDir: string;
	const PHONE_JS = "console.log('phone');\n";
	const SHARED_JS = "console.log('shared');\n";
	const CONSOLE_JS = "console.log('console');\n";

	beforeEach(async () => {
		webDir = await mkdtemp(path.join(tmpdir(), "mockwa-test-public-web-"));
		await mkdir(path.join(webDir, "assets"));
		await mkdir(path.join(webDir, ".vite"));
		await writeFile(path.join(webDir, "index.html"), INDEX_HTML);
		await writeFile(path.join(webDir, "phone.html"), PHONE_HTML);
		await writeFile(path.join(webDir, "favicon.svg"), "<svg/>");
		await writeFile(path.join(webDir, "assets", "phone-1.js"), PHONE_JS);
		await writeFile(path.join(webDir, "assets", "shared-1.js"), SHARED_JS);
		await writeFile(path.join(webDir, "assets", "phone-1.css"), "body{}");
		await writeFile(path.join(webDir, "assets", "console-1.js"), CONSOLE_JS);
		await writeFile(
			path.join(webDir, ".vite", "manifest.json"),
			JSON.stringify({
				"phone.html": { file: "assets/phone-1.js", imports: ["_shared"], css: ["assets/phone-1.css"], isEntry: true },
				_shared: { file: "assets/shared-1.js" },
				"index.html": { file: "assets/console-1.js", imports: ["_shared"], isEntry: true },
			}),
		);
		fixture = await createTestApp({ ...PUBLIC_ENV, MOCKWA_WEB_DIR: webDir });
	});

	afterEach(async () => {
		await fixture.close();
		await rm(webDir, { recursive: true, force: true });
	});

	it("serves the phone page with a strict Content-Security-Policy", async () => {
		const response = await fixture.consoleApp.request("/phone");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(PHONE_HTML);
		expect(response.headers.get("content-security-policy")).toBe(PHONE_CONTENT_SECURITY_POLICY);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("serves a visitor the phone bundle and the shared files, nothing of the console's", async () => {
		for (const asset of ["/assets/phone-1.js", "/assets/shared-1.js", "/assets/phone-1.css", "/favicon.svg"]) {
			expect({ asset, status: await statusOf(fixture.consoleApp.request(asset)) }).toEqual({ asset, status: 200 });
		}

		for (const hidden of ["/assets/console-1.js", "/index.html", "/phone.html", "/.vite/manifest.json"]) {
			expect({ hidden, status: await statusOf(fixture.consoleApp.request(hidden)) }).toEqual({ hidden, status: 404 });
		}
	});

	it.each(["/", "/chats", "/settings", "/webhooks", "/clock", "/scenarios", "/requests", "/templates"])(
		"answers 404 for the console page %s without the admin's sign-in",
		async page => {
			const response = await fixture.consoleApp.request(page);

			expect(response.status).toBe(404);
			expect(await response.text()).not.toContain("whaloc");
		},
	);

	it("serves the console to the admin", async () => {
		expect(await textOf(fixture.consoleApp.request("/", { headers: ADMIN_HEADERS }))).toBe(INDEX_HTML);
		expect(await statusOf(fixture.consoleApp.request("/assets/console-1.js", { headers: ADMIN_HEADERS }))).toBe(200);
	});
});
