import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/**
 * The mockwa listeners the dev server proxies to (SPEC §8): the console port owns `/api` and
 * serves the UI in production; the Graph API lives on its own port.
 */
const serverUrl =
	process.env["MOCKWA_DEV_SERVER_URL"] ?? process.env["WHALOC_DEV_SERVER_URL"] ?? "http://localhost:8025";
const graphUrl = process.env["MOCKWA_DEV_GRAPH_URL"] ?? "http://localhost:8888";

/**
 * The virtual phone is its own page (SPEC §5). In production the server answers `/phone` with
 * `phone.html`; this does the same for the dev server, whose own fallback only knows `index.html`.
 */
function phonePage(): Plugin {
	return {
		name: "mockwa-phone-page",
		configureServer(server) {
			server.middlewares.use((request, _response, next) => {
				const url = request.url ?? "";

				if (/^\/phone(?:[/?]|$)/.test(url)) {
					request.url = `/phone.html${url.slice(url.search(/[?]|$/))}`;
				}

				next();
			});
		},
	};
}

export default defineConfig({
	plugins: [react(), phonePage()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		// Public demo mode serves a visitor only the phone's files (SPEC §7); the server reads
		// which ones they are from this manifest.
		manifest: true,
		rollupOptions: {
			input: {
				console: fileURLToPath(new URL("index.html", import.meta.url)),
				phone: fileURLToPath(new URL("phone.html", import.meta.url)),
			},
		},
	},
	server: {
		port: 5173,
		proxy: {
			// Control plane, WebSocket, media bytes and the versioned Graph API mount (SPEC §8).
			"/api": { target: serverUrl, changeOrigin: true, ws: true },
			"/whaloc-media": { target: serverUrl, changeOrigin: true },
			[String.raw`^/v\d+\.\d+/`]: { target: graphUrl, changeOrigin: true },
		},
	},
});
