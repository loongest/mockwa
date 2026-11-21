import { inboundRequestSchema, type InboundRequest } from "@wasandbox/shared";
import type {
	AppConfig,
	ExpectMessage,
	ExpectStep,
	ExpectWebhook,
	Scenario,
	ScenarioStep,
	StepAction,
} from "../config/index.ts";
import { DEFAULT_EXPECT_WITHIN_MS, STEP_ACTIONS } from "../config/index.ts";
import type { JsonObject, MessageRecord, Repositories, WebhookDeliveryRecord } from "../db/index.ts";
import type { Logger } from "../logging/index.ts";
import type { AppService } from "./app-service.ts";
import type { BackgroundTasks } from "./background-tasks.ts";
import type { ClockService } from "./clock-service.ts";
import { toWebhookDeliveryDto } from "./control-dto.ts";
import { ControlPlaneError, controlBadRequest, controlConflict, isControlPlaneError } from "./control-plane-error.ts";
import { GraphApiError } from "./graph-api-error.ts";
import type { InboundService } from "./inbound-service.ts";
import type { InjectionService } from "./injection-service.ts";
import type { MessagingRules } from "./messaging-rules.ts";
import { optionLabels, replyOptionsOf, tapRequest, type ReplyOption } from "./reply-options.ts";
import type { ResetService } from "./reset-service.ts";
import {
	findIdentity,
	findNumber,
	planScenario,
	resolveWorld,
	wabaIdOf,
	type ScenarioPlan,
	type ScenarioWorld,
	type WorldNumber,
} from "./scenario-world.ts";
import type { WebhookEmitter } from "./webhook-emitter.ts";

/**
 * Runs a scenario (SPEC §4, "Scenarios"): resets into the scenario's world, then takes its steps
 * one at a time, stopping at the first that fails.
 *
 * Every step goes through the same services as the public APIs — a `send` is a
 * `POST /api/inbound`, a `tap` is the virtual phone's tap, an `advance` is `/api/clock` — so a
 * scenario cannot do anything the app under test could not also see happen another way.
 *
 * **Results are deterministic**: they carry IDs, virtual times and what was observed, never
 * wall-clock durations (those are in {@link ScenarioRun.elapsedMs}, apart), so two runs from
 * the same state compare equal. An `expect` waits for its condition in **real** time — up to
 * `within` — because what it waits for is usually the app under test answering a webhook, and
 * the app runs on its own clock, not WaSandbox's.
 */

export type StepStatus = "passed" | "failed" | "skipped";

export interface StepFailure {
	message: string;
	expected?: unknown;
	observed?: unknown;
}

export interface StepResult {
	/** 1-based, as a person counts steps. */
	index: number;
	name: string;
	action: StepAction;
	status: StepStatus;
	/** Virtual time once the step finished; `null` with the real clock (it would differ every run). */
	at: string | null;
	detail?: JsonObject;
	failure?: StepFailure;
}

export interface ScenarioResult {
	scenario: string;
	passed: boolean;
	clock: { mode: "real" | "virtual"; start: string | null; end: string | null };
	world: {
		wabas: { id: string; name: string }[];
		numbers: { id: string; wabaId: string; displayPhoneNumber: string }[];
		identities: { waId: string; name: string; role: string | null }[];
	};
	steps: StepResult[];
	/** The first failed step, repeated here for whoever reads only the top of the report. */
	failure: (StepFailure & { step: number; name: string; action: StepAction }) | null;
}

export interface ScenarioRun {
	result: ScenarioResult;
	/** Wall-clock milliseconds per step, for reports; not part of the comparable result. */
	elapsedMs: number[];
}

export interface ScenarioRunnerOptions {
	config: AppConfig;
	repositories: Repositories;
	reset: ResetService;
	apps: AppService;
	injection: InjectionService;
	inbound: InboundService;
	messagingRules: MessagingRules;
	clock: ClockService;
	tasks: BackgroundTasks;
	webhooks: WebhookEmitter;
	logger: Logger;
	/** Real-time pause between two checks of an `expect`; injected by tests. */
	pause?: (ms: number) => Promise<void>;
}

const POLL_INTERVAL_MS = 25;
/** What a failure lists of the messages it saw: enough to see the mistake, not the whole log. */
const MAX_OBSERVED = 10;
const MAX_LISTED_DELIVERIES = 10_000;

interface StepOutcome {
	detail?: JsonObject;
	failure?: StepFailure;
}

/** A business message as an `expect` compares it, and as a failure reports it. */
interface ObservedMessage {
	wamid: string;
	from: string;
	type: string;
	text?: string;
	template?: string;
	status: string;
	errorCode?: number;
}

/** One webhook chain as an `expect` compares it. */
interface ObservedWebhook {
	field: string;
	kind: "message" | "status" | null;
	status: string | null;
	about: string | null;
	app: string;
	outcome: string;
	attempts: number;
}

function realPause(ms: number): Promise<void> {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

function actionOf(step: ScenarioStep): StepAction {
	return STEP_ACTIONS.find(action => step[action] !== undefined)!;
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function expectName(expectation: ExpectStep): string {
	if (expectation.message !== undefined) {
		const { to, text, contains, template, status, type } = expectation.message;
		const what =
			text === undefined
				? contains === undefined
					? template === undefined
						? (type ?? "a message")
						: `template ${template}`
					: `a message containing ${quote(contains)}`
				: quote(text);

		return `expect ${what} to ${to}${status === undefined ? "" : ` (${status})`}`;
	}

	if (expectation.webhook !== undefined) {
		const { field, kind, status, count } = expectation.webhook;
		const what = [field, kind, status].filter(part => part !== undefined).join(" ") || "any";

		return `expect ${count === undefined ? "a" : String(count)} ${what} webhook${count === 1 ? "" : "s"}`;
	}

	if (expectation.window !== undefined) {
		return `expect ${expectation.window.as}'s window ${expectation.window.open ? "open" : "closed"}`;
	}

	return "expect clock";
}

const DURATION_UNITS: readonly [string, number][] = [
	["d", 86_400_000],
	["h", 3_600_000],
	["m", 60_000],
	["s", 1000],
];

/** `60000` → `"1m"`: the largest unit that divides it, else milliseconds. */
function formatDuration(ms: number): string {
	const unit = DURATION_UNITS.find(([, size]) => ms > 0 && ms % size === 0);

	return unit === undefined ? `${String(ms)}ms` : `${String(ms / unit[1])}${unit[0]}`;
}

/** What a step is called when its file gives it no name. */
export function defaultStepName(step: ScenarioStep): string {
	if (step.send !== undefined) {
		if (step.send.text !== undefined) {
			return `${step.send.as} sends ${quote(step.send.text)}`;
		}

		const type = step.send.message?.["type"];

		return `${step.send.as} sends ${typeof type === "string" ? type : "a message"}`;
	}

	if (step.tap !== undefined) {
		return `${step.tap.as} taps ${quote(step.tap.option)}`;
	}

	if (step.advance !== undefined) {
		const { advance } = step;

		if (advance === "next") {
			return "advance to the next event";
		}

		if (typeof advance === "number") {
			return `advance ${formatDuration(advance)}`;
		}

		return "to" in advance ? `advance to ${advance.to}` : `advance ${formatDuration(advance.by)}`;
	}

	return expectName(step.expect!);
}

function textOf(message: MessageRecord): string | undefined {
	const node = message.payload[message.type];

	if (typeof node !== "object" || node === null) {
		return undefined;
	}

	const record = node as JsonObject;

	if (message.type === "text") {
		return typeof record["body"] === "string" ? record["body"] : undefined;
	}

	if (message.type === "interactive") {
		const body = record["body"];

		return typeof body === "object" && body !== null && typeof (body as JsonObject)["text"] === "string"
			? ((body as JsonObject)["text"] as string)
			: undefined;
	}

	return undefined;
}

function observe(message: MessageRecord): ObservedMessage {
	const text = textOf(message);
	const template =
		message.type === "template" ? (message.payload["template"] as JsonObject | undefined)?.["name"] : undefined;
	const code = message.error?.["code"];

	return {
		wamid: message.id,
		from: message.phoneNumberId,
		type: message.type,
		...(text !== undefined && { text }),
		...(typeof template === "string" && { template }),
		status: message.status,
		...(typeof code === "number" && { errorCode: code }),
	};
}

function isMatchingMessage(expected: ExpectMessage, observed: ObservedMessage, fromId: string | undefined): boolean {
	return (
		(fromId === undefined || observed.from === fromId) &&
		(expected.type === undefined || observed.type === expected.type) &&
		(expected.text === undefined || observed.text === expected.text) &&
		(expected.contains === undefined || (observed.text?.includes(expected.contains) ?? false)) &&
		(expected.template === undefined || observed.template === expected.template) &&
		(expected.status === undefined || observed.status === expected.status) &&
		(expected.errorCode === undefined || observed.errorCode === expected.errorCode)
	);
}

function parseBody(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

function firstChange(body: string): { field: string; value: JsonObject } | null {
	const envelope = parseBody(body) as { entry?: { changes?: { field?: string; value?: JsonObject }[] }[] } | null;
	const change = envelope?.entry?.[0]?.changes?.[0];

	return change?.field === undefined ? null : { field: change.field, value: change.value ?? {} };
}

function observeChain(first: WebhookDeliveryRecord, latest: WebhookDeliveryRecord, attempts: number): ObservedWebhook {
	const change = firstChange(first.requestBody);
	const messages = change?.value["messages"];
	const statuses = change?.value["statuses"];
	const message = Array.isArray(messages) ? (messages[0] as JsonObject | undefined) : undefined;
	const status = Array.isArray(statuses) ? (statuses[0] as JsonObject | undefined) : undefined;
	let about: unknown = null;

	if (message !== undefined) {
		about = message["from"];
	} else if (status !== undefined) {
		about = status["recipient_id"];
	}

	return {
		field: change?.field ?? first.eventType,
		kind: message === undefined ? (status === undefined ? null : "status") : "message",
		status: typeof status?.["status"] === "string" ? status["status"] : null,
		about: typeof about === "string" ? about : null,
		app: first.appKey ?? "default",
		outcome: toWebhookDeliveryDto(latest).outcome,
		attempts,
	};
}

function describeError(error: unknown): string {
	if (isControlPlaneError(error)) {
		return error.message;
	}

	if (error instanceof GraphApiError) {
		return `${error.message} (code ${String(error.code)})`;
	}

	return Error.isError(error) ? error.message : String(error);
}

export class ScenarioRunner {
	readonly #options: ScenarioRunnerOptions;
	readonly #pause: (ms: number) => Promise<void>;
	#isRunning = false;

	constructor(options: ScenarioRunnerOptions) {
		this.#options = options;
		this.#pause = options.pause ?? realPause;
	}

	async #settle(): Promise<void> {
		const { clock, tasks, webhooks } = this.#options;

		if (clock.isVirtual) {
			// Runs what is due right now (a `sent` rung) and waits for what it started.
			await clock.advance(0);
		} else {
			await tasks.whenIdle();
			await webhooks.whenIdle();
		}
	}

	#now(): string | null {
		return this.#options.clock.isVirtual ? this.#options.clock.now().toISOString() : null;
	}

	async #enterWorld(scenario: Scenario, plan: ScenarioPlan): Promise<ScenarioWorld> {
		const { reset, apps, injection } = this.#options;

		// Whatever the last run left in flight lands before the reset, not after it.
		await this.#settle();

		const { seed } = await reset.reset({
			seed: plan.seed,
			...(scenario.clock !== undefined && { clockStart: new Date(scenario.clock.start) }),
			registerConfiguredApps: scenario.apps === undefined,
		});
		const world = resolveWorld(plan, seed);

		if (scenario.apps != null) {
			for (const app of scenario.apps) {
				const [registered] = await apps.applySeed([
					{
						...(app.id !== undefined && { id: app.id }),
						name: app.name,
						...(app.appSecret !== undefined && { appSecret: app.appSecret }),
						...(app.verifyToken !== undefined && { verifyToken: app.verifyToken }),
						...(app.callbackUrl !== undefined && { callbackUrl: app.callbackUrl }),
						...(app.accessToken !== undefined && { accessToken: app.accessToken }),
						wabas: app.wabas.map(ref => wabaIdOf(world, plan, ref)),
					},
				]);

				for (const override of app.wabaOverrides) {
					await apps.subscribe(registered!, wabaIdOf(world, plan, override.waba), {
						callbackUri: override.callbackUrl,
						verifyToken: override.verifyToken ?? null,
					});
				}

				for (const override of app.phoneOverrides) {
					const number = findNumber(world.numbers, override.number) as WorldNumber;

					await apps.setPhoneOverride(registered!, number.id, {
						callbackUri: override.callbackUrl,
						verifyToken: override.verifyToken ?? null,
					});
				}
			}
		}

		for (const rule of scenario.failureRules) {
			await injection.create(rule);
		}

		return world;
	}

	async #run(scenario: Scenario, plan: ScenarioPlan): Promise<ScenarioRun> {
		const world = await this.#enterWorld(scenario, plan);
		const start = this.#now();
		const claimed = new Set<string>();
		const steps: StepResult[] = [];
		const elapsedMs: number[] = [];
		let failure: ScenarioResult["failure"] = null;

		for (const [position, step] of scenario.steps.entries()) {
			const action = actionOf(step);
			const name = step.name ?? defaultStepName(step);
			const index = position + 1;

			if (failure !== null) {
				steps.push({ index, name, action, status: "skipped", at: null });
				elapsedMs.push(0);
				continue;
			}

			const startedAt = performance.now();
			let outcome: StepOutcome;

			try {
				outcome = await this.#step(step, world, claimed);
			} catch (error) {
				outcome = { failure: { message: describeError(error) } };
			}

			elapsedMs.push(Math.round(performance.now() - startedAt));

			const result: StepResult = {
				index,
				name,
				action,
				status: outcome.failure === undefined ? "passed" : "failed",
				at: this.#now(),
				...(outcome.detail !== undefined && { detail: outcome.detail }),
				...(outcome.failure !== undefined && { failure: outcome.failure }),
			};

			steps.push(result);

			if (outcome.failure !== undefined) {
				failure = { step: index, name, action, ...outcome.failure };
			}
		}

		const result: ScenarioResult = {
			scenario: scenario.name,
			passed: failure === null,
			clock: { mode: this.#options.clock.mode, start, end: this.#now() },
			world: {
				wabas: world.wabas,
				numbers: world.numbers.map(number => {
					return {
						id: number.id,
						wabaId: number.wabaId,
						displayPhoneNumber: number.displayPhoneNumber,
					};
				}),
				identities: world.identities
					.values()
					.map(contact => {
						return {
							waId: contact.waId,
							name: contact.name,
							role: contact.role ?? null,
						};
					})
					.toArray(),
			},
			steps,
			failure,
		};

		this.#options.logger.info(
			{ scenario: scenario.name, passed: result.passed, failedStep: failure?.step ?? null },
			"scenario finished",
		);

		return { result, elapsedMs };
	}

	async #step(step: ScenarioStep, world: ScenarioWorld, claimed: Set<string>): Promise<StepOutcome> {
		if (step.send !== undefined) {
			const { phoneNumberId, from } = this.#conversation(world, step.send.as, step.send.to);
			const body = step.send.text === undefined ? step.send.message : { type: "text", text: { body: step.send.text } };
			const request: InboundRequest = inboundRequestSchema.parse({ ...body, phoneNumberId, from });

			return this.#inbound(request);
		}

		if (step.tap !== undefined) {
			return this.#tap(world, step.tap.as, step.tap.to, step.tap.option);
		}

		if (step.advance !== undefined) {
			return this.#advance(step.advance);
		}

		return this.#expect(step.expect!, world, claimed);
	}

	#conversation(world: ScenarioWorld, as: string, to: string | undefined): { phoneNumberId: string; from: string } {
		const identity = findIdentity(world.identities, as);
		const number = findNumber(world.numbers, to);

		// The plan checked both; a string here would be a bug, reported as one.
		if (typeof identity === "string" || typeof number === "string") {
			throw new TypeError(typeof identity === "string" ? identity : (number as string));
		}

		return { phoneNumberId: number.id, from: identity.waId };
	}

	async #inbound(request: InboundRequest): Promise<StepOutcome> {
		const message = await this.#options.inbound.simulate(request);

		await this.#settle();

		return { detail: { wamid: message.id } };
	}

	async #outbound(world: ScenarioWorld, waId: string, phoneNumberId: string | undefined): Promise<MessageRecord[]> {
		const numbers = phoneNumberId === undefined ? world.numbers.map(number => number.id) : [phoneNumberId];
		const messages: MessageRecord[] = [];

		for (const id of numbers) {
			const conversation = await this.#options.repositories.messages.listConversation({
				phoneNumberId: id,
				contactWaId: waId,
				limit: 1000,
			});

			messages.push(...conversation.filter(message => message.direction === "outbound"));
		}

		return messages.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async #tap(world: ScenarioWorld, as: string, to: string | undefined, option: string): Promise<StepOutcome> {
		const { phoneNumberId, from } = this.#conversation(world, as, to);
		const outbound = await this.#outbound(world, from, phoneNumberId);
		const offers = outbound
			.map(message => ({ message, options: replyOptionsOf(message) }))
			.filter(offer => offer.options.length > 0)
			.toReversed();

		for (const offer of offers) {
			const chosen = offer.options.find(candidate => optionLabels(candidate).includes(option));

			if (chosen !== undefined) {
				const outcome = await this.#inbound(tapRequest(chosen, { phoneNumberId, from, replyTo: offer.message.id }));

				return { detail: { ...outcome.detail, replyTo: offer.message.id, option: describeOption(chosen) } };
			}
		}

		return {
			failure: {
				message:
					offers.length === 0
						? `no message to ${as} offers anything to tap`
						: `no message to ${as} offers ${quote(option)}`,
				expected: { option },
				observed: {
					offered: offers.slice(0, MAX_OBSERVED).map(offer => {
						return {
							wamid: offer.message.id,
							options: offer.options.map(candidate => describeOption(candidate)),
						};
					}),
				},
			},
		};
	}

	async #advance(advance: NonNullable<ScenarioStep["advance"]>): Promise<StepOutcome> {
		const { clock } = this.#options;
		let move;

		if (advance === "next") {
			move = await clock.runNext();
		} else if (typeof advance === "number") {
			move = await clock.advance(advance);
		} else if ("to" in advance) {
			move = await clock.set(new Date(advance.to));
		} else {
			move = await clock.advance(advance.by);
		}

		return { detail: { from: move.from, to: move.to, fired: move.fired.map(event => event.label) } };
	}

	async #expect(expectation: ExpectStep, world: ScenarioWorld, claimed: Set<string>): Promise<StepOutcome> {
		const within = expectation.within ?? DEFAULT_EXPECT_WITHIN_MS;
		const deadline = performance.now() + within;

		for (;;) {
			await this.#settle();

			const outcome = await this.#check(expectation, world, claimed);

			if (outcome.failure === undefined || performance.now() >= deadline) {
				if (outcome.failure !== undefined && within > 0) {
					outcome.failure.message += ` (waited ${String(within)}ms)`;
				}

				return outcome;
			}

			await this.#pause(POLL_INTERVAL_MS);
		}
	}

	async #check(expectation: ExpectStep, world: ScenarioWorld, claimed: Set<string>): Promise<StepOutcome> {
		if (expectation.message !== undefined) {
			return this.#checkMessage(expectation.message, world, claimed);
		}

		if (expectation.webhook !== undefined) {
			return this.#checkWebhook(expectation.webhook, world);
		}

		if (expectation.window !== undefined) {
			const { phoneNumberId, from } = this.#conversation(world, expectation.window.as, expectation.window.to);
			const state = await this.#options.messagingRules.serviceWindow(phoneNumberId, from);
			const observed = {
				open: state.isOpen,
				lastInboundAt: state.lastInboundAt?.toISOString() ?? null,
				expiresAt: state.expiresAt?.toISOString() ?? null,
			};

			return state.isOpen === expectation.window.open
				? { detail: observed }
				: {
						failure: {
							message: `the window is ${state.isOpen ? "open" : "closed"}`,
							expected: { open: expectation.window.open },
							observed,
						},
					};
		}

		const view = this.#options.clock.view();
		const observed = { now: view.now, pending: view.pending?.length ?? 0 };
		const expected = expectation.clock!;
		const isNow = expected.now === undefined || Date.parse(expected.now) === Date.parse(view.now);
		const isPending = expected.pending === undefined || expected.pending === observed.pending;

		return isNow && isPending
			? { detail: observed }
			: { failure: { message: "the clock does not match", expected, observed } };
	}

	async #checkMessage(expected: ExpectMessage, world: ScenarioWorld, claimed: Set<string>): Promise<StepOutcome> {
		const identity = findIdentity(world.identities, expected.to);
		const number = expected.from === undefined ? undefined : findNumber(world.numbers, expected.from);

		if (typeof identity === "string" || typeof number === "string") {
			throw new TypeError("unresolved reference");
		}

		const outbound = await this.#outbound(world, identity.waId, number?.id);
		const messages = outbound.map(message => observe(message));
		const match = messages.find(
			message => !claimed.has(message.wamid) && isMatchingMessage(expected, message, number?.id),
		);

		if (match !== undefined) {
			claimed.add(match.wamid);

			return { detail: { ...match } };
		}

		return {
			failure: {
				message:
					messages.length === 0
						? `no message was sent to ${expected.to}`
						: `none of the ${String(messages.length)} message(s) sent to ${expected.to} matches`,
				expected,
				observed: messages.slice(-MAX_OBSERVED).map(message => {
					return {
						...message,
						...(claimed.has(message.wamid) && { matchedEarlier: true }),
					};
				}),
			},
		};
	}

	async #checkWebhook(expected: ExpectWebhook, world: ScenarioWorld): Promise<StepOutcome> {
		const listed = await this.#options.repositories.webhookDeliveries.list({ limit: MAX_LISTED_DELIVERIES });
		const rows = listed.toReversed();
		const chains = new Map<string, WebhookDeliveryRecord[]>();

		for (const row of rows) {
			chains.set(row.chainId, [...(chains.get(row.chainId) ?? []), row]);
		}

		const about =
			expected.about === undefined
				? undefined
				: (findIdentity(world.identities, expected.about) as { waId: string }).waId;
		const app = expected.app === undefined ? undefined : await this.#appKey(expected.app);
		const observed = chains
			.values()
			.map(chain => observeChain(chain[0]!, chain.at(-1)!, chain.length))
			.toArray();
		const matching = observed.filter(webhook => {
			return (
				(expected.field === undefined || webhook.field === expected.field) &&
				(expected.kind === undefined || webhook.kind === expected.kind) &&
				(expected.status === undefined || webhook.status === expected.status) &&
				(about === undefined || webhook.about === about) &&
				(app === undefined || webhook.app === app) &&
				(expected.outcome === undefined || webhook.outcome === expected.outcome)
			);
		});
		const isMet = expected.count === undefined ? matching.length > 0 : matching.length === expected.count;

		if (isMet) {
			return { detail: { count: matching.length } };
		}

		return {
			failure: {
				message: `${String(matching.length)} matching webhook(s), expected ${expected.count === undefined ? "at least 1" : String(expected.count)}`,
				expected,
				observed: { matching: matching.length, webhooks: observed.slice(-MAX_OBSERVED) },
			},
		};
	}

	async #appKey(ref: string): Promise<string> {
		const app = await this.#options.apps.find(ref);

		if (app !== null) {
			return app.key;
		}

		const apps = await this.#options.apps.list();
		const byName = apps.find(candidate => candidate.name.toLowerCase() === ref.toLowerCase());

		return byName?.key ?? ref;
	}

	get isRunning(): boolean {
		return this.#isRunning;
	}

	/**
	 * Checks everything that can be checked without touching state: the clock the scenario
	 * needs, and every reference against its world. Throws a 400 (or a 409 for the clock).
	 */
	plan(scenario: Scenario): ScenarioPlan {
		const isNeedsVirtualClock =
			scenario.clock !== undefined ||
			scenario.steps.some(step => step.advance !== undefined || step.expect?.clock !== undefined);

		if (isNeedsVirtualClock && !this.#options.clock.isVirtual) {
			throw new ControlPlaneError(
				"this scenario sets or reads the clock (clock.start, an advance step or an expect clock); " +
					"start WaSandbox with WASANDBOX_CLOCK=virtual to run it",
				{ status: 409, code: "clock_not_virtual" },
			);
		}

		const planned = planScenario(scenario, this.#options.config.seed);

		if ("problems" in planned) {
			throw controlBadRequest(
				`scenario "${scenario.name}" is invalid:\n${planned.problems.map(problem => `  - ${problem}`).join("\n")}`,
				"invalid_scenario",
			);
		}

		return planned.plan;
	}

	async run(scenario: Scenario): Promise<ScenarioRun> {
		if (this.#isRunning) {
			throw controlConflict(
				"a scenario is already running on this instance; wait for it to finish",
				"scenario_running",
			);
		}

		const plan = this.plan(scenario);

		this.#isRunning = true;

		try {
			return await this.#run(scenario, plan);
		} finally {
			this.#isRunning = false;
		}
	}
}

function describeOption(option: ReplyOption): JsonObject {
	return option.kind === "quick_reply"
		? { kind: option.kind, text: option.text, payload: option.payload }
		: { kind: option.kind, id: option.id, title: option.title };
}
