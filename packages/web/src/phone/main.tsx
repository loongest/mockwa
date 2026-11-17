import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "../store/store.tsx";
import { PhoneApp } from "./phone-app.tsx";
import "../styles/index.css";
import "../styles/phone.css";

const container = document.querySelector("#root");

if (!container) {
	throw new Error("phone.html is missing its #root element");
}

// The console's store is mounted offline: the phone only borrows its toasts and the message
// renderers that read it, and keeps its own socket scoped to one identity.
createRoot(container).render(
	<StrictMode>
		<StoreProvider isLive={false}>
			<PhoneApp />
		</StoreProvider>
	</StrictMode>,
);
