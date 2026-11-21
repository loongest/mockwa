import {
	GRAPH_REQUEST_BODY_LIMIT,
	GRAPH_REQUEST_LOG_LIMIT,
	type GraphRequest,
	type GraphRequestSummary,
	type LoggedBody,
} from "@wasandbox/shared";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { api, GRAPH_REQUESTS_EXPORT_PATH } from "../../api/endpoints.ts";
import { JsonBlock } from "../../components/json-block.tsx";
import { formatBytes, formatTimestamp } from "../../lib/format.ts";
import { prettyJsonText } from "../../lib/json.ts";
import { useAction, useAppState, useDispatch, useToasts } from "../../store/store.tsx";
import { useWebhookRouting } from "../../store/use-webhook-routing.ts";

/**
 * The Graph request log (SPEC §5, "Graph request log"): what the app under test sent to the Graph
 * port and what it was answered — rejected requests included, with Meta's error code. New
 * requests arrive live; a row opens to the masked headers and bodies.
 */

const PAGE_SIZE = 50;

function statusTone(status: number): string {
	if (status >= 500) {
		return "badge--danger";
	}

	return status >= 400 ? "badge--warn" : "badge--ok";
}

function BodyView(props: { title: string; body: LoggedBody }) {
	const { body } = props;
	const size = body.size === null ? "size not declared" : formatBytes(body.size);

	return (
		<div className="stack request-body" data-testid="request-body" data-kind={body.kind}>
			<span className="section-label">
				{props.title} · {body.kind}
				{body.contentType === null ? "" : ` · ${body.contentType}`} · {size}
				{body.truncated ? ` · cut at ${String(GRAPH_REQUEST_BODY_LIMIT / 1024)} KiB` : ""}
			</span>
			{body.kind === "json" && body.text !== undefined && (
				<JsonBlock text={body.truncated ? body.text : prettyJsonText(body.text)} />
			)}
			{(body.kind === "text" || body.kind === "form") && body.text !== undefined && <JsonBlock text={body.text} />}
			{body.kind === "multipart" && (
				<table className="table">
					<tbody>
						{body.fields?.map((field, index) => (
							<tr key={`${field.name}-${String(index)}`}>
								<td className="mono">{field.name}</td>
								<td className="mono">
									{field.file === undefined
										? field.value
										: `file ${field.file.filename ?? "(no name)"} · ${field.file.contentType ?? "?"} · ${formatBytes(field.file.size)} (not stored)`}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{body.kind === "binary" && <p className="faint">Binary content: described, not stored.</p>}
			{body.kind === "omitted" && (
				<p className="faint" data-testid="request-body-omitted">
					Not stored: {body.omittedReason ?? "it could not be masked"}.
				</p>
			)}
			{body.kind === "empty" && <p className="faint">No body.</p>}
		</div>
	);
}

function RequestDetail(props: { id: number }) {
	const [detail, setDetail] = useState<GraphRequest | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				setDetail(await api.getGraphRequest(props.id, { signal: controller.signal }));
			} catch (error_) {
				if (!controller.signal.aborted) {
					setError(String(error_));
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [props.id]);

	if (error !== null) {
		return <p className="field__error">{error}</p>;
	}

	if (detail === null) {
		return <p className="faint">loading…</p>;
	}

	return (
		<div className="stack" data-testid="request-detail">
			<span className="section-label">Request headers (credentials masked)</span>
			<JsonBlock value={detail.requestHeaders} />
			{detail.query !== "" && (
				<>
					<span className="section-label">Query</span>
					<JsonBlock text={detail.query} />
				</>
			)}
			<BodyView title="Request body" body={detail.requestBody} />
			<BodyView title="Response body" body={detail.responseBody} />
		</div>
	);
}

function RequestRow(props: { request: GraphRequestSummary; appName: string | null }) {
	const { request } = props;
	const [isOpen, setIsOpen] = useState(false);

	return (
		<>
			<tr
				className={clsx("delivery", isOpen && "is-selected")}
				data-testid="graph-request"
				data-status={request.status}
				data-path={request.path}
				onClick={() => {
					setIsOpen(open => !open);
				}}
			>
				<td>
					<button type="button" className="button button--ghost button--sm" aria-expanded={isOpen} aria-label="Details">
						{isOpen ? "▾" : "▸"}
					</button>
				</td>
				<td className="mono">{formatTimestamp(request.receivedAt)}</td>
				<td className="mono">{request.method}</td>
				<td className="mono request-path">
					{request.path}
					{request.query === "" ? "" : `?${request.query}`}
				</td>
				<td>
					<span className={clsx("badge", statusTone(request.status))}>{request.status}</span>
					{request.errorCode !== null && <span className="badge badge--danger">code {request.errorCode}</span>}
				</td>
				<td className="mono">{request.phoneNumberId ?? "—"}</td>
				<td>
					{props.appName ?? request.appKey ?? "—"}
					{request.tokenMasked !== null && <span className="faint mono"> {request.tokenMasked}</span>}
				</td>
				<td className="mono">{request.durationMs} ms</td>
			</tr>
			{isOpen && (
				<tr className="delivery__details">
					<td colSpan={8}>
						<RequestDetail id={request.id} />
					</td>
				</tr>
			)}
		</>
	);
}

export function RequestsPage() {
	const { graphRequests, graphRequestsBefore } = useAppState();
	// Only for the app names in the log.
	const webhookRouting = useWebhookRouting();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const run = useAction();
	const [loadingMore, setLoadingMore] = useState(false);
	const [isConfirmingClear, setIsConfirmingClear] = useState(false);

	useEffect(() => {
		const controller = new AbortController();

		void (async () => {
			try {
				const page = await api.listGraphRequests({ limit: PAGE_SIZE }, { signal: controller.signal });

				dispatch({ type: "graph-requests/loaded", requests: page.data, before: page.paging.before, mode: "latest" });
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		})();

		return () => {
			controller.abort();
		};
	}, [dispatch, toasts]);

	const appNames = new Map((webhookRouting?.apps ?? []).map(app => [app.key, app.name]));

	const loadMore = (): void => {
		if (graphRequestsBefore === null) {
			return;
		}

		setLoadingMore(true);

		void (async () => {
			try {
				const page = await api.listGraphRequests({ limit: PAGE_SIZE, before: graphRequestsBefore });

				dispatch({ type: "graph-requests/loaded", requests: page.data, before: page.paging.before, mode: "older" });
			} catch (error) {
				toasts.error(error);
			} finally {
				setLoadingMore(false);
			}
		})();
	};

	return (
		<div className="page">
			<header className="page__header page__header--wrap">
				<div className="page__title">
					<h1>Requests</h1>
					<span className="faint">{graphRequests === null ? "loading…" : `${String(graphRequests.length)} shown`}</span>
				</div>
				<div className="row">
					<a className="button button--sm" href={GRAPH_REQUESTS_EXPORT_PATH} download>
						Download JSON
					</a>
					{isConfirmingClear ? (
						<>
							<button
								type="button"
								className="button button--sm button--danger"
								onClick={() => {
									setIsConfirmingClear(false);
									run(async () => {
										await api.clearGraphRequests();
										dispatch({ type: "graph-requests/loaded", requests: [], before: null, mode: "latest" });
									});
								}}
							>
								Clear the log
							</button>
							<button
								type="button"
								className="button button--sm"
								onClick={() => {
									setIsConfirmingClear(false);
								}}
							>
								Keep it
							</button>
						</>
					) : (
						<button
							type="button"
							className="button button--sm"
							onClick={() => {
								setIsConfirmingClear(true);
							}}
						>
							Clear…
						</button>
					)}
				</div>
			</header>

			<p className="faint page__note">
				Every request the app under test made to the Graph port (8888), newest first. Tokens and secrets are masked,
				bodies are cut at {GRAPH_REQUEST_BODY_LIMIT / 1024} KiB, binary content is described but never stored, and only
				the newest {GRAPH_REQUEST_LOG_LIMIT} are kept. A reset empties the log; it is not part of a state export.
			</p>

			<div className="page__body page__body--flush">
				{graphRequests?.length === 0 && (
					<p className="empty">No Graph requests yet. Point the app under test at this WaSandbox's Graph port.</p>
				)}

				{graphRequests !== null && graphRequests.length > 0 && (
					<table className="table table--log">
						<thead>
							<tr>
								<th aria-label="Expand" />
								<th>Time</th>
								<th>Method</th>
								<th>Path</th>
								<th>Status</th>
								<th>Number</th>
								<th>App · token</th>
								<th>Duration</th>
							</tr>
						</thead>
						<tbody>
							{graphRequests.map(request => (
								<RequestRow
									key={request.id}
									request={request}
									appName={request.appKey === null ? null : (appNames.get(request.appKey) ?? null)}
								/>
							))}
						</tbody>
					</table>
				)}

				{graphRequestsBefore !== null && (
					<div className="messages__more">
						<button type="button" className="button button--sm" disabled={loadingMore} onClick={loadMore}>
							{loadingMore ? "loading…" : "Load older requests"}
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
