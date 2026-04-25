/**
 * Web Fetch Tool
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

// ---------------------------------------------------------------------------
// Cache Management
// ---------------------------------------------------------------------------

interface CacheEntry {
	markdown: string;
	timestamp: number;
}

class MarkdownCache {
	private cache = new Map<string, CacheEntry>();
	private readonly maxSize: number;
	private readonly maxAgeMs: number;

	constructor(maxSize: number, maxAgeMs: number) {
		this.maxSize = maxSize;
		this.maxAgeMs = maxAgeMs;
	}

	get(url: string): string | undefined {
		const entry = this.cache.get(url);
		if (!entry) return undefined;

		if (Date.now() - entry.timestamp > this.maxAgeMs) {
			this.cache.delete(url);
			return undefined;
		}

		return entry.markdown;
	}

	set(url: string, markdown: string): void {
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(url, { markdown, timestamp: Date.now() });
	}
}

// ---------------------------------------------------------------------------
// Extension Definition
// ---------------------------------------------------------------------------

const PARAMS = Type.Object({
	url: Type.String({ description: "URL to fetch" }),
	heading: Type.Optional(Type.Number({ description: "Specific heading number to fetch content for" })),
});

export default function webFetchExtension(pi: ExtensionAPI) {

	const cache = new MarkdownCache(50, 1000 * 60 * 30);

	pi.registerTool({
		name: "web-fetch",
		label: "Web Fetch",
		description:
			"Fetches a web document. If the document is too large, it will return headings. You can rerun with a specific heading to get that heading's content.",
		parameters: PARAMS,
		async execute(_toolCallId, params) {
			const { url, heading } = params;

			let markdown: string;
			const cached = cache.get(url);

			if (cached) {
				markdown = cached;
			} else {
				const response = await fetch(url);
				const html = await response.text();
				markdown = await runWithStdin("uvx", ["markitdown"], html);
				cache.set(url, markdown);
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

			return { content: [{ type: "text", text: output }], details: null };
		},
	});
}
