/**
 * Links the app under test put in a message (a `cta_url`, a template's URL button, media sent by
 * `link`) are its data, not this page's: only schemes that open something are made clickable.
 * `javascript:`, `data:` and the like stay text, whatever the Content-Security-Policy would do.
 */
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "tel:", "mailto:"]);

export function isOpenableUrl(url: string): boolean {
	const protocol = URL.parse(url)?.protocol;

	return protocol !== undefined && LINK_PROTOCOLS.has(protocol);
}

/** Only `http:` and `https:`: what a web button or a linked file may open. */
export function isWebUrl(url: string): boolean {
	const protocol = URL.parse(url)?.protocol;

	return protocol === "http:" || protocol === "https:";
}
