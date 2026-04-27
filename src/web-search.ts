/**
 * Web Search Tool
 *
 * Searches the web using ddgr (DuckDuckGo from the command line).
 *
 * Usage:
 * 1. Ensure ddgr is installed: pip install ddgr
 * 2. Copy this file to ~/.pi/agent/extensions/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PARAMS = Type.Object({
	query: Type.String({ description: "Search query" }),
});

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web-search",
		label: "Web Search",
		description: "Search the web for information",
		parameters: PARAMS,
		async execute(_toolCallId, params) {
			const { stdout } = await execFileP("uvx", ["ddgr", "--json", params.query]);
			return { content: [{ type: "text", text: stdout }] };
		},
	});
}
