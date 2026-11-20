import { describe, expect, it } from "vitest";
import { isOpenableUrl, isWebUrl } from "./safe-url.ts";

describe("links from the app under test", () => {
	it.each(["https://example.com/a", "http://localhost:3000/x", "tel:+5511999999999", "mailto:a@example.com"])(
		"opens %s",
		url => {
			expect(isOpenableUrl(url)).toBe(true);
		},
	);

	it.each([
		"javascript:alert(1)",
		"JaVaScRiPt:alert(1)",
		" javascript:alert(1)",
		"data:text/html,<script>alert(1)</script>",
		"vbscript:msgbox",
		"file:///etc/passwd",
		"not a url",
		"",
	])("keeps %s as text", url => {
		expect(isOpenableUrl(url)).toBe(false);
		expect(isWebUrl(url)).toBe(false);
	});

	it("keeps tel: and mailto: out of web links", () => {
		expect(isWebUrl("tel:+1")).toBe(false);
		expect(isWebUrl("https://example.com")).toBe(true);
	});
});
