import type { WabaState, WebhookApp, WebhookRouting } from "@mockwa/shared";
import clsx from "clsx";
import { useState, type SyntheticEvent } from "react";
import { api } from "../../api/endpoints.ts";
import { useAction, useDispatch, useToasts } from "../../store/store.tsx";
import { useWebhookRouting } from "../../store/use-webhook-routing.ts";

/**
 * Apps and where their webhooks go (SPEC §3, "Apps and routing").
 *
 * The default app is the one the environment describes (`MOCKWA_WEBHOOK_URL`, …) and is shown
 * read-only. Registered apps each have their own callback URL, App Secret and Verify Token; a
 * WABA reaches every app subscribed to it, and an override sends the overridable fields of one
 * WABA or one number somewhere else, the way Meta's `override_callback_uri` does.
 *
 * Secrets are write-only: the server reports whether one is set, never its value.
 */

function SecretFlags(props: { app: WebhookApp }) {
	const { app } = props;
	const flags: [string, boolean][] = [
		["secret", app.hasAppSecret],
		["verify token", app.hasVerifyToken],
		["access token", app.hasAccessToken],
	];

	return (
		<div className="row row--wrap">
			{flags.map(([label, isSet]) => (
				<span key={label} className={clsx("badge", isSet ? "badge--ok" : "")}>
					{isSet ? label : `no ${label}`}
				</span>
			))}
		</div>
	);
}

function isSubscribed(routing: WebhookRouting, app: WebhookApp, wabaId: string): boolean {
	return routing.subscriptions.some(
		subscription => subscription.appKey === app.key && subscription.wabaId === wabaId && !subscription.isImplicit,
	);
}

function AppRow(props: { app: WebhookApp; routing: WebhookRouting; wabas: WabaState[] }) {
	const { app, routing, wabas } = props;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();

	const toggleSubscription = (wabaId: string, isSubscribing: boolean): void => {
		run(async () => {
			const next = isSubscribing ? await api.subscribeApp(app.key, wabaId) : await api.unsubscribeApp(app.key, wabaId);

			dispatch({ type: "webhook-routing/loaded", routing: next });
		});
	};

	return (
		<tr>
			<td>
				<div className="stack stack--tight">
					<strong>{app.name}</strong>
					<span className="faint mono">{app.id}</span>
				</div>
			</td>
			<td className="mono delivery__url">
				{app.callbackUrl ?? <span className="faint">none — logged as skipped</span>}
			</td>
			<td>
				<SecretFlags app={app} />
			</td>
			<td>
				<div className="stack stack--tight">
					{wabas.map(waba => (
						<label key={waba.id} className="row">
							<input
								type="checkbox"
								checked={isSubscribed(routing, app, waba.id)}
								aria-label={`${app.name} subscribed to ${waba.name}`}
								onChange={changed => {
									toggleSubscription(waba.id, changed.target.checked);
								}}
							/>
							<span>{waba.name}</span>
						</label>
					))}
				</div>
			</td>
			<td>
				<div className="row">
					<button
						type="button"
						className="button button--ghost"
						aria-label={`Handshake ${app.name}`}
						disabled={app.callbackUrl === null}
						onClick={() => {
							run(async () => {
								const result = await api.runAppHandshake(app.key);

								if (result.ok) {
									toasts.info(`${app.name}: the receiver echoed the challenge`);
								} else {
									toasts.info(`${app.name}: handshake failed — ${result.error ?? `HTTP ${String(result.status)}`}`);
								}
							});
						}}
					>
						Handshake
					</button>
					{!app.isDefault && (
						<button
							type="button"
							className="button button--danger"
							aria-label={`Delete ${app.name}`}
							onClick={() => {
								run(async () => {
									await api.deleteApp(app.key);
									dispatch({ type: "webhook-routing/loaded", routing: await api.getWebhookRouting() });
								});
							}}
						>
							Delete
						</button>
					)}
				</div>
			</td>
		</tr>
	);
}

function CreateAppForm() {
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [fields, setFields] = useState({ name: "", callbackUrl: "", appSecret: "", verifyToken: "", accessToken: "" });

	const set = (key: keyof typeof fields) => (changed: { target: { value: string } }) => {
		setFields(previous => ({ ...previous, [key]: changed.target.value }));
	};

	const submit = (event: SyntheticEvent): void => {
		event.preventDefault();

		if (fields.name.trim() === "") {
			toasts.info("An app needs a name");

			return;
		}

		const optional = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
		const callbackUrl = optional(fields.callbackUrl);
		const appSecret = optional(fields.appSecret);
		const verifyToken = optional(fields.verifyToken);
		const accessToken = optional(fields.accessToken);

		run(async () => {
			await api.createApp({
				name: fields.name.trim(),
				...(callbackUrl !== undefined && { callbackUrl }),
				...(appSecret !== undefined && { appSecret }),
				...(verifyToken !== undefined && { verifyToken }),
				...(accessToken !== undefined && { accessToken }),
			});
			dispatch({ type: "webhook-routing/loaded", routing: await api.getWebhookRouting() });
			setFields({ name: "", callbackUrl: "", appSecret: "", verifyToken: "", accessToken: "" });
		});
	};

	return (
		<form className="row row--wrap" onSubmit={submit} aria-label="New app">
			<input
				className="input settings__input"
				placeholder="name"
				aria-label="New app name"
				value={fields.name}
				onChange={set("name")}
			/>
			<input
				className="input settings__input"
				placeholder="callback URL"
				aria-label="New app callback URL"
				value={fields.callbackUrl}
				onChange={set("callbackUrl")}
			/>
			<input
				className="input settings__input"
				placeholder="App Secret"
				aria-label="New app secret"
				value={fields.appSecret}
				onChange={set("appSecret")}
			/>
			<input
				className="input settings__input"
				placeholder="Verify Token"
				aria-label="New app verify token"
				value={fields.verifyToken}
				onChange={set("verifyToken")}
			/>
			<input
				className="input settings__input"
				placeholder="access token (optional)"
				aria-label="New app access token"
				value={fields.accessToken}
				onChange={set("accessToken")}
			/>
			<button type="submit" className="button">
				Add app
			</button>
		</form>
	);
}

/** One target an override can sit on: a WABA, or one of its numbers. */
interface OverrideTarget {
	kind: "waba" | "phone";
	id: string;
	label: string;
}

function overrideTargets(wabas: WabaState[]): OverrideTarget[] {
	return wabas.flatMap(waba => [
		{ kind: "waba" as const, id: waba.id, label: `WABA ${waba.name}` },
		...waba.phoneNumbers.map(phone => ({
			kind: "phone" as const,
			id: phone.id,
			label: `number ${phone.displayPhoneNumber}`,
		})),
	]);
}

function OverridesPanel(props: { routing: WebhookRouting; wabas: WabaState[] }) {
	const { routing, wabas } = props;
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const targets = overrideTargets(wabas);
	const [appKey, setAppKey] = useState(routing.apps[0]?.key ?? "");
	const [targetIndex, setTargetIndex] = useState(0);
	const [url, setUrl] = useState("");
	const [verifyToken, setVerifyToken] = useState("");
	const appName = (key: string): string => routing.apps.find(app => app.key === key)?.name ?? key;
	const wabaName = (id: string): string => wabas.find(waba => waba.id === id)?.name ?? id;
	const phoneLabel = (id: string): string =>
		wabas.flatMap(waba => waba.phoneNumbers).find(phone => phone.id === id)?.displayPhoneNumber ?? id;

	const wabaOverrides = routing.subscriptions.filter(subscription => subscription.overrideCallbackUri !== null);

	const submit = (event: SyntheticEvent): void => {
		event.preventDefault();

		const target = targets[targetIndex];

		if (target === undefined || url.trim() === "" || verifyToken.trim() === "") {
			toasts.info("An override needs a target, a URL and a verify token, as on Meta");

			return;
		}

		run(async () => {
			const next =
				target.kind === "waba"
					? await api.subscribeApp(appKey, target.id, {
							overrideCallbackUri: url.trim(),
							verifyToken: verifyToken.trim(),
						})
					: await api.setPhoneOverride(appKey, target.id, {
							callbackUri: url.trim(),
							verifyToken: verifyToken.trim(),
						});

			dispatch({ type: "webhook-routing/loaded", routing: next });
			setUrl("");
			setVerifyToken("");
		});
	};

	return (
		<div className="stack">
			<h3 className="card__title">Overrides</h3>
			<p className="faint">
				A number&apos;s override wins over its WABA&apos;s, which wins over the app&apos;s URL. Only Meta&apos;s
				overridable fields follow them (<code>messages</code>, calls, echoes…); template and account webhooks always go
				to the app&apos;s own URL.
			</p>

			{wabaOverrides.length === 0 && routing.phoneOverrides.length === 0 ? (
				<p className="empty">No overrides.</p>
			) : (
				<table className="table">
					<thead>
						<tr>
							<th>App</th>
							<th>On</th>
							<th>URL</th>
							<th aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{wabaOverrides.map(subscription => (
							<tr key={`waba-${subscription.appKey}-${subscription.wabaId}`}>
								<td>{appName(subscription.appKey)}</td>
								<td>WABA {wabaName(subscription.wabaId)}</td>
								<td className="mono delivery__url">{subscription.overrideCallbackUri}</td>
								<td>
									<button
										type="button"
										className="button button--ghost"
										aria-label={`Remove WABA override of ${appName(subscription.appKey)}`}
										onClick={() => {
											run(async () => {
												// Re-subscribing without an override clears it, as on Meta.
												const next = await api.subscribeApp(subscription.appKey, subscription.wabaId);

												dispatch({ type: "webhook-routing/loaded", routing: next });
											});
										}}
									>
										Remove
									</button>
								</td>
							</tr>
						))}
						{routing.phoneOverrides.map(override => (
							<tr key={`phone-${override.appKey}-${override.phoneNumberId}`}>
								<td>{appName(override.appKey)}</td>
								<td>number {phoneLabel(override.phoneNumberId)}</td>
								<td className="mono delivery__url">{override.callbackUri}</td>
								<td>
									<button
										type="button"
										className="button button--ghost"
										aria-label={`Remove number override of ${appName(override.appKey)}`}
										onClick={() => {
											run(async () => {
												const next = await api.removePhoneOverride(override.appKey, override.phoneNumberId);

												dispatch({ type: "webhook-routing/loaded", routing: next });
											});
										}}
									>
										Remove
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}

			<form className="row row--wrap" onSubmit={submit} aria-label="New override">
				<select
					className="input"
					aria-label="Override app"
					value={appKey}
					onChange={changed => {
						setAppKey(changed.target.value);
					}}
				>
					{routing.apps.map(app => (
						<option key={app.key} value={app.key}>
							{app.name}
						</option>
					))}
				</select>
				<select
					className="input"
					aria-label="Override target"
					value={targetIndex}
					onChange={changed => {
						setTargetIndex(Number(changed.target.value));
					}}
				>
					{targets.map((target, index) => (
						<option key={`${target.kind}-${target.id}`} value={index}>
							{target.label}
						</option>
					))}
				</select>
				<input
					className="input settings__input"
					placeholder="override URL"
					aria-label="Override URL"
					value={url}
					onChange={changed => {
						setUrl(changed.target.value);
					}}
				/>
				<input
					className="input settings__input"
					placeholder="verify token"
					aria-label="Override verify token"
					value={verifyToken}
					onChange={changed => {
						setVerifyToken(changed.target.value);
					}}
				/>
				<button type="submit" className="button">
					Set override
				</button>
			</form>
		</div>
	);
}

export function AppsCard(props: { wabas: WabaState[] }) {
	const webhookRouting = useWebhookRouting();

	if (webhookRouting === null) {
		return <p className="empty">loading…</p>;
	}

	return (
		<div className="card stack">
			<p className="muted">
				Every app subscribed to a WABA gets its own copy of that WABA&apos;s webhooks, signed with its own App Secret.
				The default app (from <code>MOCKWA_WEBHOOK_URL</code>) also receives them while no registered app is subscribed,
				so a setup with one URL keeps working unchanged.
			</p>
			<ol className="faint stack routing-steps" data-testid="routing-explainer">
				<li>
					<strong>Which apps get a webhook:</strong> every app subscribed to the WABA the event is about — or the
					default app when none is.
				</li>
				<li>
					<strong>Where each one goes:</strong> the phone number&apos;s override if it has one, else the WABA&apos;s
					override, else the app&apos;s callback URL.
				</li>
				<li>
					<strong>Who a Graph call is:</strong> the app whose access token it carries (the default app otherwise). That
					decides whose subscription <code>subscribed_apps</code> changes, and the app shown in Requests.
				</li>
			</ol>

			<div className="table-scroll">
				<table className="table">
					<thead>
						<tr>
							<th>App</th>
							<th>Callback URL</th>
							<th>Credentials</th>
							<th>Subscribed WABAs</th>
							<th aria-label="Actions" />
						</tr>
					</thead>
					<tbody>
						{webhookRouting.apps.map(app => (
							<AppRow key={app.key} app={app} routing={webhookRouting} wabas={props.wabas} />
						))}
					</tbody>
				</table>
			</div>

			<CreateAppForm />

			<hr className="divider" />

			<OverridesPanel routing={webhookRouting} wabas={props.wabas} />

			<p className="faint">
				A non-<code>200</code> answer is retried for up to 7 days (<code>MOCKWA_WEBHOOK_RETRY_SCHEDULE</code>,{" "}
				<code>MOCKWA_WEBHOOK_RETRY_MAX_AGE</code>); pending retries are stored and survive a restart.
			</p>
		</div>
	);
}
