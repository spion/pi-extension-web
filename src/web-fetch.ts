/**
 * Web Fetch Tool
 *
 * Fetches a web document and converts it to markdown.
 * If the document is too large, returns headings for selective fetching.
 * Includes an LRU cache to avoid re-fetching and re-converting the same URL.
 *
 * Usage:
 * 1. Ensure markitdown is available: pip install markitdown
 * 2. Copy this file to ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";

// ---------------------------------------------------------------------------
// LRU Cache — in-memory, TTL-based, bounded by maxSize
// ---------------------------------------------------------------------------

class LRUCache<K, V> {
	private cache = new Map<K, { value: V; expiry: number }>();

	constructor(private maxSize = 50, private defaultTTL = 3_600_000) {}

	get(key: K): V | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiry) {
			this.cache.delete(key);
			return undefined;
		}
		// Promote to most-recently-used (delete + re-insert)
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry.value;
	}

	set(key: K, value: V): void {
		if (this.cache.size >= this.maxSize) {
			// Evict the oldest entry (first in insertion order)
			const oldest = this.cache.keys().next().value;
			this.cache.delete(oldest);
		}
		this.cache.set(key, { value, expiry: Date.now() + this.defaultTTL });
	}
}

// ---------------------------------------------------------------------------
// URL normalization — so variations map to the same cache entry
// ---------------------------------------------------------------------------

function normalizeUrl(url: string): string {
	const u = new URL(url);
	u.pathname = u.pathname.replace(/\/+$/, ""); // strip trailing slash
	u.hash = "";                                // strip fragment
	return u.toString();
}

// ---------------------------------------------------------------------------
// HTTP fetch helper (used by markitdown pipeline)
// ---------------------------------------------------------------------------

async function runWithStdin(command: string, args: string[], input: string): Promise<string> {
	const proc = spawn(command, args);
	proc.stdin.end(input);
	const [stdout, stderr, [code]] = await Promise.all([
		text(proc.stdout),
		text(proc.stderr),
		once(proc, "close"),
	]);
	if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`);
	return stdout;
}

const PARAMS = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	heading: Type.Optional(Type.Number({ description: "Specific heading number to fetch content for" })),
});

export default function webFetchExtension(pi: ExtensionAPI) {
	// Shared cache across all tool invocations in this session
	const cache = new LRUCache<string, string>(50, 3_600_000);

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetches a web document. If the document is too large, it will return headings. You can rerun with a specific heading to get that heading's content.",
		parameters: PARAMS,
		async execute(_toolCallId, params) {
			const { url, heading } = params;
			const key = normalizeUrl(url);

			// --- Cache hit: skip fetch + markitdown ---
			let markdown = cache.get(key);
			if (!markdown) {
				// --- Cache miss: fetch and convert ---
				const response = await fetch(url);
				const html = await response.text();
				markdown = await runWithStdin("uvx", ["markitdown"], html);
				cache.set(key, markdown);
			}

			let output: string;
			if (!heading && markdown.length <= 10240) {
				output = markdown;
			} else if (!heading) {
				const headings = markdown.match(/^(#+\s+.*)$/gm)?.map((h) => h.trim()) || [];
				const numberedHeadings = headings.map((h, i) => `${i + 1}. ${h}`).join("\n");
				output = `The document is too large to fetch in its entirety.

Here are the headings:

${numberedHeadings}

You can run this tool with a specific heading number to get that heading's full content.

Example: web-fetch(url="${url}", heading=number)

Which headings would you like to fetch?
`;
			} else {
				const headingRegex = /^#+\s+(.*)$/gm;
				let match: RegExpExecArray | null;
				let currentHeading = 0;
				let content = "";
				while ((match = headingRegex.exec(markdown)) !== null) {
					currentHeading++;
					if (currentHeading === heading) {
						const nextHeadingIndex = markdown.indexOf("\n#", match.index + 1);
						content = markdown
							.substring(match.index, nextHeadingIndex === -1 ? undefined : nextHeadingIndex)
							.trim();
						break;
					}
				}
				output = content || `Could not find content for heading number ${heading}.`;
			}

			return { content: [{ type: "text", text: output }] };
		},
	});
}
