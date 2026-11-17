import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The mockwa listeners the dev server proxies to (SPEC §8): the console port owns `/api` and
 * serves the UI in production; the Graph API lives on its own port.
 */
const serverUrl =
	process.env["MOCKWA_DEV_SERVER_URL"] ?? process.env["WHALOC_DEV_SERVER_URL"] ?? "http://localhost:8025";
const graphUrl = process.env["MOCKWA_DEV_GRAPH_URL"] ?? "http://localhost:8888";

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
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
