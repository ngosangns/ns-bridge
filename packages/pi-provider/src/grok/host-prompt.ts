// @ts-nocheck — cold start sends the transcript; later turns send only the new tail.
import type { Context } from "@earendil-works/pi-ai/compat";
import { buildFullPrompt, buildIncrementalPrompt, contextHistoryFingerprint } from "./prompt.js";

/**
 * Byte budget for the `<user_query>` Grok wraps around one prompt-file text.
 * 96_000 sits under the 99_599-byte query that Grok 1.0.62 still kept inline.
 */
export const GROK_INLINE_USER_QUERY_BYTES = 96_000;

const OMITTED_TURNS = "Earlier turns were omitted so this request stays within the model context limit.";

export interface HostPromptMemory {
	count: number;
	fingerprint: string;
}

export interface HostPromptPlan {
	mode: "full" | "delta";
	text: string;
	count: number;
	fingerprint: string;
}

export function userQueryByteLength(text: string): number {
	return Buffer.byteLength(`<user_query>\n${text}\n</user_query>`, "utf8");
}

export function hostAcpDocument(text: string): string {
	const body = text.length > 0 ? text : " ";
	return JSON.stringify({ type: "acp", content: [{ type: "text", text: body }] });
}

function withMessages(context: Context, messages: Context["messages"]): Context {
	return { ...context, messages };
}

function trimToBytes(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const slice = text.slice(text.length - mid);
		if (Buffer.byteLength(slice, "utf8") <= maxBytes) low = mid;
		else high = mid - 1;
	}
	return text.slice(text.length - low);
}

function capUserQuery(text: string): string {
	if (userQueryByteLength(text) <= GROK_INLINE_USER_QUERY_BYTES) return text;
	const note = `${OMITTED_TURNS}\n\n`;
	const budget = Math.max(0, GROK_INLINE_USER_QUERY_BYTES - userQueryByteLength(note));
	return note + trimToBytes(text, budget);
}

function fitFullPrompt(context: Context): string {
	let messages = [...context.messages];
	let omitted = false;
	const note = { role: "user", content: OMITTED_TURNS } as Context["messages"][number];
	for (let pass = 0; pass < context.messages.length + 2; pass++) {
		const candidate = omitted ? [note, ...messages] : messages;
		const text = buildFullPrompt(withMessages(context, candidate));
		if (userQueryByteLength(text) <= GROK_INLINE_USER_QUERY_BYTES) return text;
		if (messages.length <= 1) return capUserQuery(text);
		messages = messages.slice(1);
		omitted = true;
	}
	const candidate = omitted ? [note, ...messages] : messages;
	return capUserQuery(buildFullPrompt(withMessages(context, candidate)));
}

function tailHasNewInput(messages: Context["messages"]): boolean {
	let start = 0;
	if (messages[0]?.role === "assistant") start = 1;
	return messages.slice(start).some((message) => message.role === "user" || message.role === "toolResult");
}

/**
 * Resume sends the tail after the stored message count and skips the assistant
 * reply already in the Grok session. A rewritten prefix, or a tail with nothing
 * new, starts a new session with the fitted transcript.
 */
export function planHostPrompt(context: Context, memory?: HostPromptMemory): HostPromptPlan {
	const count = context.messages.length;
	const fingerprint = contextHistoryFingerprint(context);
	if (memory && memory.count > 0 && memory.count <= count) {
		const prefix = contextHistoryFingerprint(withMessages(context, context.messages.slice(0, memory.count)));
		if (prefix === memory.fingerprint) {
			const tail = context.messages.slice(memory.count);
			if (tailHasNewInput(tail)) {
				const tailContext = withMessages(context, tail);
				const text = buildIncrementalPrompt(tailContext);
				if (text !== buildFullPrompt(tailContext)) {
					return { mode: "delta", text: capUserQuery(text), count, fingerprint };
				}
			}
		}
	}
	return { mode: "full", text: fitFullPrompt(context), count, fingerprint };
}
