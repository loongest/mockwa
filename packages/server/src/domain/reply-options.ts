import type { InboundRequest } from "@mockwa/shared";
import type { JsonObject, MessageRecord } from "../db/index.ts";

/**
 * The replies a business message offers a tap on (SPEC §4, "Scenarios"; the virtual phone does
 * the same from the browser): an interactive message's reply buttons and list rows, and a
 * template's quick replies. Whatever is tapped goes back **verbatim** — the app under test
 * matches the reply against the IDs and payloads it sent.
 */
export type ReplyOption =
	| { kind: "button_reply"; id: string; title: string }
	| { kind: "list_reply"; id: string; title: string; description?: string }
	| { kind: "quick_reply"; payload: string; text: string };

function asRecord(value: unknown): JsonObject | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function records(value: unknown): JsonObject[] {
	return Array.isArray(value)
		? value.flatMap(item => {
				const record = asRecord(item);

				return record === null ? [] : [record];
			})
		: [];
}

function text(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

function interactiveOptions(payload: JsonObject): ReplyOption[] {
	const interactive = asRecord(payload["interactive"]);
	const action = asRecord(interactive?.["action"]);

	if (interactive === null || action === null) {
		return [];
	}

	if (interactive["type"] === "button") {
		return records(action["buttons"]).flatMap(button => {
			const reply = asRecord(button["reply"]);
			const id = text(reply?.["id"]);
			const title = text(reply?.["title"]);

			return id === null || title === null ? [] : [{ kind: "button_reply" as const, id, title }];
		});
	}

	if (interactive["type"] === "list") {
		return records(action["sections"]).flatMap(section => {
			return records(section["rows"]).flatMap(row => {
				const id = text(row["id"]);
				const title = text(row["title"]);
				const description = text(row["description"]);

				return id === null || title === null
					? []
					: [{ kind: "list_reply" as const, id, title, ...(description !== null && { description }) }];
			});
		});
	}

	return [];
}

/** The `payload` the send gave quick reply `index`; Meta falls back to the button's text. */
function quickReplyPayload(sendComponents: JsonObject[], index: number, fallback: string): string {
	const component = sendComponents.find(candidate => {
		const subtype = typeof candidate["sub_type"] === "string" ? candidate["sub_type"].toLowerCase() : undefined;

		return (
			String(candidate["type"]).toLowerCase() === "button" &&
			Number(candidate["index"]) === index &&
			(subtype === undefined || subtype === "quick_reply")
		);
	});
	const parameter = records(component?.["parameters"]).find(
		candidate => String(candidate["type"]).toLowerCase() === "payload",
	);

	return text(parameter?.["payload"]) ?? fallback;
}

function templateOptions(message: MessageRecord): ReplyOption[] {
	const definition = message.templateSnapshot?.components ?? [];
	const buttons = records(
		definition.find(component => String(component["type"]).toUpperCase() === "BUTTONS")?.["buttons"],
	);
	const sendComponents = records(asRecord(message.payload["template"])?.["components"]);

	return buttons.flatMap((button, index) => {
		const label = text(button["text"]);

		return label !== null && String(button["type"]).toUpperCase() === "QUICK_REPLY"
			? [{ kind: "quick_reply" as const, text: label, payload: quickReplyPayload(sendComponents, index, label) }]
			: [];
	});
}

export function replyOptionsOf(message: MessageRecord): ReplyOption[] {
	if (message.direction !== "outbound") {
		return [];
	}

	return message.type === "template" ? templateOptions(message) : interactiveOptions(message.payload);
}

/** An option's visible label and its machine value — what a scenario's `option` may name. */
export function optionLabels(option: ReplyOption): string[] {
	return option.kind === "quick_reply" ? [option.text, option.payload] : [option.title, option.id];
}

/** The inbound message a tap on `option` sends, quoting the message that offered it. */
export function tapRequest(
	option: ReplyOption,
	context: { phoneNumberId: string; from: string; replyTo: string },
): InboundRequest {
	const base = { phoneNumberId: context.phoneNumberId, from: context.from, replyTo: context.replyTo };

	switch (option.kind) {
		case "button_reply": {
			return {
				...base,
				type: "interactive",
				interactive: { type: "button_reply", button_reply: { id: option.id, title: option.title } },
			};
		}
		case "list_reply": {
			return {
				...base,
				type: "interactive",
				interactive: {
					type: "list_reply",
					list_reply: {
						id: option.id,
						title: option.title,
						...(option.description !== undefined && { description: option.description }),
					},
				},
			};
		}
		case "quick_reply": {
			return { ...base, type: "button", button: { payload: option.payload, text: option.text } };
		}
	}
}
