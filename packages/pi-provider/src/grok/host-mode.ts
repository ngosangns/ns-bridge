// @ts-nocheck — one Grok process per host turn. The host executes the tool.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import { resolveGrokBinary } from "./binary.js";
import { INACTIVITY_TIMEOUT_MS, mapReasoningEffort } from "./config.js";
import { emptyAssistantMessage, PiContentEmitter, StreamingUpdatePump } from "./events.js";
import { createHostParseState, grokTurnSucceeded, hostStopReason, parseHostMessagesLine } from "./host-messages.js";
import { hostAcpDocument, planHostPrompt } from "./host-prompt.js";
import { enqueueHostTurn, forgetHostSession, getHostSession, setHostSession } from "./host-session.js";
import { buildHostGrokArgs, translateHostToolCall, type HostToolTarget } from "./host-tools.js";
import { runningInsideOmp } from "./pi-activity.js";
import { getSessionCwd, getSessionScopeKey } from "./session-scope.js";

/**
 * Spawn `grok --max-turns 1` with deny rules so the CLI returns the tool call
 * and does not run it. The next host step resumes that session and sends only
 * the new tail.
 */
export function streamViaHost(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = emptyAssistantMessage(model);
	const emitter = new PiContentEmitter(stream, output);
	const scopeKey = getSessionScopeKey();
	queueMicrotask(() => {
		void enqueueHostTurn(scopeKey, () => runHostTurn(model, context, options, scopeKey, emitter, output));
	});
	return stream;
}

async function runHostTurn(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	scopeKey: string,
	emitter: PiContentEmitter,
	output: ReturnType<typeof emptyAssistantMessage>,
): Promise<void> {
	const pump = new StreamingUpdatePump(1);
	let proc: ReturnType<typeof spawn> | undefined;
	let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;
	let promptDir: string | undefined;
	let resumeId: string | undefined;

	const clearTimer = () => {
		if (inactivityTimer) clearTimeout(inactivityTimer);
		inactivityTimer = undefined;
	};

	const finishError = async (message: string, aborted = false) => {
		if (finished) return;
		finished = true;
		clearTimer();
		if (resumeId) forgetHostSession(scopeKey);
		await pump.idle();
		pump.close();
		emitter.error(message, aborted);
	};

	try {
		if (options?.signal?.aborted) {
			await finishError("aborted", true);
			return;
		}

		const stored = getHostSession(scopeKey);
		const plan = planHostPrompt(context, stored);
		let sessionId: string | undefined;
		if (plan.mode === "delta" && stored) {
			resumeId = stored.grokSessionId;
		} else {
			forgetHostSession(scopeKey);
			sessionId = randomUUID();
		}

		const cwd = getSessionCwd();
		promptDir = await mkdtemp(join(tmpdir(), "grok-host-"));
		const promptFile = join(promptDir, "prompt.json");
		await writeFile(promptFile, hostAcpDocument(plan.text), "utf8");

		const binary = resolveGrokBinary();
		const args = buildHostGrokArgs({
			promptFile,
			modelId: model.id,
			cwd,
			reasoningEffort: mapReasoningEffort(options?.reasoning),
			resume: resumeId,
			sessionId,
		});
		const target: HostToolTarget = {
			host: runningInsideOmp() ? "omp" : "pi",
			editVariant: process.env.PI_EDIT_VARIANT,
		};
		const state = createHostParseState();
		let emittedHostTool = false;
		let spawnFailed = false;
		let spawnError = "";
		let stderr = "";
		let code: number | null = null;

		proc = spawn(binary, args, {
			stdio: ["ignore", "pipe", "pipe"],
			cwd,
			env: process.env,
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		proc.on("error", (err) => {
			spawnFailed = true;
			spawnError = err.message;
		});

		const resetTimer = () => {
			clearTimer();
			inactivityTimer = setTimeout(() => {
				proc?.kill("SIGTERM");
				void finishError(`Grok agent timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000}s`);
			}, INACTIVITY_TIMEOUT_MS);
		};

		const abort = () => proc?.kill("SIGTERM");
		options?.signal?.addEventListener("abort", abort, { once: true });
		const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity, terminal: false });
		resetTimer();
		emitter.ensureStart();

		rl.on("line", (line) => {
			resetTimer();
			const events = parseHostMessagesLine(line, state);
			for (const event of events) {
				pump.enqueue(() => {
					if (finished) return;
					if (event.type === "thinking") {
						emitter.appendThinking(event.text);
						return;
					}
					if (event.type === "text") {
						emitter.appendText(event.text);
						return;
					}
					const translated = translateHostToolCall(event.name, event.arguments, target);
					if ("text" in translated) {
						emitter.appendText(translated.text);
						return;
					}
					emittedHostTool = true;
					emitter.appendResolvedToolCall({
						type: "toolCall",
						id: event.id,
						name: translated.name,
						arguments: translated.arguments,
					});
				});
			}
		});

		await new Promise<void>((resolve) => {
			let rlDone = false;
			let procDone = false;
			const settle = () => {
				if (rlDone && procDone) resolve();
			};
			rl.on("close", () => {
				rlDone = true;
				settle();
			});
			proc?.on("close", (exitCode) => {
				code = exitCode;
				procDone = true;
				settle();
			});
			proc?.on("error", () => {
				rlDone = true;
				procDone = true;
				resolve();
			});
		});
		options?.signal?.removeEventListener("abort", abort);
		clearTimer();
		await pump.idle();

		if (finished) return;
		finished = true;
		pump.close();

		const succeeded = grokTurnSucceeded({
			code,
			spawnFailed,
			maxTurnsReached: state.maxTurnsReached,
			producedOutput: state.emittedContent,
		});
		if (options?.signal?.aborted) {
			if (resumeId) forgetHostSession(scopeKey);
			emitter.error("aborted", true);
			return;
		}
		if (!succeeded) {
			if (resumeId) forgetHostSession(scopeKey);
			emitter.error(spawnError || stderr.trim() || "Grok CLI failed");
			return;
		}

		if (state.inputTokens !== undefined) output.usage.input = state.inputTokens;
		if (state.outputTokens !== undefined) output.usage.output = state.outputTokens;
		if (state.cacheReadTokens !== undefined) output.usage.cacheRead = state.cacheReadTokens;
		output.usage.totalTokens =
			output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
		setHostSession(scopeKey, {
			grokSessionId: resumeId ?? sessionId!,
			count: plan.count,
			fingerprint: plan.fingerprint,
		});
		emitter.done(hostStopReason(state.stopReason, emittedHostTool));
	} catch (err) {
		await finishError(err instanceof Error ? err.message : String(err), options?.signal?.aborted);
	} finally {
		if (promptDir) await rm(promptDir, { recursive: true, force: true });
	}
}
