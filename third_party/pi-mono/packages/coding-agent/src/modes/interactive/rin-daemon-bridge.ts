import fs from "node:fs/promises";
import path from "node:path";

function safeString(value: unknown): string {
	if (value == null) return "";
	return String(value);
}

export function ensureCtrlJNewLine(keybindings: any) {
	if (!keybindings || typeof keybindings.getUserBindings !== "function" || typeof keybindings.setUserBindings !== "function") return;
	const current = keybindings.getKeys && typeof keybindings.getKeys === "function" ? keybindings.getKeys("tui.input.newLine") : [];
	if (Array.isArray(current) && current.includes("ctrl+j")) return;
	const user = keybindings.getUserBindings();
	const existing = Array.isArray(user && user["tui.input.newLine"])
		? user["tui.input.newLine"].map((value: unknown) => safeString(value).trim()).filter(Boolean)
		: [safeString(user && user["tui.input.newLine"]).trim()].filter(Boolean);
	keybindings.setUserBindings({
		...(user && typeof user === "object" ? user : {}),
		"tui.input.newLine": Array.from(new Set([...existing, "ctrl+j"])),
	});
}

function extractMessageText(message: any) {
	const content = message && message.content;
	if (typeof content === "string") return content;
	const blocks = Array.isArray(content) ? content : [];
	return blocks
		.filter((block: any) => block && block.type === "text")
		.map((block: any) => safeString(block.text))
		.join("\n\n");
}

async function walkJsonlFiles(dir: string, output: string[] = []) {
	let entries: any[] = [];
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return output;
	}
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) await walkJsonlFiles(fullPath, output);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(fullPath);
	}
	return output;
}

export async function readRinSessionInfo(filePath: string) {
	const stat = await fs.stat(filePath);
	const raw = await fs.readFile(filePath, "utf8");
	const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
	let header: any = null;
	let name = "";
	let messageCount = 0;
	let firstMessage = "";
	const allMessages: string[] = [];
	for (const line of lines) {
		let entry: any = null;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry && entry.type === "session") header = entry;
		if (entry && entry.type === "session_info" && entry.name) name = safeString(entry.name);
		if (entry && entry.type === "message" && entry.message) {
			messageCount += 1;
			const text = extractMessageText(entry.message).trim();
			if (text) {
				if (!firstMessage) firstMessage = text;
				allMessages.push(text);
			}
		}
	}
	return {
		path: filePath,
		id: safeString(header && header.id) || path.basename(filePath, ".jsonl"),
		cwd: safeString(header && header.cwd),
		name: name || undefined,
		parentSessionPath: safeString(header && header.parentSession) || undefined,
		created: stat.birthtime || stat.mtime,
		modified: stat.mtime,
		messageCount,
		firstMessage,
		allMessagesText: allMessages.join("\n\n"),
	};
}

export async function loadRinSessions(stateRoot: string, cwd?: string) {
	const sessionRoot = path.join(stateRoot, "sessions");
	const files = await walkJsonlFiles(sessionRoot);
	const items = (await Promise.all(
		files.map(async (filePath) => {
			try {
				return await readRinSessionInfo(filePath);
			} catch {
				return null;
			}
		}),
	)).filter(Boolean);
	items.sort((a: any, b: any) => Number(b.modified) - Number(a.modified));
	if (!cwd) return items;
	const target = path.resolve(cwd);
	const filtered = items.filter((item: any) => safeString(item.cwd) && path.resolve(item.cwd) === target);
	return filtered.length ? filtered : items;
}

const BRIDGE_SESSION_PREFIX = "rin-bridge:";

export function bridgeSessionPath(chatKey: string) {
	return `${BRIDGE_SESSION_PREFIX}${safeString(chatKey).trim()}`;
}

export function parseBridgeSessionPath(sessionPath: string) {
	const value = safeString(sessionPath).trim();
	if (!value.startsWith(BRIDGE_SESSION_PREFIX)) return "";
	return value.slice(BRIDGE_SESSION_PREFIX.length).trim();
}

