// @ts-nocheck — Pi 1.3 display cards. No @earendil-works imports: OMP bundles this file.
/**
 * Pi has no skip-execution stamp. A toolCall named read, bash, or edit would
 * run. This registers one hidden tool, `grok_activity`, whose execute() only
 * returns the text Grok already produced and sets terminate so Pi does not
 * ask the model to continue. The card is Pi's ToolExecutionComponent.
 */

export const PI_GROK_ACTIVITY = "grok_activity";

const PREVIEW_LINES = 12;

let armed = false;

export function armPiGrokActivity(on) {
	armed = on;
}

export function piGrokActivityArmed() {
	return armed;
}

/** True when this process is oh-my-pi. That host draws its own stamped cards. */
export function runningInsideOmp(argv = process.argv) {
	for (const arg of argv) {
		if (typeof arg !== "string") continue;
		if (arg.includes("@oh-my-pi/") || arg.includes("__omp_")) return true;
		if (/(?:^|[\\/])omp$/.test(arg)) return true;
	}
	return false;
}

export function piActivitySummary(args) {
	const kind = typeof args?.kind === "string" ? args.kind : "tool";
	const title = typeof args?.title === "string" ? args.title : "";
	if (args?.isError === true) {
		const output = typeof args.output === "string" ? args.output.trim() : "";
		if (!output) return `${kind} failed`;
		const line = output.split("\n")[0] ?? output;
		return line.length > 200 ? `${line.slice(0, 199)}…` : line;
	}
	if (kind === "edit") {
		if (args?.op === "create") return title ? `Created ${title}` : "Created file";
		if (args?.op === "delete") return title ? `Deleted ${title}` : "Deleted file";
		return title ? `Edited ${title}` : "Edited file";
	}
	if (kind === "bash") return title ? `Ran ${title}` : "Ran command";
	if (kind === "read" && args?.directory === true) return title ? `Listed ${title}` : "Listed directory";
	if (kind === "read") return title ? `Read ${title}` : "Read file";
	if (kind === "grep") return title ? `Searched ${title}` : "Searched";
	if (kind === "find") return title ? `Found ${title}` : "Found files";
	if (kind === "web_search") return title ? `Searched ${title}` : "Searched the web";
	if (kind === "fetch") return title ? `Fetched ${title}` : "Fetched page";
	return title || kind;
}

/** What execute() returns. Display only: no file and no shell. */
export function piActivityExecution(params) {
	const args = params && typeof params === "object" ? params : {};
	const kind = typeof args.kind === "string" ? args.kind : "tool";
	const title = typeof args.title === "string" ? args.title : "";
	return {
		content: [{ type: "text", text: piActivitySummary(args) }],
		details: {
			kind,
			title,
			...(typeof args.output === "string" ? { output: args.output } : {}),
			...(typeof args.diff === "string" ? { diff: args.diff } : {}),
		},
		isError: args.isError === true,
		terminate: true,
	};
}

function titleText(args) {
	const kind = typeof args.kind === "string" ? args.kind : "tool";
	const title = typeof args.title === "string" ? args.title : "";
	if (kind === "edit") {
		const verb = args.op === "create" ? "create" : args.op === "delete" ? "delete" : "edit";
		return title ? `${verb} ${title}` : verb;
	}
	if (kind === "bash") return title ? `$ ${title}` : "$";
	if (kind === "read" && args.directory === true) return title ? `ls ${title}` : "ls";
	if (kind === "read") {
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;
		const range =
			offset !== undefined ? ` [${offset}${limit !== undefined ? `:${offset + limit - 1}` : ""}]` : "";
		return `${title ? `read ${title}` : "read"}${range}`;
	}
	if (kind === "grep") return title ? `grep ${title}` : "grep";
	if (kind === "find") return title ? `find ${title}` : "find";
	if (kind === "web_search") return title ? `web_search ${title}` : "web_search";
	if (kind === "fetch") return title ? `fetch ${title}` : "fetch";
	return title ? `${kind} ${title}` : kind;
}

function clip(lines, expanded, keep) {
	if (expanded || lines.length <= PREVIEW_LINES) return { shown: lines, hidden: 0 };
	if (keep === "end") return { shown: lines.slice(-PREVIEW_LINES), hidden: lines.length - PREVIEW_LINES };
	return { shown: lines.slice(0, PREVIEW_LINES), hidden: lines.length - PREVIEW_LINES };
}

function bodyLines(args, expanded) {
	const error = args.isError === true;
	const output = typeof args.output === "string" ? args.output : "";
	const diff = typeof args.diff === "string" ? args.diff : "";
	if (error && output) {
		const clipped = clip(splitBody(output), expanded, "end");
		return { lines: clipped.shown.map((text) => ({ role: "error", text })), hidden: clipped.hidden };
	}
	if (!error && diff) {
		const clipped = clip(splitBody(diff), expanded, "start");
		return {
			lines: clipped.shown.map((text) => ({
				role: text.startsWith("+") ? "add" : text.startsWith("-") ? "remove" : text.startsWith(" ") ? "context" : "output",
				text,
			})),
			hidden: clipped.hidden,
		};
	}
	if (output) {
		const clipped = clip(splitBody(output), expanded, args.kind === "bash" ? "end" : "start");
		return { lines: clipped.shown.map((text) => ({ role: "output", text })), hidden: clipped.hidden };
	}
	return { lines: [], hidden: 0 };
}

function splitBody(text) {
	if (!text) return [];
	const body = text.endsWith("\n") ? text.slice(0, -1) : text;
	return body.length ? body.split("\n") : [];
}

/** Plain lines for the card. `expanded` shows the whole body. */
export function piActivityLines(args, expanded = false) {
	const source = args && typeof args === "object" ? args : {};
	const lines = [{ role: "title", text: titleText(source) }];
	const body = bodyLines(source, expanded);
	lines.push(...body.lines);
	if (body.hidden > 0) lines.push({ role: "muted", text: `… (${body.hidden} more lines)` });
	return lines;
}

function paint(line, theme) {
	const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_name, text) => text;
	const bold = typeof theme?.bold === "function" ? theme.bold.bind(theme) : (text) => text;
	if (line.role === "title") return fg("toolTitle", bold(line.text));
	if (line.role === "add") return fg("success", line.text);
	if (line.role === "remove" || line.role === "error") return fg("error", line.text);
	if (line.role === "muted" || line.role === "context") return fg("muted", line.text);
	return fg("toolOutput", line.text);
}

function wrapPlain(text, width) {
	if (width <= 0 || text.length <= width) return [text];
	const pieces = [];
	for (let i = 0; i < text.length; i += width) pieces.push(text.slice(i, i + width));
	return pieces;
}

function renderCard(args, theme, expanded, width) {
	const inner = Math.max(1, width);
	const out = [];
	for (const line of piActivityLines(args, expanded)) {
		for (const piece of wrapPlain(line.text, inner)) out.push(paint({ ...line, text: piece }, theme));
	}
	return out;
}

function cardComponent(state, args, theme, expanded) {
	if (!state.card) {
		state.card = {
			args,
			theme,
			expanded,
			invalidate() {},
			render(width) {
				return renderCard(this.args, this.theme, this.expanded, width);
			},
		};
	} else {
		state.card.args = args;
		state.card.theme = theme;
		state.card.expanded = expanded;
	}
	return state.card;
}

const PARAMETERS = {
	type: "object",
	additionalProperties: true,
	required: ["kind", "title"],
	properties: {
		kind: { type: "string" },
		title: { type: "string" },
		path: { type: "string" },
		command: { type: "string" },
		pattern: { type: "string" },
		query: { type: "string" },
		op: { type: "string" },
		diff: { type: "string" },
		output: { type: "string" },
		isError: { type: "boolean" },
		directory: { type: "boolean" },
		offset: { type: "number" },
		limit: { type: "number" },
	},
};

function syncArm(pi, provider) {
	if (provider !== "grok" && provider !== "grok-sdk") {
		if (!provider) return;
		const active = pi.getActiveTools();
		if (active.includes(PI_GROK_ACTIVITY)) {
			pi.setActiveTools(active.filter((name) => name !== PI_GROK_ACTIVITY));
		}
		armPiGrokActivity(false);
		return;
	}
	const active = pi.getActiveTools();
	if (!active.includes(PI_GROK_ACTIVITY)) pi.setActiveTools([...active, PI_GROK_ACTIVITY]);
	armPiGrokActivity(pi.getActiveTools().includes(PI_GROK_ACTIVITY));
}

/**
 * Register the display tool. Call only on Pi. OMP must not: its cards are the
 * stamped read/bash/edit calls, and this tool would sit in that registry too.
 */
export function registerPiGrokActivity(pi) {
	pi.registerTool({
		name: PI_GROK_ACTIVITY,
		label: "Grok",
		description: "Shows a Grok tool that already finished. It does not read files or run commands.",
		parameters: PARAMETERS,
		exposure: "direct",
		defaultActive: false,
		executionMode: "parallel",
		annotations: { readOnlyHint: true, idempotentHint: true },
		prepareLoadout() {
			return { hiddenDeclarations: [PI_GROK_ACTIVITY] };
		},
		execute(_toolCallId, params) {
			return Promise.resolve(piActivityExecution(params));
		},
		renderCall(args, theme, context) {
			return cardComponent(context?.state ?? {}, args, theme, context?.expanded === true);
		},
		renderResult() {
			// The call already drew the body from its arguments.
			return { invalidate() {}, render() { return []; } };
		},
	});
	pi.on("before_agent_start", (_event, ctx) => {
		syncArm(pi, ctx?.model?.provider);
	});
}
