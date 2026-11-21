import type { WebhookRouting } from "@wasandbox/shared";
import { useEffect } from "react";
import { api } from "../api/endpoints.ts";
import { useAppState, useDispatch, useToasts } from "./store.tsx";

/**
 * Apps, subscriptions and overrides (SPEC §3), fetched once by whichever view needs them first.
 * After that `webhook_routing.changed` keeps them current, and a reset or import empties them,
 * which loads them again here.
 */
export function useWebhookRouting(): WebhookRouting | null {
	const { webhookRouting } = useAppState();
	const dispatch = useDispatch();
	const toasts = useToasts();
	const hasRouting = webhookRouting !== null;

	useEffect(() => {
		if (hasRouting) {
			return;
		}

		const controller = new AbortController();
		const load = async (): Promise<void> => {
			try {
				dispatch({
					type: "webhook-routing/loaded",
					routing: await api.getWebhookRouting({ signal: controller.signal }),
				});
			} catch (error) {
				if (!controller.signal.aborted) {
					toasts.error(error);
				}
			}
		};

		void load();

		return () => {
			controller.abort();
		};
	}, [dispatch, toasts, hasRouting]);

	return webhookRouting;
}
