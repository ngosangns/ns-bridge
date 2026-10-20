// @ts-nocheck — translate Grok CLI tool calls into host tool calls.
import { resolveCliModelId } from "./models.js";
import type { ReasoningEffort } from "./types.js";

/**
 * Permission rules, not `--disallowed-tools`. Deny leaves the `tool_use` in the
 * assistant message and blocks the CLI from running it. Removing the tool makes
 * the model describe the call as text, which the host cannot execute.
 * Read rules also cover grep. Grep is listed so a later CLI does not rely on that.
 */
export const HOST_DENY_RULES = [
	"Read",
	"Read(**)",
	"Edit",
	"Edit(**)",
	"Bash",
	"Bash(*)",
	"Grep",
	"Grep(**)",
] as const;

export interface HostGrokArgOptions {
	promptFile: string;
	modelId: string;
	cwd: string;
	reasoningEffort?: ReasoningEffort;
	/** Set on the second and later turns. Never combined with `sessionId`. */
	resume?: string;
	/** New UUID. Ignored when `resume` is set. */
	sessionId?: string;
}

/** One headless turn. `--always-approve` is absent, so a denied tool is not retried inside the CLI. */
export function buildHostGrokArgs(options: HostGrokArgOptions): string[] {
	const args = [
		"--prompt-file",
		options.promptFile,
		"--output-format",
		"streaming-messages-json",
		"--include-partial-messages",
		"--model",
		resolveCliModelId(options.modelId),
		"--max-turns",
		"1",
		"--no-plan",
		"--no-subagents",
		"--disable-web-search",
		"--cwd",
		options.cwd,
	];
	for (const rule of HOST_DENY_RULES) args.push("--deny", rule);
	const effort = options.reasoningEffort;
	if (effort && effort !== "none") args.push("--reasoning-effort", effort);
	if (options.resume) args.push("--resume", options.resume);
	else if (options.sessionId) args.push("--session-id", options.sessionId);
	return args;
}

export interface HostToolTarget {
	host: "pi" | "omp";
	/** `PI_EDIT_VARIANT`. Only `replace` can take old_string/new_string. */
	editVariant?: string;
}

export type HostToolCall =
	| { name: string; arguments: Record<string, unknown> }
	| { text: string };

const REPLACE_SCRIPT = [
	"import json,sys,base64,pathlib",
	"p=json.loads(base64.b64decode(sys.argv[2]))",
	"path=p['path']",
	"old=p['old']",
	"new=p['new']",
	"replace_all=bool(p.get('all'))",
	"file=pathlib.Path(path)",
	"text=file.read_text()",
	"if old=='':",
	"    sys.stderr.write('old text is empty\\n')",
	"    sys.exit(1)",
	"count=text.count(old)",
	"if count==0:",
	"    sys.stderr.write('old text not found\\n')",
	"    sys.exit(1)",
	"if not replace_all and count!=1:",
	"    sys.stderr.write('old text appears %d times\\n' % count)",
	"    sys.exit(1)",
	"updated=text.replace(old, new) if replace_all else text.replace(old, new, 1)",
	"file.write_text(updated)",
	"print('Updated '+path)",
].join("\n");

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function stringField(args: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function numberField(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unavailable(name: string): HostToolCall {
	return { text: `Tool "${name}" is not available on this host. Use read, grep, bash, edit, or write.` };
}

function invalid(name: string): HostToolCall {
	return { text: `Tool "${name}" arguments were not valid JSON.` };
}

function missing(name: string): HostToolCall {
	return { text: `Tool "${name}" is missing a required argument.` };
}

/**
 * OMP's default edit mode is hashline (`{input}`), and the tag comes from an
 * OMP snapshot this process cannot mint. A replace-shaped edit is rejected by
 * that schema. One host bash runs the replacement instead.
 * `PI_EDIT_VARIANT=replace` is the schema that already speaks old_string/new_string.
 */
function ompReplaceCommand(path: string, old: string, neu: string, replaceAll: boolean): string {
	const script = Buffer.from(REPLACE_SCRIPT, "utf8").toString("base64");
	const payload = Buffer.from(
		JSON.stringify({ path, old, new: neu, all: replaceAll }),
		"utf8",
	).toString("base64");
	return `python3 -c "import base64,sys; exec(base64.b64decode(sys.argv[1]))" ${shellQuote(script)} ${shellQuote(payload)}`;
}

function sedCommand(path: string, offset?: number, limit?: number): string {
	const start = offset !== undefined && offset > 0 ? Math.floor(offset) : 1;
	const end = limit !== undefined && limit > 0 ? start + Math.floor(limit) - 1 : undefined;
	const range = end !== undefined ? `${start},${end}p` : `${start},$p`;
	return `sed -n ${shellQuote(range)} ${shellQuote(path)}`;
}

function translateRead(args: Record<string, unknown>, target: HostToolTarget): HostToolCall {
	const path = stringField(args, ["target_file", "file_path", "path"]);
	if (!path) return missing("read_file");
	const offset = numberField(args, "offset");
	const limit = numberField(args, "limit");
	if (target.host === "omp") {
		if (offset !== undefined || limit !== undefined) {
			return { name: "bash", arguments: { command: sedCommand(path, offset, limit) } };
		}
		return { name: "read", arguments: { path } };
	}
	const next: Record<string, unknown> = { path };
	if (offset !== undefined) next.offset = offset;
	if (limit !== undefined) next.limit = limit;
	return { name: "read", arguments: next };
}

function translateReplace(args: Record<string, unknown>, target: HostToolTarget): HostToolCall {
	const path = stringField(args, ["file_path", "path"]);
	const old = typeof args.old_string === "string" ? args.old_string : undefined;
	const neu = typeof args.new_string === "string" ? args.new_string : undefined;
	if (!path || old === undefined || neu === undefined || old.length === 0) return missing("search_replace");
	const replaceAll = args.replace_all === true;
	if (target.host === "omp") {
		if (target.editVariant?.trim().toLowerCase() === "replace") {
			const next: Record<string, unknown> = { path, old_string: old, new_string: neu };
			if (typeof args.replace_all === "boolean") next.replace_all = args.replace_all;
			return { name: "edit", arguments: next };
		}
		return {
			name: "bash",
			arguments: { command: ompReplaceCommand(path, old, neu, replaceAll) },
		};
	}
	return { name: "edit", arguments: { path, edits: [{ oldText: old, newText: neu }] } };
}

/** Rewrite one CLI tool call onto the host that will execute it. */
export function translateHostToolCall(name: string, argumentsJson: string, target: HostToolTarget): HostToolCall {
	let parsed: Record<string, unknown> | undefined;
	if (argumentsJson.trim()) {
		try {
			parsed = asRecord(JSON.parse(argumentsJson) as unknown);
		} catch {
			return invalid(name);
		}
		if (!parsed) return invalid(name);
	} else {
		parsed = {};
	}

	if (name === "read_file") return translateRead(parsed, target);
	if (name === "list_dir") {
		const dir = stringField(parsed, ["target_directory", "path"]) ?? ".";
		return { name: "bash", arguments: { command: `ls -la ${shellQuote(dir)}` } };
	}
	if (name === "run_terminal_command") {
		const command = stringField(parsed, ["command"]);
		if (!command) return missing(name);
		return { name: "bash", arguments: { command } };
	}
	if (name === "grep") {
		const pattern = stringField(parsed, ["pattern"]);
		if (!pattern) return missing(name);
		const next: Record<string, unknown> = { pattern };
		const path = stringField(parsed, ["path"]);
		if (path) next.path = path;
		if (target.host === "pi") {
			const glob = stringField(parsed, ["glob", "include"]);
			if (glob) next.glob = glob;
		}
		return { name: "grep", arguments: next };
	}
	if (name === "write") {
		const path = stringField(parsed, ["file_path", "path"]);
		const content = typeof parsed.content === "string" ? parsed.content : typeof parsed.contents === "string" ? parsed.contents : undefined;
		if (!path || content === undefined) return missing(name);
		return { name: "write", arguments: { path, content } };
	}
	if (name === "search_replace") return translateReplace(parsed, target);
	return unavailable(name);
}
