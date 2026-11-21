import { describe, expect, it } from "vitest";
import { appConfigSchema } from "../config/index.ts";
import { createMediaStorage } from "./create-media-storage.ts";
import { LocalDirStorage } from "./local-dir-storage.ts";
import { S3MediaStorage } from "./s3-storage.ts";

const S3_ENV = {
	WASANDBOX_MEDIA_BACKEND: "s3",
	WASANDBOX_S3_BUCKET: "whaloc-media",
	WASANDBOX_S3_REGION: "us-east-1",
} as const;

/**
 * The one place `WASANDBOX_MEDIA_BACKEND` is read (SPEC §6). Building an S3 storage talks to
 * nothing — the client is lazy — so this runs without RustFS; the behavior behind the interface
 * is `s3-storage.spec.ts`'s job.
 */
describe("createMediaStorage", () => {
	it("builds the local directory backend by default", () => {
		const config = appConfigSchema.parse({ WASANDBOX_MEDIA_DIR: "./data/media" });

		expect(config.mediaBackend).toBe("local");
		expect(createMediaStorage({ config })).toBeInstanceOf(LocalDirStorage);
	});

	it("builds the S3 backend when the environment asks for one", async () => {
		const config = appConfigSchema.parse(S3_ENV);
		const storage = createMediaStorage({ config });

		expect(storage).toBeInstanceOf(S3MediaStorage);

		await storage.close?.();
	});
});
