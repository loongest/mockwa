import { inboundRequestSchema } from "@wasandbox/shared";
import type { Scenario, Seed, SeedContact } from "../config/index.ts";
import { describeScenarioIssues } from "../config/scenario.ts";
import type { SeedResult } from "./apply-seed.ts";
import { DEFAULT_APP_KEY } from "./app-service.ts";
import { phoneNumberDigits } from "./phone-number-format.ts";

/**
 * A scenario's world before it exists (SPEC §4, "Scenarios"): the seed it will be reset into,
 * and every reference its apps and steps make, checked against that seed. A scenario that
 * names somebody who is not in it is refused here — before the reset, so a typo never costs
 * the state that was there.
 */

export interface PlannedNumber {
	/** Index of its WABA in the seed. */
	waba: number;
	/** Index within the WABA. */
	index: number;
	id: string | undefined;
	displayPhoneNumber: string;
	verifiedName: string | undefined;
}

export interface ScenarioPlan {
	seed: Seed;
	/** Every contact of the seed, identities included, by `waId`. */
	identities: Map<string, SeedContact>;
	numbers: PlannedNumber[];
}

/** A business number as it exists once the seed is applied. */
export interface WorldNumber {
	id: string;
	wabaId: string;
	displayPhoneNumber: string;
	verifiedName: string;
}

/** The resolved world: what a reference turns into while the steps run. */
export interface ScenarioWorld {
	numbers: WorldNumber[];
	wabas: { id: string; name: string }[];
	identities: Map<string, SeedContact>;
}

function isSameText(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** `waId` first, then a unique name. */
export function findIdentity(identities: Map<string, SeedContact>, ref: string): SeedContact | string {
	const byWaId = identities.get(ref);

	if (byWaId !== undefined) {
		return byWaId;
	}

	const named = identities
		.values()
		.filter(contact => isSameText(contact.name, ref))
		.toArray();

	if (named.length === 1) {
		return named[0]!;
	}

	const known = identities
		.values()
		.map(contact => `${contact.name} (${contact.waId})`)
		.toArray();

	return named.length > 1
		? `identity "${ref}" is ambiguous: ${String(named.length)} identities have that name; use the waId`
		: `no identity "${ref}" (known: ${known.join(", ")})`;
}

function isNumberMatch(
	number: { id?: string | undefined; displayPhoneNumber: string; verifiedName?: string | undefined },
	ref: string,
): boolean {
	const digits = phoneNumberDigits(ref);

	return (
		number.id === ref ||
		(digits !== "" && phoneNumberDigits(number.displayPhoneNumber) === digits) ||
		(number.verifiedName !== undefined && isSameText(number.verifiedName, ref))
	);
}

/** A number by ID, display number or verified name; with one number in the world, `undefined` means it. */
export function findNumber<
	T extends { id?: string | undefined; displayPhoneNumber: string; verifiedName?: string | undefined },
>(numbers: readonly T[], ref: string | undefined): T | string {
	if (ref === undefined) {
		return numbers.length === 1
			? numbers[0]!
			: `name the business number ("to"/"from"): this world has ${String(numbers.length)}`;
	}

	const matches = numbers.filter(number => isNumberMatch(number, ref));

	if (matches.length === 1) {
		return matches[0]!;
	}

	return matches.length > 1
		? `business number "${ref}" is ambiguous; use its ID`
		: `no business number "${ref}" (known: ${numbers.map(number => number.displayPhoneNumber).join(", ")})`;
}

function isWabaMatch(waba: { id?: string | undefined; name?: string | undefined }, ref: string): boolean {
	return waba.id === ref || (waba.name !== undefined && isSameText(waba.name, ref));
}

interface Problems {
	add: (path: string, message: string) => void;
	list: string[];
}

function problems(): Problems {
	const list: string[] = [];

	return {
		list,
		add: (path, message) => {
			list.push(`${path}: ${message}`);
		},
	};
}

function checkConversation(
	plan: ScenarioPlan,
	path: string,
	value: { as: string; to?: string | undefined },
	found: Problems,
): void {
	const identity = findIdentity(plan.identities, value.as);

	if (typeof identity === "string") {
		found.add(`${path}.as`, identity);
	}

	const number = findNumber(plan.numbers, value.to);

	if (typeof number === "string") {
		found.add(`${path}.to`, number);
	}
}

function checkApps(scenario: Scenario, plan: ScenarioPlan, found: Problems): void {
	const wabas = plan.seed.map(waba => ({ id: waba.id, name: waba.name }));

	const apps = scenario.apps ?? [];

	for (const [appIndex, app] of apps.entries()) {
		const path = `apps[${String(appIndex)}]`;

		for (const [index, ref] of app.wabas.entries()) {
			if (wabas.every(waba => !isWabaMatch(waba, ref))) {
				found.add(
					`${path}.wabas[${String(index)}]`,
					`no WABA "${ref}" in this scenario (give the WABA an id or a name)`,
				);
			}
		}

		for (const [index, override] of app.wabaOverrides.entries()) {
			if (wabas.every(waba => !isWabaMatch(waba, override.waba))) {
				found.add(`${path}.wabaOverrides[${String(index)}].waba`, `no WABA "${override.waba}" in this scenario`);
			}
		}

		for (const [index, override] of app.phoneOverrides.entries()) {
			const number = findNumber(plan.numbers, override.number);

			if (typeof number === "string") {
				found.add(`${path}.phoneOverrides[${String(index)}].number`, number);
			}
		}
	}
}

function appRefs(scenario: Scenario): string[] {
	const apps = scenario.apps ?? [];

	return [DEFAULT_APP_KEY, ...apps.flatMap(app => [app.name, ...(app.id === undefined ? [] : [app.id])])];
}

function checkSteps(scenario: Scenario, plan: ScenarioPlan, found: Problems): void {
	const knownApps = appRefs(scenario);

	for (const [index, step] of scenario.steps.entries()) {
		const path = `steps[${String(index)}]`;

		if (step.send !== undefined) {
			checkConversation(plan, `${path}.send`, step.send, found);

			if (step.send.message !== undefined) {
				const parsed = inboundRequestSchema.safeParse({ ...step.send.message, phoneNumberId: "1", from: "1" });

				if (!parsed.success) {
					for (const issue of describeScenarioIssues(parsed.error)) {
						found.add(`${path}.send.message`, issue);
					}
				}
			}
		}

		if (step.tap !== undefined) {
			checkConversation(plan, `${path}.tap`, step.tap, found);
		}

		const expectation = step.expect;

		if (expectation?.message !== undefined) {
			checkConversation(
				plan,
				`${path}.expect.message`,
				{ as: expectation.message.to, to: expectation.message.from },
				found,
			);
		}

		if (expectation?.window !== undefined) {
			checkConversation(plan, `${path}.expect.window`, expectation.window, found);
		}

		if (expectation?.webhook?.about !== undefined) {
			const identity = findIdentity(plan.identities, expectation.webhook.about);

			if (typeof identity === "string") {
				found.add(`${path}.expect.webhook.about`, identity);
			}
		}

		const app = expectation?.webhook?.app;

		if (app !== undefined && knownApps.every(known => !isSameText(known, app))) {
			found.add(`${path}.expect.webhook.app`, `no app "${app}" (known: ${knownApps.join(", ")})`);
		}
	}
}

/**
 * The seed a scenario runs in — its own `wabas`, or `WASANDBOX_SEED` — with its identities added
 * to the first WABA, and every reference checked. Returns the problems instead when there are
 * any, all of them at once.
 */
export function planScenario(
	scenario: Scenario,
	configuredSeed: Seed,
): { plan: ScenarioPlan } | { problems: string[] } {
	const seed: Seed = structuredClone(scenario.wabas ?? configuredSeed);
	const first = seed[0]!;

	for (const identity of scenario.identities) {
		const contact: SeedContact = {
			waId: identity.waId,
			name: identity.name,
			...(identity.role !== undefined && { role: identity.role }),
			...(identity.userId !== undefined && { userId: identity.userId }),
			...(identity.displayNumber !== undefined && { displayNumber: identity.displayNumber }),
		};
		const existing = first.contacts.findIndex(candidate => candidate.waId === identity.waId);

		if (existing === -1) {
			first.contacts.push(contact);
		} else {
			first.contacts[existing] = contact;
		}
	}

	const identities = new Map<string, SeedContact>();

	for (const waba of seed) {
		for (const contact of waba.contacts) {
			identities.set(contact.waId, contact);
		}
	}

	const numbers = seed.flatMap((waba, wabaIndex) => {
		return waba.phoneNumbers.map((number, index) => {
			return {
				waba: wabaIndex,
				index,
				id: number.id,
				displayPhoneNumber: number.displayPhoneNumber,
				verifiedName: number.verifiedName ?? waba.name,
			};
		});
	});
	const plan: ScenarioPlan = { seed, identities, numbers };
	const found = problems();

	checkApps(scenario, plan, found);
	checkSteps(scenario, plan, found);

	return found.list.length > 0 ? { problems: found.list } : { plan };
}

/** The plan, with the IDs the seed resolved to. */
export function resolveWorld(plan: ScenarioPlan, applied: SeedResult): ScenarioWorld {
	return {
		numbers: applied.wabas.flatMap(waba => {
			return waba.phoneNumbers.map(number => {
				return {
					id: number.id,
					wabaId: waba.id,
					displayPhoneNumber: number.displayPhoneNumber,
					verifiedName: number.verifiedName,
				};
			});
		}),
		wabas: applied.wabas.map(waba => ({ id: waba.id, name: waba.name })),
		identities: plan.identities,
	};
}

/** A WABA reference, once the world exists. Checked by {@link planScenario}, so it resolves. */
export function wabaIdOf(world: ScenarioWorld, plan: ScenarioPlan, ref: string): string {
	const index = plan.seed.findIndex(waba => isWabaMatch(waba, ref));

	return world.wabas[index]!.id;
}
