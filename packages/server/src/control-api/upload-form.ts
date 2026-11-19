import type { Context } from "hono";
import { ControlPlaneError } from "../domain/index.ts";
import type { ControlEnv } from "./control-env.ts";

/** What an upload is recorded as when neither the `type` part nor the file itself says. */
export const FALLBACK_MIME_TYPE = "application/octet-stream";

export interface UploadForm {
	bytes: Uint8Array;
	mimeType: string;
	/** Every other part, for the routes that read more than the file (`phoneNumberId`). */
	form: FormData;
}

/**
 * A browser `FormData` upload (SPEC §5): the `file` part, and its MIME type from the `type` part
 * when one is sent, else from the file, else {@link FALLBACK_MIME_TYPE}.
 */
export async function readUploadForm(c: Context<ControlEnv>): Promise<UploadForm> {
	let form: FormData;

	try {
		form = await c.req.formData();
	} catch (error) {
		throw new ControlPlaneError("expected a multipart/form-data body", {
			status: 400,
			code: "invalid_upload",
			cause: error,
		});
	}

	const file = form.get("file");

	if (!(file instanceof File)) {
		throw new ControlPlaneError("the file part is required", { status: 400, code: "invalid_upload" });
	}

	const declaredType = form.get("type");
	const mimeType =
		(typeof declaredType === "string" ? declaredType.trim() : "") || file.type.trim() || FALLBACK_MIME_TYPE;

	return { bytes: new Uint8Array(await file.arrayBuffer()), mimeType, form };
}
