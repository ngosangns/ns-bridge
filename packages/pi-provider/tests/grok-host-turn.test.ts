import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai/compat";

const child = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: child.spawn }));
vi.mock("ns-grok-core/agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("ns-grok-core/agent")>();
	return { ...actual, resolveGrokBinary: () => "/usr/bin/grok" };
});

import { resolveIntegrationMode } from "../src/grok/config.js";
import { createHostParseState, grokTurnSucceeded, hostStopReason, parseHostMessagesLine } from "../src/grok/host-messages.js";
import { GROK_INLINE_USER_QUERY_BYTES, planHostPrompt, userQueryByteLength } from "../src/grok/host-prompt.js";
import { getHostSession, resetHostSessionsForTests } from "../src/grok/host-session.js";
import { buildHostGrokArgs, HOST_DENY_RULES, translateHostToolCall, type HostToolCall } from "../src/grok/host-tools.js";
import { streamViaHost } from "../src/grok/host-mode.js";
import { GROK_BRIDGE_NOTE } from "../src/grok/prompt.js";

const model = { id: "grok-4.7", api: "grok-sdk", provider: "grok", name: "Grok" } as Model<Api>;

function ctx(messages: Context["messages"], systemPrompt = "sys"): Context {
	return { systemPrompt, messages } as Context;
}

function fakeProcess(lines: string[], code: number, stderrText = "") {
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const proc = new EventEmitter() as EventEmitter & {
		stdout: PassThrough;
		stderr: PassThrough;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = stdout;
	proc.stderr = stderr;
	proc.kill = vi.fn();
	setImmediate(() => {
		if (stderrText) stderr.write(stderrText);
		stderr.end();
		for (const line of lines) stdout.write(`${line}\n`);
		stdout.end();
		setImmediate(() => proc.emit("close", code));
	});
	return proc;
}

describe("host grok args", () => {
	it("denies every CLI tool and resumes with one of --resume or --session-id", () => {
		const args = buildHostGrokArgs({
			promptFile: "/tmp/prompt.json",
			modelId: "grok-4.7-agent",
			cwd: "/work",
			reasoningEffort: "high",
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		expect(args).toContain("--max-turns");
		expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
		expect(args).toContain("--output-format");
		expect(args).toContain("streaming-messages-json");
		expect(args).toContain("--include-partial-messages");
		expect(args).toContain("--disable-web-search");
		expect(args[args.indexOf("--model") + 1]).toBe("grok-4.7");
		expect(args[args.indexOf("--cwd") + 1]).toBe("/work");
		expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
		expect(args).not.toContain("--always-approve");
		expect(args).not.toContain("--disallowed-tools");
		expect(args).toContain("--session-id");
		expect(args).not.toContain("--resume");
		for (const rule of HOST_DENY_RULES) {
			expect(args.filter((part, index) => part === rule && args[index - 1] === "--deny")).toEqual([rule]);
		}

		const resumed = buildHostGrokArgs({
			promptFile: "/tmp/prompt.json",
			modelId: "grok-4.7",
			cwd: "/work",
			resume: "22222222-2222-4222-8222-222222222222",
			sessionId: "11111111-1111-4111-8111-111111111111",
		});
		expect(resumed).toContain("--resume");
		expect(resumed).not.toContain("--session-id");
		expect(resumed.filter((part) => part === "--resume")).toHaveLength(1);
	});

	it("keeps host mode available beside the api default", () => {
		expect(resolveIntegrationMode({} as NodeJS.ProcessEnv)).toBe("api");
		expect(resolveIntegrationMode({ PI_GROK_SDK_MODE: "host" })).toBe("host");
		expect(resolveIntegrationMode({ PI_GROK_SDK_MODE: "acp" })).toBe("acp");
		expect(resolveIntegrationMode({ PI_GROK_SDK_MODE: "jsonl" })).toBe("jsonl");
		expect(() => resolveIntegrationMode({ PI_GROK_SDK_MODE: "nope" })).toThrow(/api/);
	});
});

describe("host tool translation", () => {
	const read = JSON.stringify({ target_file: "README.md", offset: 2, limit: 3 });
	const edit = JSON.stringify({
		file_path: "a.txt",
		old_string: "it's tricky",
		new_string: "done",
		replace_all: false,
	});

	it("maps Pi tools onto read, edit, and grep schemas", () => {
		expect(translateHostToolCall("read_file", read, { host: "pi" })).toEqual({
			name: "read",
			arguments: { path: "README.md", offset: 2, limit: 3 },
		});
		expect(translateHostToolCall("search_replace", edit, { host: "pi" })).toEqual({
			name: "edit",
			arguments: { path: "a.txt", edits: [{ oldText: "it's tricky", newText: "done" }] },
		});
		expect(
			translateHostToolCall("grep", JSON.stringify({ pattern: "foo", path: "src", glob: "*.ts" }), { host: "pi" }),
		).toEqual({ name: "grep", arguments: { pattern: "foo", path: "src", glob: "*.ts" } });
		expect(translateHostToolCall("write", JSON.stringify({ file_path: "b.txt", content: "bee" }), { host: "pi" })).toEqual({
			name: "write",
			arguments: { path: "b.txt", content: "bee" },
		});
		expect(translateHostToolCall("run_terminal_command", JSON.stringify({ command: "npm test", description: "tests" }), { host: "pi" })).toEqual({
			name: "bash",
			arguments: { command: "npm test" },
		});
		expect(translateHostToolCall("list_dir", JSON.stringify({ target_directory: "src" }), { host: "pi" })).toEqual({
			name: "bash",
			arguments: { command: "ls -la 'src'" },
		});
		expect(translateHostToolCall("web_search", "{}", { host: "pi" })).toEqual({
			text: 'Tool "web_search" is not available on this host. Use read, grep, bash, edit, or write.',
		});
	});

	it("keeps OMP read and grep strict, and uses bash unless edit mode is replace", () => {
		expect(translateHostToolCall("read_file", JSON.stringify({ target_file: "README.md" }), { host: "omp" })).toEqual({
			name: "read",
			arguments: { path: "README.md" },
		});
		const ranged = translateHostToolCall("read_file", read, { host: "omp" });
		expect(ranged).toEqual({ name: "bash", arguments: { command: "sed -n '2,4p' 'README.md'" } });
		expect(
			translateHostToolCall("grep", JSON.stringify({ pattern: "foo", path: "src", glob: "*.ts" }), { host: "omp" }),
		).toEqual({ name: "grep", arguments: { pattern: "foo", path: "src" } });

		const hashed = translateHostToolCall("search_replace", edit, { host: "omp", editVariant: "hashline" });
		const command = bashCommand(hashed);
		expect(command).not.toContain("old_string");
		expect(command.startsWith("python3 -c ")).toBe(true);
		expect(command).not.toContain("it's tricky");
		const payload = command.split(" ").at(-1)?.replaceAll("'", "") ?? "";
		expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual({
			path: "a.txt",
			old: "it's tricky",
			new: "done",
			all: false,
		});

		expect(translateHostToolCall("search_replace", edit, { host: "omp", editVariant: "replace" })).toEqual({
			name: "edit",
			arguments: { path: "a.txt", old_string: "it's tricky", new_string: "done", replace_all: false },
		});
	});

	it("applies the hashline fallback by rewriting the file once", async () => {
		const { execFile } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
		const dir = mkdtempSync(join(tmpdir(), "grok-host-edit-"));
		const file = join(dir, "a.txt");
		writeFileSync(file, "alpha\nbeta\nalpha\n");
		const once = translateHostToolCall(
			"search_replace",
			JSON.stringify({ file_path: file, old_string: "beta", new_string: "BETA" }),
			{ host: "omp" },
		);
		await runBash(execFile, bashCommand(once));
		expect(readFileSync(file, "utf8")).toBe("alpha\nBETA\nalpha\n");

		writeFileSync(file, "one\none\n");
		const twice = translateHostToolCall(
			"search_replace",
			JSON.stringify({ file_path: file, old_string: "one", new_string: "two" }),
			{ host: "omp" },
		);
		await expect(runBash(execFile, bashCommand(twice))).rejects.toThrow();
		expect(readFileSync(file, "utf8")).toBe("one\none\n");

		const all = translateHostToolCall(
			"search_replace",
			JSON.stringify({ file_path: file, old_string: "one", new_string: "two", replace_all: true }),
			{ host: "omp" },
		);
		await runBash(execFile, bashCommand(all));
		expect(readFileSync(file, "utf8")).toBe("two\ntwo\n");
	});
});

function bashCommand(call: HostToolCall): string {
	if (!("arguments" in call) || call.name !== "bash" || typeof call.arguments.command !== "string") {
		throw new Error("expected a bash command");
	}
	return call.arguments.command;
}

function runBash(execFile: typeof import("node:child_process").execFile, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("bash", ["-lc", command], (err, stdout, stderr) => {
			if (err) reject(new Error(stderr || err.message));
			else resolve(String(stdout));
		});
	});
}

describe("host message parser", () => {
	const lines = [
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"look"}}}',
		'{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"read_file","input":{}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"target_file\\":\\"README.md\\"}"}}}',
		'{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
		'{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":4}}}',
		'{"type":"stream_event","event":{"type":"message_stop"}}',
		'{"type":"assistant","message":{"content":[{"type":"text","text":"again"}],"stop_reason":"tool_use"}}',
		'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Denied by permission policy"}]}}',
		'{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"max_turn_requests","usage":{"input_tokens":10,"output_tokens":4}}',
	];

	it("keeps the tool after message_stop and treats max turns as resumable", () => {
		const state = createHostParseState();
		const events = lines.flatMap((line) => parseHostMessagesLine(line, state));
		expect(events).toContainEqual({ type: "thinking", text: "look" });
		expect(events.filter((event) => event.type === "tool")).toEqual([
			{ type: "tool", id: "call-1", name: "read_file", arguments: '{"target_file":"README.md"}' },
		]);
		expect(events.some((event) => event.type === "text" && event.text.includes("Denied"))).toBe(false);
		expect(events.some((event) => event.type === "text" && event.text === "again")).toBe(false);
		expect(state.finished).toBe(true);
		expect(state.maxTurnsReached).toBe(true);
		expect(state.stopReason).toBe("tool_use");
		expect(state.emittedContent).toBe(true);
		expect(grokTurnSucceeded({ code: 1, spawnFailed: false, maxTurnsReached: true, producedOutput: true })).toBe(true);
		expect(grokTurnSucceeded({ code: 1, spawnFailed: false, maxTurnsReached: true, producedOutput: false })).toBe(false);
		expect(grokTurnSucceeded({ code: 1, spawnFailed: true, maxTurnsReached: true, producedOutput: true })).toBe(false);
		expect(hostStopReason(state.stopReason, true)).toBe("toolUse");
		expect(hostStopReason("tool_use", false)).toBe("stop");
	});
});

describe("host prompt plan", () => {
	it("sends the new tail and cold-starts when the prefix changes", () => {
		const first = planHostPrompt(ctx([{ role: "user", content: "Please read README.md now" } as Context["messages"][number]]));
		expect(first.mode).toBe("full");
		expect(first.text).toContain(GROK_BRIDGE_NOTE);
		expect(first.text).toContain("Please read README.md now");

		const second = planHostPrompt(
			ctx([
				{ role: "user", content: "Please read README.md now" },
				{ role: "assistant", content: [{ type: "text", text: "reading" }] },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE-BODY" }] },
			] as Context["messages"]),
			{ count: first.count, fingerprint: first.fingerprint },
		);
		expect(second.mode).toBe("delta");
		expect(second.text).toContain("FILE-BODY");
		expect(second.text).not.toContain("Please read README.md now");
		expect(second.text).not.toContain("reading");
		expect(second.text).not.toContain(GROK_BRIDGE_NOTE);

		const drifted = planHostPrompt(
			ctx([
				{ role: "user", content: "a different task" },
				{ role: "assistant", content: [{ type: "text", text: "reading" }] },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE-BODY" }] },
			] as Context["messages"]),
			{ count: first.count, fingerprint: first.fingerprint },
		);
		expect(drifted.mode).toBe("full");
		expect(drifted.text).toContain("a different task");
		expect(drifted.text).toContain(GROK_BRIDGE_NOTE);
	});

	it("drops the oldest turns so a cold start stays inside the inline budget", () => {
		const oldOne = `OLD-ONE-${"x".repeat(100_000)}`;
		const oldTwo = `OLD-TWO-${"y".repeat(100_000)}`;
		const plan = planHostPrompt(
			ctx([
				{ role: "user", content: oldOne },
				{ role: "user", content: oldTwo },
				{ role: "user", content: "KEEP-ME" },
			] as Context["messages"]),
		);
		expect(plan.mode).toBe("full");
		expect(plan.text).toContain("KEEP-ME");
		expect(plan.text).toContain("Earlier turns were omitted");
		expect(plan.text).not.toContain("OLD-ONE-");
		expect(plan.text).not.toContain("OLD-TWO-");
		expect(userQueryByteLength(plan.text)).toBeLessThanOrEqual(GROK_INLINE_USER_QUERY_BYTES);
	});
});

describe("host turn stream", () => {
	const toolLines = [
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"look"}}}',
		'{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
		'{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call-1","name":"read_file","input":{}}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"target_file\\":\\"README.md\\"}"}}}',
		'{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
		'{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"input_tokens":10,"output_tokens":4}}}',
		'{"type":"stream_event","event":{"type":"message_stop"}}',
		'{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"Denied by permission policy"}]}}',
		'{"type":"result","subtype":"error_max_turns","is_error":true,"stop_reason":"max_turn_requests"}',
	];
	const textLines = [
		'{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
		'{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}}',
		'{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
		'{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}',
		'{"type":"stream_event","event":{"type":"message_stop"}}',
		'{"type":"result","subtype":"success","is_error":false,"result":"done","stop_reason":"end_turn"}',
	];

	beforeEach(() => {
		resetHostSessionsForTests();
		child.spawn.mockReset();
	});

	it("stores a max-turns tool turn and resumes with only the new tail", async () => {
		const prompts: string[] = [];
		const argvs: string[][] = [];
		child.spawn.mockImplementation((_binary: string, args: string[]) => {
			argvs.push([...args]);
			prompts.push(readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"));
			if (argvs.length === 1) return fakeProcess(toolLines, 1, "Error: max turns reached\n");
			if (argvs.length === 2) return fakeProcess(['{"type":"result","subtype":"error","is_error":true,"result":"boom"}'], 1, "boom\n");
			return fakeProcess(textLines, 0);
		});

		const first = await streamViaHost(
			model,
			ctx([{ role: "user", content: "Please read README.md now" } as Context["messages"][number]]),
		).result();
		expect(first.stopReason, first.errorMessage).toBe("toolUse");
		expect(first.errorMessage).toBeUndefined();
		const tool = first.content.find((block) => block.type === "toolCall");
		expect(tool).toMatchObject({
			type: "toolCall",
			name: "read",
			arguments: { path: "README.md" },
		});
		expect(tool && "arguments" in tool ? tool.arguments : {}).not.toHaveProperty("__parseError");
		expect(first.content.some((block) => block.type === "thinking" && block.thinking === "look")).toBe(true);
		expect(JSON.stringify(first.content)).not.toContain("Denied");
		expect(first.usage.input).toBe(10);
		expect(first.usage.output).toBe(4);
		const sessionId = argvs[0]?.[argvs[0].indexOf("--session-id") + 1];
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(argvs[0]).not.toContain("--resume");
		expect(argvs[0]).not.toContain("--always-approve");
		expect(getHostSession("__anonymous__")?.grokSessionId).toBe(sessionId);

		const continued = ctx([
			{ role: "user", content: "Please read README.md now" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }] },
			{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE-BODY" }] },
		] as Context["messages"]);
		const failed = await streamViaHost(model, continued).result();
		expect(failed.stopReason).toBe("error");
		expect(failed.errorMessage).toContain("boom");
		expect(argvs[1]).toContain("--resume");
		expect(argvs[1]).not.toContain("--session-id");
		expect(argvs[1]?.[argvs[1].indexOf("--resume") + 1]).toBe(sessionId);
		expect(JSON.parse(prompts[1]!).content[0].text).toContain("FILE-BODY");
		expect(JSON.parse(prompts[1]!).content[0].text).not.toContain("Please read README.md now");
		expect(getHostSession("__anonymous__")).toBeUndefined();

		const retried = await streamViaHost(model, continued).result();
		expect(retried.stopReason).toBe("stop");
		expect(retried.content.some((block) => block.type === "text" && block.text === "done")).toBe(true);
		expect(argvs[2]).toContain("--session-id");
		expect(argvs[2]).not.toContain("--resume");
		expect(argvs[2]?.[argvs[2].indexOf("--session-id") + 1]).not.toBe(sessionId);
		expect(JSON.parse(prompts[2]!).content[0].text).toContain("Please read README.md now");
		expect(JSON.parse(prompts[2]!).content[0].text).toContain(GROK_BRIDGE_NOTE);
	});
});
