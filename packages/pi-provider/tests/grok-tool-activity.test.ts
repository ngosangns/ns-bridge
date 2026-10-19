import { beforeEach, describe, expect, it } from "vitest";
import { PiContentEmitter } from "../src/grok/events.js";
import {
	applyGrokToolActivity,
	GROK_ALREADY_EXECUTED,
	type GrokNativeEditHost,
	type ToolActivityView,
} from "../src/grok/native-edit.js";
import {
	armPiGrokActivity,
	PI_GROK_ACTIVITY,
	piActivityExecution,
	piActivityLines,
	piGrokActivityArmed,
	registerPiGrokActivity,
	runningInsideOmp,
} from "../src/grok/pi-activity.js";
import { buildFullPrompt, GROK_BRIDGE_NOTE } from "../src/grok/prompt.js";
import { ToolActivityTracker } from "../src/grok/tool-activity.js";

// Payloads captured from `grok agent stdio` 1.0.46 (trimmed).
const CWD = "/tmp/grokprobe";
const meta = (name: string, kind: string, label: string) => ({
	"x.ai/tool": { version: 1, name, kind, namespace: "grok_build", label, read_only: kind === "read" },
});
const EDIT_FLOW = [
	{ sessionUpdate: "tool_call", toolCallId: "r0", title: "read_file", rawInput: { target_file: `${CWD}/a.txt` }, _meta: meta("read_file", "read", "Read") },
	{ sessionUpdate: "tool_call_update", toolCallId: "r0", kind: "read", title: `Read \`${CWD}/a.txt\``, locations: [{ path: `${CWD}/a.txt` }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "r0", status: "completed", content: [{ type: "content", content: { type: "text", text: "1→line one\n" } }] },
	{ sessionUpdate: "tool_call", toolCallId: "e1", title: "search_replace", rawInput: { file_path: `${CWD}/a.txt`, old_string: "line two", new_string: "line 2" }, _meta: meta("search_replace", "edit", "Edit") },
	{ sessionUpdate: "tool_call_update", toolCallId: "e1", kind: "edit", title: `Edit \`${CWD}/a.txt\``, content: [{ type: "diff", path: `${CWD}/a.txt`, oldText: "line two", newText: "line 2" }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "e1", status: "completed", content: [{ type: "diff", path: `/private${CWD}/a.txt`, oldText: "line two", newText: "line 2" }] },
	{ sessionUpdate: "tool_call", toolCallId: "w2", title: "write", rawInput: { file_path: `${CWD}/b.txt`, content: "bee\nbuzz\n" }, _meta: meta("write", "write", "Write") },
	{ sessionUpdate: "tool_call_update", toolCallId: "w2", kind: "edit", title: `Write \`${CWD}/b.txt\``, content: [{ type: "diff", path: `${CWD}/b.txt`, oldText: "", newText: "bee\nbuzz\n" }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "w2", status: "completed", content: [{ type: "diff", path: `${CWD}/b.txt`, oldText: "", newText: "bee\nbuzz\n" }] },
	{ sessionUpdate: "tool_call", toolCallId: "x3", title: "run_terminal_command", rawInput: { command: "npm test", description: "Run tests" }, _meta: meta("run_terminal_command", "execute", "Run Command") },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", kind: "execute", title: "Execute `npm test`", content: [{ type: "content", content: { type: "text", text: "Run tests" } }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", status: "in_progress", content: [{ type: "content", content: { type: "text", text: "" } }] },
	{ sessionUpdate: "tool_call_update", toolCallId: "x3", status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: 1 test failed\nmore" } }] },
];

function views(updates: unknown[]): ToolActivityView[] {
	const tracker = new ToolActivityTracker(CWD);
	return updates.map((u) => tracker.handle(u as never)).filter((x): x is ToolActivityView => Boolean(x));
}

function render(updates: unknown[]): string[] {
	return views(updates).flatMap((view) => (view.markdown ? [view.markdown] : []));
}

describe("grok tool activity", () => {
	it("renders Grok's own read/edit/write/run tools as visible lines", () => {
		expect(render(EDIT_FLOW)).toEqual([
			"- Read `a.txt`\n",
			"- Edit `a.txt` (+1 −1)\n",
			"- Write `b.txt` (+2 −0)\n",
			"- Run `npm test`\n  - ✗ Run `npm test` failed: Error: 1 test failed ⏎ more\n",
		]);
	});

	it("announces a tool once even without an enriched update", () => {
		expect(
			render([
				{ sessionUpdate: "tool_call", toolCallId: "g", title: "grep", rawInput: { pattern: "foo" }, _meta: meta("grep", "search", "Search") },
				{ sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed" },
				{ sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed" },
			]),
		).toEqual(["- Search `foo`\n"]);
	});

	it("shows the workspace root itself as `.`", () => {
		expect(
			render([
				{ sessionUpdate: "tool_call", toolCallId: "l", title: "list_dir", _meta: meta("list_dir", "read", "List") },
				{ sessionUpdate: "tool_call_update", toolCallId: "l", kind: "read", status: "completed", title: `List \`/private${CWD}\`` },
			]),
		).toEqual(["- List `.`\n"]);
	});

	it("ignores non-tool updates", () => {
		expect(render([{ sessionUpdate: "agent_message_chunk", content: { text: "hi" } }])).toEqual([]);
	});

	it("attaches a native edit payload only to a finished file edit", () => {
		const native = views(EDIT_FLOW).flatMap((view) => (view.nativeEdit ? [view.nativeEdit] : []));
		expect(native).toEqual([
			{
				id: "e1",
				path: "a.txt",
				op: "update",
				diff: "-1|line two\n+1|line 2",
				firstChangedLine: 1,
				isError: false,
			},
			{
				id: "w2",
				path: "b.txt",
				op: "create",
				diff: "+1|bee\n+2|buzz",
				firstChangedLine: 1,
				isError: false,
			},
		]);
	});

	it("emits tool lines as answer text (never toolCall blocks) with list spacing", () => {
		const events: Array<{ type: string }> = [];
		const output = { role: "assistant", content: [], usage: { cost: {} }, stopReason: "stop" } as never as {
			content: Array<{ type: string; text?: string }>;
		};
		const stream = { push: (e: { type: string }) => events.push(e), end: () => undefined };
		const emitter = new PiContentEmitter(stream as never, output as never);
		emitter.appendText("Updating a.txt.");
		emitter.appendToolActivity("- Edit `a.txt` (+1 −1)\n");
		emitter.appendToolActivity("- Run `ls`\n");
		emitter.appendText("Done.");
		emitter.done();
		expect(output.content).toEqual([
			{ type: "text", text: "Updating a.txt.\n\n- Edit `a.txt` (+1 −1)\n- Run `ls`\n\nDone." },
		]);
		expect(output.content.some((b) => b.type === "toolCall")).toBe(false);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("keeps a skip stamp on the toolCall that stream.end snapshots", () => {
		const stamp = Symbol("skip");
		let ended: { content: Array<Record<PropertyKey, unknown>> } | undefined;
		const output = { role: "assistant", content: [], usage: { cost: {} }, stopReason: "stop" } as {
			content: Array<Record<PropertyKey, unknown>>;
		};
		const stream = { push: () => undefined, end: (message: typeof ended) => { ended = message; } };
		const emitter = new PiContentEmitter(stream as never, output as never);
		const block = {
			type: "toolCall" as const,
			name: "edit",
			id: "e1",
			arguments: { path: "a.txt", op: "update", previewDiff: "-1|line two\n+1|line 2" },
		};
		(block as Record<symbol, boolean>)[stamp] = true;
		emitter.appendResolvedToolCall(block);
		emitter.done();
		const endedCall = ended?.content.find((block) => block.type === "toolCall");
		const liveCall = output.content.find((block) => block.type === "toolCall");
		expect(endedCall?.[stamp]).toBe(true);
		expect(liveCall?.[stamp]).toBe(true);
		expect(endedCall).not.toBe(liveCall);
	});
});

describe("grok native edit", () => {
	beforeEach(() => {
		armPiGrokActivity(false);
	});

	const edit = {
		id: "e1",
		path: "a.txt",
		op: "update" as const,
		diff: "-1|line two\n+1|line 2",
		firstChangedLine: 1,
		isError: false,
	};

	function emitter() {
		const events: Array<{ type: string }> = [];
		let ended: { content: Array<Record<PropertyKey, unknown>> } | undefined;
		const output = { role: "assistant", content: [], usage: { cost: {} }, stopReason: "stop" } as {
			content: Array<{ type: string; text?: string }>;
		};
		const stream = {
			push: (event: { type: string }) => events.push(event),
			end: (message: typeof ended) => {
				ended = message;
			},
		};
		return { emitter: new PiContentEmitter(stream as never, output as never), output, events, ended: () => ended };
	}

	it("stamps, settles, and pairs a result without the markdown line", async () => {
		const stamp = Symbol("skip");
		const settled: Array<{ result: { details: { diff?: string } } }> = [];
		const paired: Array<{ toolName: string; details: { diff?: string } }> = [];
		const host: GrokNativeEditHost = {
			prepare: async () => true,
			stampResolved(block) {
				(block as Record<symbol, boolean>)[stamp] = true;
				return true;
			},
			settle(call) {
				settled.push(call);
			},
		};
		const ui = emitter();
		await applyGrokToolActivity(
			ui.emitter,
			{ markdown: "- Edit `a.txt` (+1 −1)\n", nativeEdit: edit },
			host,
			async (message) => {
				paired.push(message);
			},
		);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call?.[stamp]).toBe(true);
		expect(call?.arguments).toEqual({
			path: "a.txt",
			op: "update",
			previewDiff: edit.diff,
			__parseError: GROK_ALREADY_EXECUTED,
		});
		expect(ui.output.content.some((block) => block.type === "text")).toBe(false);
		expect(settled[0]?.result.details.diff).toBe(edit.diff);
		expect(paired[0]).toMatchObject({ toolName: "edit", details: { diff: edit.diff, path: "a.txt", op: "update" } });
		expect(ui.events.some((event) => event.type === "toolcall_end")).toBe(true);
	});

	it("keeps the markdown line when the host cannot stamp", async () => {
		const host: GrokNativeEditHost = {
			prepare: async () => false,
			stampResolved: () => false,
			settle: () => undefined,
		};
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, { markdown: "- Edit `a.txt` (+1 −1)\n", nativeEdit: edit }, host);
		ui.emitter.done();
		expect(ui.ended()?.content.some((block) => block.type === "toolCall")).toBe(false);
		expect(ui.output.content).toEqual([{ type: "text", text: "- Edit `a.txt` (+1 −1)\n" }]);
	});

	it("waits until a read finishes, then builds a read card without gutters", () => {
		const flow = [
			{ sessionUpdate: "tool_call", toolCallId: "r", title: "read_file", rawInput: { target_file: `${CWD}/a.txt`, offset: 2 }, _meta: meta("read_file", "read", "Read") },
			{ sessionUpdate: "tool_call_update", toolCallId: "r", kind: "read", title: `Read \`${CWD}/a.txt\`` },
			{ sessionUpdate: "tool_call_update", toolCallId: "r", status: "completed", content: [{ type: "content", content: { type: "text", text: "2→line two\n" } }] },
		];
		expect(views(flow.slice(0, 2))).toEqual([]);
		const call = views(flow)[0]?.nativeCall;
		expect(call).toMatchObject({
			id: "r",
			toolName: "read",
			args: { path: "a.txt", offset: 2, __parseError: GROK_ALREADY_EXECUTED },
			text: "line two\n",
			isError: false,
			details: { displayContent: { text: "line two\n", startLine: 2 } },
		});
	});

	it("maps list, grep, bash, glob, search, and fetch onto OMP cards", () => {
		const calls = views([
			{ sessionUpdate: "tool_call", toolCallId: "l", rawInput: { target_directory: CWD }, _meta: meta("list_dir", "read", "List") },
			{ sessionUpdate: "tool_call_update", toolCallId: "l", status: "completed", content: [{ type: "content", content: { type: "text", text: `${CWD}/a.txt\n` } }] },
			{ sessionUpdate: "tool_call", toolCallId: "g", rawInput: { pattern: "foo", path: `${CWD}/src` }, _meta: meta("grep", "search", "Search") },
			{ sessionUpdate: "tool_call_update", toolCallId: "g", status: "completed", content: [{ type: "content", content: { type: "text", text: "src/a.ts:1:foo\n" } }] },
			{ sessionUpdate: "tool_call", toolCallId: "b", rawInput: { command: "npm test", description: "Run tests" }, _meta: meta("run_terminal_command", "execute", "Run Command") },
			{ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok\n" } }] },
			{ sessionUpdate: "tool_call", toolCallId: "p", rawInput: { pattern: "**/*.ts" }, _meta: meta("glob", "search", "Glob") },
			{ sessionUpdate: "tool_call_update", toolCallId: "p", status: "completed", content: [{ type: "content", content: { type: "text", text: "src/a.ts\n" } }] },
			{ sessionUpdate: "tool_call", toolCallId: "w", rawInput: { query: "omp edit card" }, _meta: meta("web_search", "fetch", "Search") },
			{ sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed", content: [{ type: "content", content: { type: "text", text: "a result\n" } }] },
			{ sessionUpdate: "tool_call", toolCallId: "f", rawInput: { url: "https://example.com" }, _meta: meta("web_fetch", "fetch", "Fetch") },
			{ sessionUpdate: "tool_call_update", toolCallId: "f", status: "failed", content: [{ type: "content", content: { type: "text", text: "404\n" } }] },
		]).flatMap((view) => (view.nativeCall ? [view.nativeCall] : []));
		expect(calls.map((call) => [call.id, call.toolName, call.isError])).toEqual([
			["l", "read", false],
			["g", "grep", false],
			["b", "bash", false],
			["p", "glob", false],
			["w", "web_search", false],
			["f", "read", true],
		]);
		expect(calls[0]).toMatchObject({ text: "a.txt\n", details: { isDirectory: true }, args: { path: "." } });
		expect(calls[1]).toMatchObject({ args: { pattern: "foo", path: "src" }, details: { displayContent: "src/a.ts:1:foo\n", scopePath: "src" } });
		expect(calls[2]).toMatchObject({ args: { command: "npm test", i: "Run tests" }, text: "ok\n" });
		expect(calls[3]).toMatchObject({ args: { path: "**/*.ts" }, text: "src/a.ts\n" });
		expect(calls[4]).toMatchObject({ args: { query: "omp edit card" }, text: "a result\n" });
		expect(calls[5]).toMatchObject({
			args: { path: "https://example.com" },
			text: "404\n",
			details: { kind: "url", url: "https://example.com", notes: [] },
		});
		for (const call of calls) expect(call.args.__parseError).toBe(GROK_ALREADY_EXECUTED);
	});

	it("settles a bash card and does not also emit the markdown line", async () => {
		const stamp = Symbol("skip");
		const host: GrokNativeEditHost = {
			prepare: async () => true,
			stampResolved(block) {
				(block as Record<symbol, boolean>)[stamp] = true;
				return true;
			},
			settle: () => undefined,
		};
		const view = views([
			{ sessionUpdate: "tool_call", toolCallId: "b", rawInput: { command: "npm test" }, _meta: meta("run_terminal_command", "execute", "Run Command") },
			{ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok\n" } }] },
		])[0];
		expect(view?.nativeCall?.toolName).toBe("bash");
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, view!, host);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({ name: "bash", arguments: { command: "npm test", __parseError: GROK_ALREADY_EXECUTED } });
		expect(call?.[stamp]).toBe(true);
		expect(ui.output.content.some((block) => block.type === "text")).toBe(false);
	});

	it("emits a Pi display card and skips the markdown line", async () => {
		armPiGrokActivity(true);
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, { markdown: "- Edit `a.txt` (+1 −1)\n", nativeEdit: edit }, undefined);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({
			name: PI_GROK_ACTIVITY,
			id: "e1",
			arguments: { kind: "edit", title: "a.txt", path: "a.txt", op: "update", diff: edit.diff },
		});
		expect(call?.arguments).not.toHaveProperty("__parseError");
		expect(ui.output.content.some((block) => block.type === "text")).toBe(false);
		expect(ui.events.some((event) => event.type === "toolcall_end")).toBe(true);
	});

	it("keeps the OMP card when the host can stamp", async () => {
		armPiGrokActivity(true);
		const stamp = Symbol("skip");
		const host: GrokNativeEditHost = {
			prepare: async () => true,
			stampResolved(block) {
				(block as Record<symbol, boolean>)[stamp] = true;
				return true;
			},
			settle: () => undefined,
		};
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, { markdown: "- Edit `a.txt` (+1 −1)\n", nativeEdit: edit }, host);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({ name: "edit" });
		expect(call?.arguments).toMatchObject({ __parseError: GROK_ALREADY_EXECUTED });
	});

	it("puts a finished bash body on the Pi card", async () => {
		armPiGrokActivity(true);
		const view = views([
			{ sessionUpdate: "tool_call", toolCallId: "b", rawInput: { command: "npm test" }, _meta: meta("run_terminal_command", "execute", "Run Command") },
			{ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok\n" } }] },
		])[0];
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, view!, undefined);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({
			name: PI_GROK_ACTIVITY,
			arguments: { kind: "bash", title: "npm test", command: "npm test", output: "ok\n" },
		});
		expect(call?.arguments).not.toHaveProperty("__parseError");
		expect(ui.output.content.some((block) => block.type === "text")).toBe(false);
	});

	it("labels a fetched page as fetch on the Pi card", async () => {
		armPiGrokActivity(true);
		const view = views([
			{ sessionUpdate: "tool_call", toolCallId: "f", rawInput: { url: "https://example.com" }, _meta: meta("web_fetch", "fetch", "Fetch") },
			{ sessionUpdate: "tool_call_update", toolCallId: "f", status: "completed", content: [{ type: "content", content: { type: "text", text: "hello\n" } }] },
		])[0];
		const ui = emitter();
		await applyGrokToolActivity(ui.emitter, view!, undefined);
		ui.emitter.done();
		const call = ui.ended()?.content.find((block) => block.type === "toolCall");
		expect(call).toMatchObject({
			name: PI_GROK_ACTIVITY,
			arguments: { kind: "fetch", title: "https://example.com", output: "hello\n" },
		});
	});
});

describe("pi grok activity card", () => {
	beforeEach(() => {
		armPiGrokActivity(false);
	});

	it("draws an edit diff and clips a long bash body from the end", () => {
		expect(piActivityLines({ kind: "edit", title: "a.txt", op: "update", diff: "-1|line two\n+1|line 2" })).toEqual([
			{ role: "title", text: "edit a.txt" },
			{ role: "remove", text: "-1|line two" },
			{ role: "add", text: "+1|line 2" },
		]);
		const output = Array.from({ length: 20 }, (_item, index) => `line ${index}`).join("\n");
		const lines = piActivityLines({ kind: "bash", title: "npm test", output });
		expect(lines[0]).toEqual({ role: "title", text: "$ npm test" });
		expect(lines[1]).toEqual({ role: "output", text: "line 8" });
		expect(lines.at(-1)).toEqual({ role: "muted", text: "… (8 more lines)" });
		expect(piActivityLines({ kind: "bash", title: "npm test", output }, true).some((line) => line.role === "muted")).toBe(false);
	});

	it("returns a display result and does not treat the command as work to run", async () => {
		const result = await Promise.resolve(
			piActivityExecution({ kind: "bash", title: "rm -rf /", command: "rm -rf /", output: "ok\n" }),
		);
		expect(result).toMatchObject({
			isError: false,
			terminate: true,
			content: [{ type: "text", text: "Ran rm -rf /" }],
		});
	});

	it("arms the display tool only while the model is Grok", () => {
		let active = ["read", "bash", "edit", "write"];
		let tool: { prepareLoadout: () => { hiddenDeclarations: string[] }; defaultActive: boolean; name: string } | undefined;
		const handlers: Record<string, (event: unknown, ctx: { model?: { provider?: string } }) => void> = {};
		registerPiGrokActivity({
			registerTool(next: typeof tool) {
				tool = next;
			},
			on(event: string, handler: (event: unknown, ctx: { model?: { provider?: string } }) => void) {
				handlers[event] = handler;
			},
			getActiveTools: () => active,
			setActiveTools(names: string[]) {
				active = names;
			},
		});
		expect(tool?.name).toBe(PI_GROK_ACTIVITY);
		expect(tool?.defaultActive).toBe(false);
		expect(tool?.prepareLoadout().hiddenDeclarations).toEqual([PI_GROK_ACTIVITY]);
		handlers.before_agent_start?.({}, { model: { provider: "grok" } });
		expect(active).toContain(PI_GROK_ACTIVITY);
		expect(piGrokActivityArmed()).toBe(true);
		handlers.before_agent_start?.({}, { model: { provider: "anthropic" } });
		expect(active).not.toContain(PI_GROK_ACTIVITY);
		expect(piGrokActivityArmed()).toBe(false);
	});

	it("detects an OMP process from its argv", () => {
		expect(runningInsideOmp(["/opt/homebrew/bin/pi"])).toBe(false);
		expect(runningInsideOmp(["/Users/x/.bun/bin/omp"])).toBe(true);
		expect(runningInsideOmp(["bun", "/opt/omp/cli.js", "__omp_worker_text_predict"])).toBe(true);
	});
});

describe("grok bridge note", () => {
	it("prefixes cold-start prompts so Grok acts with its own tools", () => {
		const prompt = buildFullPrompt({
			systemPrompt: "You are pi. Tools: read, bash, edit, write.",
			messages: [{ role: "user", content: "fix the bug", timestamp: 0 }],
		} as never);
		expect(prompt.startsWith(GROK_BRIDGE_NOTE)).toBe(true);
		expect(prompt).toContain("system:\nYou are pi.");
		expect(prompt).toContain("user:\nfix the bug");
	});

	it("can be disabled and leaves empty prompts empty", () => {
		process.env.PI_GROK_SDK_BRIDGE_NOTE = "0";
		try {
			const prompt = buildFullPrompt({ messages: [{ role: "user", content: "hi", timestamp: 0 }] } as never);
			expect(prompt).toBe("user:\nhi");
		} finally {
			delete process.env.PI_GROK_SDK_BRIDGE_NOTE;
		}
		expect(buildFullPrompt({ messages: [] } as never)).toBe("");
	});
});
