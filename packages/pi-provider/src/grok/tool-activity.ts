/**
 * Surface the Grok agent's own tool activity in the host transcript.
 *
 * The Grok CLI is a full coding agent: in ACP mode it reads, edits, writes and
 * runs commands itself (`read_file`, `search_replace`, `write`,
 * `run_terminal_command`, …) and only reports them through `session/update`
 * `tool_call` / `tool_call_update` notifications. The host must not run those
 * tools again. A completed tool that OMP knows how to draw (edit, read, bash,
 * grep, glob, web search) also carries a native card payload. OMP shows the
 * card only when it can stamp the call as already executed. Pi keeps the line.
 */
import {
	compactSnippetDiff,
	GROK_ALREADY_EXECUTED,
	grokEditOp,
	type GrokNativeCall,
	type GrokNativeEdit,
	type ToolActivityView,
} from "./native-edit.js";

export interface AcpToolUpdate {
	sessionUpdate?: string;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: Record<string, unknown>;
	content?: unknown;
	locations?: Array<{ path?: string }>;
	_meta?: Record<string, unknown>;
}

interface DiffSnippet {
	path?: string;
	oldText: string;
	newText: string;
}

interface ToolEntry {
	name?: string;
	label?: string;
	kind?: string;
	title?: string;
	rawInput?: Record<string, unknown>;
	stat?: string;
	diffs?: DiffSnippet[];
	output?: string;
	locations?: Array<{ path?: string }>;
	announced: boolean;
	finished: boolean;
}

type NativeCard = "edit" | "read" | "bash" | "grep" | "glob" | "web_search" | "web_fetch";

const MAX_OUTPUT = 64 * 1024;

const MAX_LABEL = 160;

function toolMeta(update: AcpToolUpdate): { name?: string; kind?: string; label?: string } {
	const meta = update._meta?.["x.ai/tool"];
	if (!meta || typeof meta !== "object") return {};
	const m = meta as Record<string, unknown>;
	return {
		name: typeof m.name === "string" ? m.name : undefined,
		kind: typeof m.kind === "string" ? m.kind : undefined,
		label: typeof m.label === "string" ? m.label : undefined,
	};
}

function oneLine(text: string, max = MAX_LABEL): string {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function countLines(text: unknown): number {
	if (typeof text !== "string" || text.length === 0) return 0;
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n").length;
}

function parseDiffs(content: unknown): DiffSnippet[] {
	if (!Array.isArray(content)) return [];
	const out: DiffSnippet[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		if (c.type !== "diff") continue;
		out.push({
			path: typeof c.path === "string" ? c.path : undefined,
			oldText: typeof c.oldText === "string" ? c.oldText : "",
			newText: typeof c.newText === "string" ? c.newText : "",
		});
	}
	return out;
}

function isFileEdit(kind: string | undefined): boolean {
	return kind === "edit" || kind === "delete" || kind === "move" || kind === "write";
}

function collectText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		if (typeof c.text === "string" && c.text.trim()) {
			parts.push(c.text);
			continue;
		}
		const inner = c.content as Record<string, unknown> | undefined;
		if (inner && typeof inner.text === "string" && inner.text.trim()) parts.push(inner.text);
	}
	return parts.join("\n");
}

function capOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_OUTPUT) return { text, truncated: false };
	return { text: `${text.slice(0, MAX_OUTPUT)}\n…`, truncated: true };
}

/** Drop Grok's `12→` gutters so OMP's read card can number the lines itself. */
function stripReadGutters(text: string): string {
	return text
		.split("\n")
		.map((line) => line.replace(/^\d+→/, ""))
		.join("\n");
}

function stringField(input: Record<string, unknown>, keys: string[]): string {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value) return value;
	}
	return "";
}

/** `+added −removed` over ACP `diff` content items, or "" when none. */
export function diffStat(content: unknown): string {
	if (!Array.isArray(content)) return "";
	let added = 0;
	let removed = 0;
	let seen = false;
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		if (c.type !== "diff") continue;
		seen = true;
		added += countLines(c.newText);
		removed += countLines(c.oldText);
	}
	return seen ? `+${added} −${removed}` : "";
}

function firstText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	for (const item of content) {
		if (!item || typeof item !== "object") continue;
		const c = item as Record<string, unknown>;
		const inner = c.content as Record<string, unknown> | undefined;
		if (c.type === "content" && inner && typeof inner.text === "string" && inner.text.trim()) {
			return inner.text;
		}
	}
	return "";
}

export class ToolActivityTracker {
	private readonly tools = new Map<string, ToolEntry>();

	constructor(private readonly cwd?: string) {}

	private relativize(text: string): string {
		const cwd = this.cwd?.replace(/\/+$/, "");
		if (!cwd || cwd === "/") return text;
		let out = text;
		const roots = new Set([cwd, cwd.replace(/^\/private\//, "/")]);
		for (const root of [...roots]) roots.add(`/private${root}`);
		// Longest first so "/private/tmp/x" wins over "/tmp/x".
		for (const root of [...roots].sort((a, b) => b.length - a.length)) {
			out = out.split(`${root}/`).join("");
			out = out.split(`\`${root}\``).join("`.`");
		}
		if ([...roots].some((root) => out === root)) return ".";
		return out;
	}

	private describe(entry: ToolEntry): string {
		const input = entry.rawInput ?? {};
		let label: string;
		if (entry.kind === "execute" && typeof input.command === "string") {
			label = `Run \`${oneLine(String(input.command), MAX_LABEL - 8)}\``;
		} else if (entry.title && entry.title !== entry.name) {
			label = oneLine(entry.title);
		} else {
			const verb = entry.label ?? entry.name ?? "Tool";
			const target =
				(typeof input.file_path === "string" && input.file_path) ||
				(typeof input.target_file === "string" && input.target_file) ||
				(typeof input.path === "string" && input.path) ||
				(typeof input.pattern === "string" && input.pattern) ||
				(typeof input.query === "string" && input.query) ||
				"";
			label = target ? `${verb} \`${oneLine(String(target), MAX_LABEL - 8)}\`` : verb;
		}
		return this.relativize(label);
	}

	/**
	 * Feed one ACP `session/update`. `markdown` is a list line ending in "\n".
	 * `nativeEdit` / `nativeCall` are set once that tool finishes. Undefined
	 * when nothing new is visible yet.
	 */
	handle(update: AcpToolUpdate): ToolActivityView | undefined {
		const kind = update.sessionUpdate;
		if (kind !== "tool_call" && kind !== "tool_call_update") return undefined;
		const id = update.toolCallId;
		if (!id) return undefined;

		let entry = this.tools.get(id);
		if (!entry) {
			entry = { announced: false, finished: false };
			this.tools.set(id, entry);
		}
		const meta = toolMeta(update);
		entry.name ??= meta.name ?? (kind === "tool_call" ? update.title : undefined);
		entry.label ??= meta.label;
		if (meta.kind) entry.kind = meta.kind === "write" ? "edit" : meta.kind;
		if (update.kind) entry.kind = update.kind;
		if (update.rawInput && typeof update.rawInput === "object") {
			entry.rawInput = { ...(entry.rawInput ?? {}), ...update.rawInput };
		}
		if (update.title) entry.title = update.title;
		if (update.locations?.length) entry.locations = update.locations;
		const text = collectText(update.content);
		if (text) entry.output = text;
		if (entry.finished) return undefined;

		const lines: string[] = [];
		const status = update.status;
		const done = status === "completed" || status === "failed";
		const diffs = parseDiffs(update.content);
		if (diffs.length) entry.diffs = diffs;
		const stat = diffStat(update.content);
		if (stat) entry.stat = stat;
		const card = this.nativeKind(entry);
		const isEdit = card === "edit";
		// Cards wait until the tool finishes so the body is the final output.
		// Anything OMP cannot draw still appears on the first useful update.
		const enriched = kind === "tool_call_update" && Boolean(update.title || update.kind);
		const ready = card ? done : enriched || done || status === "in_progress";

		if (!entry.announced && ready) {
			entry.announced = true;
			lines.push(`- ${this.describe(entry)}${isEdit && entry.stat ? ` (${entry.stat})` : ""}`);
			if (done) {
				entry.finished = true;
				if (status === "failed") lines.push(`  - ✗ ${this.describe(entry)} failed${this.failureDetail(update)}`);
			}
		} else if (entry.announced && done) {
			entry.finished = true;
			if (status === "failed") {
				lines.push(`  - ✗ ${this.describe(entry)} failed${this.failureDetail(update)}`);
			}
		}
		const markdown = lines.length ? `${lines.join("\n")}\n` : undefined;
		const nativeEdit = done && isEdit ? this.toNativeEdit(id, entry, update) : undefined;
		const nativeCall =
			done && card && card !== "edit" ? this.toNativeCall(id, entry, update, card) : undefined;
		if (!markdown && !nativeEdit && !nativeCall) return undefined;
		return { markdown, nativeEdit, nativeCall };
	}

	/**
	 * OMP card for this Grok tool, or undefined when the host should keep the
	 * Markdown line. Names win over ACP kind so `list_dir` (kind `read`) is a
	 * read card and a search without a pattern stays a line.
	 */
	private nativeKind(entry: ToolEntry): NativeCard | undefined {
		if (isFileEdit(entry.kind)) return "edit";
		const name = entry.name;
		const input = entry.rawInput ?? {};
		const command = typeof input.command === "string" && input.command ? input.command : "";
		if (name === "read_file" || name === "read" || name === "list_dir") return "read";
		if (name === "grep") return "grep";
		if (name === "glob") return "glob";
		if (name === "run_terminal_command" || name === "bash") return command ? "bash" : undefined;
		if (name === "web_search") return "web_search";
		if (name === "web_fetch" || name === "open_page") return "web_fetch";
		if (entry.kind === "execute" && command) return "bash";
		if (entry.kind === "read") return "read";
		if (entry.kind === "search" && typeof input.pattern === "string" && input.pattern) return "grep";
		if (entry.kind === "fetch") return "web_fetch";
		return undefined;
	}

	private toNativeCall(
		id: string,
		entry: ToolEntry,
		update: AcpToolUpdate,
		card: Exclude<NativeCard, "edit">,
	): GrokNativeCall | undefined {
		const input = entry.rawInput ?? {};
		const isError = update.status === "failed";
		let raw = entry.output ?? "";
		if (card === "read" && entry.name !== "list_dir") raw = stripReadGutters(raw);
		else if (card !== "web_search" && card !== "web_fetch") raw = this.relativize(raw);
		const body = capOutput(raw);
		const text = body.text || (isError ? this.failureText(update) || "Failed" : "");
		const sentinel = { __parseError: GROK_ALREADY_EXECUTED };
		if (card === "bash") {
			const command = stringField(input, ["command"]);
			if (!command) return undefined;
			const description = stringField(input, ["description"]);
			return {
				id,
				toolName: "bash",
				args: { command, ...(description ? { i: description } : {}), ...sentinel },
				text,
				details: {},
				isError,
			};
		}
		if (card === "grep") {
			const pattern = stringField(input, ["pattern", "query"]);
			if (!pattern) return undefined;
			const scope = this.pathArg(input.path);
			return {
				id,
				toolName: "grep",
				args: { pattern, ...(scope !== undefined ? { path: scope } : {}), ...sentinel },
				text,
				details: {
					...(text ? { displayContent: text } : {}),
					...(typeof scope === "string" ? { scopePath: scope } : {}),
				},
				isError,
			};
		}
		if (card === "glob") {
			const pattern = stringField(input, ["pattern", "glob", "glob_pattern", "path"]);
			if (!pattern) return undefined;
			return {
				id,
				toolName: "glob",
				args: { path: this.relativize(pattern), ...sentinel },
				text,
				details: {},
				isError,
			};
		}
		if (card === "web_search") {
			const query = stringField(input, ["query", "q", "search_query"]);
			if (!query) return undefined;
			return {
				id,
				toolName: "web_search",
				args: { query, ...sentinel },
				text,
				details: isError ? { error: text || "Search failed" } : {},
				isError,
			};
		}
		const path = this.toolPath(entry, input);
		if (!path) return undefined;
		if (card === "web_fetch") {
			return {
				id,
				toolName: "read",
				args: { path, ...sentinel },
				text,
				details: {
					kind: "url",
					url: path,
					finalUrl: path,
					contentType: "text/plain",
					method: "GET",
					truncated: body.truncated,
					notes: [],
				},
				isError,
			};
		}
		const offset = typeof input.offset === "number" && input.offset >= 1 ? input.offset : undefined;
		const limit = typeof input.limit === "number" && input.limit >= 1 ? input.limit : undefined;
		return {
			id,
			toolName: "read",
			args: {
				path,
				...(offset !== undefined ? { offset } : {}),
				...(limit !== undefined ? { limit } : {}),
				...sentinel,
			},
			text,
			details: isError
				? {}
				: {
						...(entry.name === "list_dir" ? { isDirectory: true } : {}),
						displayContent: { text, startLine: offset ?? 1 },
					},
			isError,
		};
	}

	private toolPath(entry: ToolEntry, input: Record<string, unknown>): string {
		const listed = entry.name === "list_dir";
		const raw = listed
			? stringField(input, ["target_directory", "path", "directory"])
			: stringField(input, ["url", "uri", "href", "target_file", "file_path", "path", "target"]);
		if (raw) return this.relativize(raw);
		const located = entry.locations?.find((item) => item.path)?.path;
		if (located) return this.relativize(located);
		return listed ? "." : "";
	}

	private pathArg(value: unknown): string | string[] | undefined {
		if (typeof value === "string" && value) return this.relativize(value);
		if (!Array.isArray(value)) return undefined;
		const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
		return items.length ? items.map((item) => this.relativize(item)) : undefined;
	}

	private toNativeEdit(id: string, entry: ToolEntry, update: AcpToolUpdate): GrokNativeEdit {
		const diffs = entry.diffs ?? [];
		const input = entry.rawInput ?? {};
		const rawPath =
			diffs.find((item) => item.path)?.path ||
			(typeof input.file_path === "string" && input.file_path) ||
			(typeof input.path === "string" && input.path) ||
			(typeof input.target_file === "string" && input.target_file) ||
			"";
		const parts = diffs.map((item) => compactSnippetDiff(item.oldText, item.newText));
		const firstChangedLine = parts.find((part) => part.firstChangedLine !== undefined)?.firstChangedLine;
		const op = this.editOp(entry.kind, diffs);
		const isError = update.status === "failed";
		const errorText = isError ? this.failureText(update) : undefined;
		return {
			id,
			path: this.relativize(rawPath),
			op,
			diff: parts
				.map((part) => part.diff)
				.filter(Boolean)
				.join("\n\n"),
			...(firstChangedLine !== undefined ? { firstChangedLine } : {}),
			isError,
			...(errorText ? { errorText } : {}),
		};
	}

	private editOp(kind: string | undefined, diffs: DiffSnippet[]): GrokNativeEdit["op"] {
		if (kind === "delete") return "delete";
		if (diffs.length === 0) return kind === "write" ? "create" : "update";
		const ops = diffs.map((item) => grokEditOp(item.oldText, item.newText, kind));
		if (ops.every((op) => op === "create")) return "create";
		if (ops.every((op) => op === "delete")) return "delete";
		return "update";
	}

	private failureText(update: AcpToolUpdate): string {
		const text = firstText(update.content);
		return text ? this.relativize(oneLine(text, 200)) : "";
	}

	private failureDetail(update: AcpToolUpdate): string {
		const text = firstText(update.content);
		return text ? `: ${this.relativize(oneLine(text, 200))}` : "";
	}
}
