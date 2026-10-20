// @ts-nocheck — streaming-messages-json. No process is spawned here.
import type { StopReason } from "@earendil-works/pi-ai/compat";
import { mapStopReason } from "./events.js";

interface OpenBlock {
	index: number;
	kind: "text" | "thinking" | "tool";
	text: string;
	id: string;
	name: string;
	startInput?: string;
}

export interface HostParseState {
	blocks: Map<number, OpenBlock>;
	stopReason?: string;
	sawStreamBlocks: boolean;
	emittedContent: boolean;
	finished: boolean;
	/**
	 * `--max-turns 1` ends a tool call with exit code 1 and `error_max_turns`.
	 * `message_stop` arrives first. The session can still be resumed.
	 */
	maxTurnsReached: boolean;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
}

export type HostParseEvent =
	| { type: "thinking"; text: string }
	| { type: "text"; text: string }
	| { type: "tool"; id: string; name: string; arguments: string };

export function createHostParseState(): HostParseState {
	return {
		blocks: new Map(),
		sawStreamBlocks: false,
		emittedContent: false,
		finished: false,
		maxTurnsReached: false,
	};
}

/**
 * A turn is resumable on exit 0, or when the one allowed turn already produced
 * an assistant message and then hit max turns. A spawn failure is not.
 */
export function grokTurnSucceeded(input: {
	code: number | null;
	spawnFailed: boolean;
	maxTurnsReached: boolean;
	producedOutput: boolean;
}): boolean {
	if (input.spawnFailed) return false;
	if (input.code === 0) return true;
	return input.maxTurnsReached && input.producedOutput;
}

/** A tool the host will run stops the turn. An unknown tool rewritten as text does not. */
export function hostStopReason(stopReason: string | undefined, emittedHostTool: boolean): StopReason {
	if (emittedHostTool) return "toolUse";
	if (!stopReason || stopReason === "tool_use" || stopReason === "max_turn_requests") return "stop";
	return mapStopReason(stopReason);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function rememberUsage(state: HostParseState, usage: Record<string, unknown> | undefined): void {
	const input = numberField(usage, "input_tokens");
	const output = numberField(usage, "output_tokens");
	const cacheRead = numberField(usage, "cache_read_input_tokens");
	if (input !== undefined) state.inputTokens = input;
	if (output !== undefined) state.outputTokens = output;
	if (cacheRead !== undefined) state.cacheReadTokens = cacheRead;
}

function rememberStop(state: HostParseState, stop: unknown): void {
	if (typeof stop === "string" && stop.length > 0) state.stopReason = stop;
}

function openBlock(content: Record<string, unknown>, index: number): OpenBlock | undefined {
	const type = content.type;
	if (type === "text") {
		return { index, kind: "text", text: typeof content.text === "string" ? content.text : "", id: "", name: "" };
	}
	if (type === "thinking" || type === "reasoning") {
		const text =
			typeof content.thinking === "string"
				? content.thinking
				: typeof content.text === "string"
					? content.text
					: "";
		return { index, kind: "thinking", text, id: "", name: "" };
	}
	if (type === "tool_use") {
		const input = asRecord(content.input);
		const startInput = input && Object.keys(input).length > 0 ? JSON.stringify(input) : undefined;
		return {
			index,
			kind: "tool",
			text: "",
			id: typeof content.id === "string" ? content.id : "",
			name: typeof content.name === "string" ? content.name : "",
			startInput,
		};
	}
	return undefined;
}

function toolEvent(block: OpenBlock): HostParseEvent {
	return {
		type: "tool",
		id: block.id || `grok-tool-${block.index}`,
		name: block.name || "tool",
		arguments: block.text || block.startInput || "{}",
	};
}

function takeText(block: OpenBlock): HostParseEvent | undefined {
	if (!block.text) return undefined;
	if (block.kind === "thinking") return { type: "thinking", text: block.text };
	if (block.kind === "text") return { type: "text", text: block.text };
	return undefined;
}

function noteTrailing(line: string, state: HostParseState): void {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return;
	}
	const event = asRecord(parsed);
	if (event?.type !== "result") return;
	if (event.subtype === "error_max_turns") state.maxTurnsReached = true;
	rememberUsage(state, asRecord(event.usage));
}

function emitWhole(content: Record<string, unknown>, index: number, state: HostParseState): HostParseEvent[] {
	const block = openBlock(content, index);
	if (!block) return [];
	if (block.kind === "tool") {
		state.emittedContent = true;
		return [toolEvent(block)];
	}
	const event = takeText(block);
	if (!event) return [];
	state.emittedContent = true;
	return [event];
}

function flushTools(state: HostParseState): HostParseEvent[] {
	const events: HostParseEvent[] = [];
	for (const block of [...state.blocks.values()].sort((left, right) => left.index - right.index)) {
		if (block.kind !== "tool") continue;
		state.emittedContent = true;
		events.push(toolEvent(block));
	}
	state.blocks.clear();
	return events;
}

function parseEvent(event: Record<string, unknown>, state: HostParseState): HostParseEvent[] {
	if (state.finished || typeof event.type !== "string") return [];
	if (event.type === "stream_event") {
		const inner = asRecord(event.event);
		return inner ? parseEvent(inner, state) : [];
	}
	if (event.type === "system" || event.type === "user") return [];

	if (event.type === "assistant") {
		const message = asRecord(event.message);
		rememberUsage(state, asRecord(message?.usage));
		rememberStop(state, message?.stop_reason);
		if (state.sawStreamBlocks || state.emittedContent) return [];
		const content = Array.isArray(message?.content) ? message.content : [];
		const events: HostParseEvent[] = [];
		let index = 0;
		for (const entry of content) {
			const record = asRecord(entry);
			if (!record) continue;
			const blockEvents = emitWhole(record, index, state);
			if (blockEvents.length === 0) continue;
			events.push(...blockEvents);
			index += 1;
		}
		return events;
	}

	if (event.type === "result") {
		if (event.subtype === "error_max_turns") state.maxTurnsReached = true;
		rememberUsage(state, asRecord(event.usage));
		if (event.subtype !== "error_max_turns") rememberStop(state, event.stop_reason);
		const events = flushTools(state);
		if (
			!state.emittedContent &&
			!state.sawStreamBlocks &&
			event.is_error !== true &&
			typeof event.result === "string" &&
			event.result.length > 0
		) {
			state.emittedContent = true;
			events.push({ type: "text", text: event.result });
		}
		state.finished = true;
		return events;
	}

	if (event.type === "message_start") {
		rememberUsage(state, asRecord(asRecord(event.message)?.usage));
		return [];
	}

	if (event.type === "content_block_start") {
		const index = numberField(event, "index");
		const content = asRecord(event.content_block);
		if (index === undefined || !content) return [];
		const block = openBlock(content, index);
		if (!block) return [];
		state.sawStreamBlocks = true;
		state.blocks.set(index, block);
		if (block.kind === "tool") return [];
		const initial = takeText(block);
		if (!initial) return [];
		state.emittedContent = true;
		return [initial];
	}

	if (event.type === "content_block_delta") {
		const index = numberField(event, "index");
		const delta = asRecord(event.delta);
		if (index === undefined || !delta) return [];
		const block = state.blocks.get(index);
		if (!block) return [];
		if (delta.type === "input_json_delta" && block.kind === "tool" && typeof delta.partial_json === "string") {
			block.text += delta.partial_json;
			return [];
		}
		if (delta.type === "signature_delta") return [];
		const chunk =
			block.kind === "thinking" && typeof delta.thinking === "string"
				? delta.thinking
				: block.kind === "text" && typeof delta.text === "string"
					? delta.text
					: undefined;
		if (!chunk) return [];
		block.text += chunk;
		state.emittedContent = true;
		return [block.kind === "thinking" ? { type: "thinking", text: chunk } : { type: "text", text: chunk }];
	}

	if (event.type === "content_block_stop") {
		const index = numberField(event, "index");
		if (index === undefined) return [];
		const block = state.blocks.get(index);
		if (!block) return [];
		state.blocks.delete(index);
		if (block.kind !== "tool") return [];
		state.emittedContent = true;
		return [toolEvent(block)];
	}

	if (event.type === "message_delta") {
		const delta = asRecord(event.delta);
		rememberStop(state, delta?.stop_reason);
		rememberUsage(state, asRecord(event.usage));
		return [];
	}

	if (event.type === "message_stop") {
		const events = flushTools(state);
		state.finished = true;
		return events;
	}
	return [];
}

/** Parse one NDJSON line. Non-JSON lines are ignored. A result line after `message_stop` still counts. */
export function parseHostMessagesLine(line: string, state: HostParseState): HostParseEvent[] {
	const trimmed = line.trim();
	if (!trimmed) return [];
	if (state.finished) {
		noteTrailing(trimmed, state);
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return [];
	}
	const event = asRecord(parsed);
	if (!event || typeof event.type !== "string") return [];
	return parseEvent(event, state);
}
