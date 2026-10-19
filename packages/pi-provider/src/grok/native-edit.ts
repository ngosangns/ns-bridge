// @ts-nocheck — vendored upstream; adapted under MIT (see NOTICE)
import type { PiContentEmitter } from "./events.js";
import { PI_GROK_ACTIVITY, piGrokActivityArmed } from "./pi-activity.js";

/**
 * OMP installs this on the Grok stream options. Pi does not.
 * Symbol.for so the OMP bundle and this provider share one key without
 * importing each other. The host stamps the real `kCursorExecResolved`
 * (a unique symbol this package cannot recreate) and emits the live card.
 */
export const GROK_NATIVE_EDIT = Symbol.for("ns-bridge.grok.nativeEdit");

export type GrokEditOp = "create" | "delete" | "update";

/** One completed Grok file edit, shaped for OMP's edit card. */
export interface GrokNativeEdit {
	id: string;
	path: string;
	op: GrokEditOp;
	/** Compact diff: `+12|added`, `-12|removed`, ` 12|context`. */
	diff: string;
	firstChangedLine?: number;
	isError: boolean;
	errorText?: string;
}

export interface GrokNativeEditResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		diff: string;
		path: string;
		op: GrokEditOp;
		firstChangedLine?: number;
		errorText?: string;
	};
	isError: boolean;
}

/** What the OMP adapter must do for a native card that does not re-run `edit`. */
export interface GrokNativeEditHost {
	/** True only when the skip-execution stamp and the live-card sink are both ready. */
	prepare(): Promise<boolean>;
	/** Stamp the live toolCall before any snapshot. False means do not emit it. */
	stampResolved(block: object): boolean;
	settle(edit: {
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		result: {
			content: GrokNativeEditResult["content"];
			details: Record<string, unknown>;
			isError: boolean;
		};
		isError: boolean;
	}): void;
}

/**
 * On every native toolCall. OMP's validator throws on this key before it
 * coerces arguments, so a missed execution stamp cannot run `bash`, `read`,
 * or `grep` with the real command or path. Renderers do not read the key.
 * A matching stamp skips validation, and the card still sees the other fields.
 */
export const GROK_ALREADY_EXECUTED = "already-executed";

/** One completed Grok tool, shaped for an OMP card other than `edit`. */
export interface GrokNativeCall {
	id: string;
	toolName: "read" | "bash" | "grep" | "glob" | "web_search";
	args: Record<string, unknown>;
	text: string;
	details: Record<string, unknown>;
	isError: boolean;
}

export interface ToolActivityView {
	markdown?: string;
	nativeEdit?: GrokNativeEdit;
	nativeCall?: GrokNativeCall;
}

interface SnippetDiff {
	diff: string;
	firstChangedLine?: number;
}

function splitLines(text: string): string[] {
	if (text.length === 0) return [];
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.split("\n");
}

/**
 * Line diff of an ACP snippet. Numbers start at 1 because the snippet is not
 * the whole file. Context rows keep the old line number, matching OMP's
 * `nativeDiff` (`+N|`, `-N|`, ` N|`).
 */
export function compactSnippetDiff(oldText: string, newText: string): SnippetDiff {
	const oldLines = splitLines(oldText);
	const newLines = splitLines(newText);
	let start = 0;
	const shared = Math.min(oldLines.length, newLines.length);
	while (start < shared && oldLines[start] === newLines[start]) start++;
	let oldEnd = oldLines.length;
	let newEnd = newLines.length;
	while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	const context = 3;
	const prefix = Math.max(0, start - context);
	const suffix = Math.min(context, oldLines.length - oldEnd, newLines.length - newEnd);
	const lines: string[] = [];
	for (let i = prefix; i < start; i++) lines.push(` ${i + 1}|${oldLines[i]}`);
	for (let i = start; i < oldEnd; i++) lines.push(`-${i + 1}|${oldLines[i]}`);
	for (let i = start; i < newEnd; i++) lines.push(`+${i + 1}|${newLines[i]}`);
	for (let k = 0; k < suffix; k++) {
		const index = oldEnd + k;
		lines.push(` ${index + 1}|${oldLines[index]}`);
	}
	return {
		diff: lines.join("\n"),
		firstChangedLine: newEnd > start ? start + 1 : undefined,
	};
}

export function grokEditOp(oldText: string, newText: string, kind?: string): GrokEditOp {
	if (kind === "delete") return "delete";
	if (oldText.length === 0 && newText.length > 0) return "create";
	if (newText.length === 0 && oldText.length > 0) return "delete";
	return "update";
}

function resultText(edit: GrokNativeEdit): string {
	if (edit.isError) return edit.errorText || "Edit failed";
	if (edit.op === "delete") return `Deleted ${edit.path}`;
	if (edit.op === "create") return `Created ${edit.path}`;
	return `Edited ${edit.path}`;
}

function nativeResult(edit: GrokNativeEdit): GrokNativeEditResult {
	return {
		content: [{ type: "text", text: resultText(edit) }],
		details: {
			diff: edit.diff,
			path: edit.path,
			op: edit.op,
			...(edit.firstChangedLine !== undefined ? { firstChangedLine: edit.firstChangedLine } : {}),
			...(edit.isError && edit.errorText ? { errorText: edit.errorText } : {}),
		},
		isError: edit.isError,
	};
}

function stringish(value: unknown): string {
	return typeof value === "string" && value.length > 0 ? value : "";
}

/**
 * Arguments for Pi's display-only `grok_activity` tool. Names stay off
 * read/bash/edit so Pi cannot run them. The body is here so the card can
 * draw it before execute(), and so a cold start still has the text.
 */
function piActivityArguments(pending: {
	toolName: string;
	args: Record<string, unknown>;
	result: {
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
		isError: boolean;
	};
}): Record<string, unknown> {
	const text = pending.result.content.map((block) => block.text).join("");
	if (pending.toolName === "edit") {
		const path = stringish(pending.args.path) || "edit";
		const diff = stringish(pending.result.details.diff);
		const op = stringish(pending.args.op);
		return {
			kind: "edit",
			title: path,
			path,
			...(op ? { op } : {}),
			...(diff ? { diff } : {}),
			...(pending.result.isError ? { isError: true, output: text || "Edit failed" } : {}),
		};
	}
	const fetched = pending.result.details.kind === "url";
	const kind = pending.toolName === "glob" ? "find" : fetched ? "fetch" : pending.toolName;
	const command = stringish(pending.args.command);
	const pattern = stringish(pending.args.pattern);
	const query = stringish(pending.args.query);
	const path = stringish(pending.args.path);
	const title = command || pattern || query || path || kind;
	const offset = pending.args.offset;
	const limit = pending.args.limit;
	return {
		kind,
		title,
		...(path ? { path } : {}),
		...(command ? { command } : {}),
		...(pattern ? { pattern } : {}),
		...(query ? { query } : {}),
		...(typeof offset === "number" ? { offset } : {}),
		...(typeof limit === "number" ? { limit } : {}),
		...(pending.result.details.isDirectory === true ? { directory: true } : {}),
		...(text ? { output: text } : {}),
		...(pending.result.isError ? { isError: true } : {}),
	};
}

/**
 * OMP: a stamped read/bash/edit/grep card. Pi: one `grok_activity` card whose
 * execute() only redisplays the text. Otherwise the Markdown line. A host
 * that cannot stamp is skipped: a toolCall named `edit` would make OMP run
 * `edit` again on a file Grok already wrote.
 */
export async function applyGrokToolActivity(
	emitter: PiContentEmitter,
	activity: ToolActivityView,
	host: GrokNativeEditHost | undefined,
	onToolResult?: (message: {
		role: "toolResult";
		toolCallId: string;
		toolName: string;
		content: GrokNativeEditResult["content"];
		details: Record<string, unknown>;
		isError: boolean;
		timestamp: number;
	}) => unknown,
): Promise<void> {
	const edit = activity.nativeEdit;
	const call = activity.nativeCall;
	const pending = edit
		? {
				id: edit.id,
				toolName: "edit" as const,
				args: {
					path: edit.path,
					op: edit.op,
					...(edit.diff ? { previewDiff: edit.diff } : {}),
					__parseError: GROK_ALREADY_EXECUTED,
				},
				result: nativeResult(edit),
			}
		: call
			? {
					id: call.id,
					toolName: call.toolName,
					args: call.args,
					result: {
						content: [{ type: "text" as const, text: call.text }],
						details: call.details,
						isError: call.isError,
					},
				}
			: undefined;
	if (pending && host) {
		let pushed = false;
		try {
			if (await host.prepare()) {
				const block = {
					type: "toolCall",
					name: pending.toolName,
					id: pending.id,
					arguments: pending.args,
				};
				if (host.stampResolved(block)) {
					emitter.appendResolvedToolCall(block);
					pushed = true;
					try {
						host.settle({
							toolCallId: pending.id,
							toolName: pending.toolName,
							args: pending.args,
							result: pending.result,
							isError: pending.result.isError,
						});
					} catch {
						// The card can still settle from the paired tool result.
					}
					if (typeof onToolResult === "function") {
						try {
							await onToolResult({
								role: "toolResult",
								toolCallId: pending.id,
								toolName: pending.toolName,
								content: pending.result.content,
								details: pending.result.details,
								isError: pending.result.isError,
								timestamp: Date.now(),
							});
						} catch {
							// The host reserved the payload before awaiting its rewrite.
						}
					}
				}
			}
		} catch {
			// Fall through to the Markdown line only when no toolCall was pushed.
		}
		if (pushed) return;
	}
	if (pending && piGrokActivityArmed()) {
		emitter.appendResolvedToolCall({
			type: "toolCall",
			id: pending.id,
			name: PI_GROK_ACTIVITY,
			arguments: piActivityArguments(pending),
		});
		return;
	}
	if (activity.markdown) emitter.appendToolActivity(activity.markdown);
}

export function grokNativeEditHost(options: object | undefined): GrokNativeEditHost | undefined {
	if (!options) return undefined;
	const host = (options as Record<symbol, unknown>)[GROK_NATIVE_EDIT];
	if (!host || typeof host !== "object") return undefined;
	const candidate = host as GrokNativeEditHost;
	if (
		typeof candidate.prepare !== "function" ||
		typeof candidate.stampResolved !== "function" ||
		typeof candidate.settle !== "function"
	) {
		return undefined;
	}
	return candidate;
}
