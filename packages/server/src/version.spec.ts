import { describe, expect, it } from "vitest";
import { whalocVersion } from "./version.ts";

describe("whalocVersion", () => {
	it("is the version the image was built with", () => {
		expect(whalocVersion({ WHALOC_VERSION: "0.1.0" })).toBe("0.1.0");
	});

	it("reads WASANDBOX_VERSION first, then the MOCKWA_VERSION and WHALOC_VERSION aliases", () => {
		expect(whalocVersion({ WASANDBOX_VERSION: "0.2.0", WHALOC_VERSION: "0.1.0" })).toBe("0.2.0");
		expect(whalocVersion({ WASANDBOX_VERSION: " ", WHALOC_VERSION: "0.1.0" })).toBe("0.1.0");
		expect(whalocVersion({ MOCKWA_VERSION: "0.1.5", WHALOC_VERSION: "0.1.0" })).toBe("0.1.5");
	});

	it.each([{}, { WHALOC_VERSION: "" }, { WHALOC_VERSION: "  " }])("is 0.0.0-dev when run from source (%o)", env => {
		expect(whalocVersion(env)).toBe("0.0.0-dev");
	});
});
