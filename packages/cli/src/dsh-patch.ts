/**
 * `cordis.patch.yml` editing for the DSH provider plugins.
 *
 * The file is the user's patch layer: a top-level YAML array of loader patch
 * entries. ns-bridge owns one `- insert:` item per provider, and nothing else
 * in the file. These helpers are text-preserving: they append a missing item,
 * remove only the item they own, and toggle enablement without reparsing or
 * reformatting the rest of the file.
 *
 * Insert shape (four-space entries):
 *
 * ```yaml
 * - insert:
 *     - id: llm-kiro
 *       name: 'ns-dsh-llm-kiro'
 *       config:
 *         provider: kiro
 * ```
 *
 * Disable shape is a separate override entry, appended after the inserts —
 * the composer applies non-insert patches by id and skips every other key on
 * an insert patch, so `disabled:` beside `- insert:` is silently dropped and
 * the plugin would still load:
 *
 * ```yaml
 * - id: llm-kiro
 *   disabled: true
 * ```
 */

import type { ProviderName } from "./selection.js";

export const DSH_PLUGIN: Record<ProviderName, string> = {
  kiro: "ns-dsh-llm-kiro",
  devin: "ns-dsh-llm-devin",
  grok: "ns-dsh-llm-grok",
  arnict: "ns-dsh-llm-arnict",
  qoder: "ns-dsh-llm-qoder",
};

/** Loader id the profile addresses. */
export const DSH_ID: Record<ProviderName, string> = {
  kiro: "llm-kiro",
  devin: "llm-devin",
  grok: "llm-grok",
  arnict: "llm-arnict",
  qoder: "llm-qoder",
};

const HEADER = ["# ns-bridge provider routes. `ns-bridge install dsh --profile <name>` keeps this file."];

export type DshPluginState = "missing" | "on" | "off";

/** The provider's `- id:` row, without the enclosing insert item. */
interface Entry {
  start: number;
  end: number;
}

/** The override entry `- id: llm-<p>` with its body; carries the disable flag. */
interface Override {
  start: number;
  end: number;
  disabled: boolean;
}

/** The insert snippet for one provider, no trailing newline. */
export function renderDshBlock(provider: ProviderName): string {
  return [
    "- insert:",
    `    - id: ${DSH_ID[provider]}`,
    `      name: '${DSH_PLUGIN[provider]}'`,
    "      config:",
    `        provider: ${provider}`,
  ].join("\n");
}

export function dshPluginState(raw: string, provider: ProviderName): DshPluginState {
  const lines = split(raw);
  const entry = findEntry(lines, provider);
  if (!entry) return "missing";
  // A `disabled: true` beside `- insert:` predates the override form; the
  // composer ignores it, but reading it as off keeps old files honest.
  if (findInsert(lines, entry.start)?.disabled) return "off";
  return findOverride(lines, provider)?.disabled ? "off" : "on";
}

/**
 * Appended only when the provider's id is absent, so an item the user disabled
 * stays disabled and a customized item keeps its config. A profile template
 * starts the patch list as a bare `[]`; the first block takes that line's
 * place, because appending after it would put two root nodes in one document.
 */
export function ensureDshPlugin(raw: string, provider: ProviderName): string {
  const lines = split(raw);
  if (findEntry(lines, provider)) return raw;
  const block = renderDshBlock(provider);
  if (raw.trim() === "") return `${HEADER.join("\n")}\n${block}\n`;
  const emptyRoot = lines.findIndex((line) => line.trim() === "[]");
  if (emptyRoot >= 0) {
    lines[emptyRoot] = block;
    return `${lines.join("\n").replace(/\s+$/, "")}\n`;
  }
  const body = raw.replace(/\s+$/, "");
  return `${body}\n\n${block}\n`;
}

/**
 * Removes the provider's row. When it was alone under `- insert:`, the insert
 * item goes too; an item shared with other providers keeps its other rows.
 */
export function removeDshPlugin(raw: string, provider: ProviderName): string {
  const lines = split(raw);
  if (!findOverride(lines, provider) && !findEntry(lines, provider)) return raw;
  const override = findOverride(lines, provider);
  if (override) lines.splice(override.start, override.end - override.start);
  const entry = findEntry(lines, provider);
  if (entry) {
    const item = findInsert(lines, entry.start);
    if (item && countEntries(lines, item) === 1) {
      // Drop trailing blank lines with the item so removing the last one does
      // not leave a growing gap.
      let end = item.end;
      while (end < lines.length && lines[end].trim() === "") end += 1;
      lines.splice(item.start, end - item.start);
    } else {
      lines.splice(entry.start, entry.end - entry.start);
    }
  }
  const text = lines.join("\n").replace(/\s+$/, "");
  if (hasRootEntry(lines)) return `${text}\n`;
  // dsh requires the patch layer to parse as a top-level array; a file left
  // with only comments is a null document and fails to boot the profile.
  return `${text ? `${text}\n` : ""}[]\n`;
}

/**
 * Writes enablement as the composer reads it: a separate `- id:` override
 * entry, appended after the inserts. Disabling also strips a legacy
 * `disabled: true` beside `- insert:` (the composer ignores it there), so
 * files converge on the override form. Enabling removes the override.
 */
export function setDshPluginEnabled(raw: string, provider: ProviderName, enabled: boolean): string {
  const lines = split(raw);
  const entry = findEntry(lines, provider);
  if (!entry) return raw;
  let changed = false;

  const item = findInsert(lines, entry.start);
  if (item) {
    for (let index = item.end - 1; index >= item.start; index -= 1) {
      if (isDisabled(lines[index] ?? "")) {
        lines.splice(index, 1);
        changed = true;
      }
    }
  }

  const override = findOverride(lines, provider);
  if (enabled) {
    if (override) {
      lines.splice(override.start, override.end - override.start);
      changed = true;
    }
  } else if (!override || !override.disabled) {
    if (override) lines.splice(override.start, override.end - override.start);
    const body = lines.join("\n").replace(/\s+$/, "");
    return `${body}\n\n${[`- id: ${DSH_ID[provider]}`, "  disabled: true"].join("\n")}\n`;
  }
  if (!changed) return raw;
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

function split(raw: string): string[] {
  return raw.replace(/\r\n/g, "\n").split("\n");
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function findEntry(lines: readonly string[], provider: ProviderName): Entry | undefined {
  const id = `- id: ${DSH_ID[provider]}`;
  const start = lines.findIndex((line) => line.trim() === id);
  if (start < 0) return undefined;
  const indent = indentOf(lines[start] ?? "");
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (line.trim() === "" || indentOf(line) <= indent) break;
    end += 1;
  }
  return { start, end };
}

/** The nearest `- insert:` item above the entry, unless another list item intervenes. */
function findInsert(lines: readonly string[], entryStart: number): { start: number; end: number; disabled: boolean } | undefined {
  let start = -1;
  for (let index = entryStart - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (/^- insert:\s*$/.test(line)) {
      start = index;
      break;
    }
    if (line.trim() === "") continue;
    // Another row's body is still inside the same insert item; anything less
    // indented is a sibling key, a comment, or a different patch entry.
    if (indentOf(line) >= 4) continue;
    return undefined;
  }
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && /^\s+\S/.test(lines[end] ?? "")) end += 1;
  const disabled = lines.slice(start + 1, end).some(isDisabled);
  return { start, end, disabled };
}

/** The top-level `- id: llm-<p>` override entry, which is what toggles the plugin. */
function findOverride(lines: readonly string[], provider: ProviderName): Override | undefined {
  const start = lines.findIndex((line) => /^- id: /.test(line) && line.slice(6).trim() === DSH_ID[provider]);
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (lines[end].trim() === "" || indentOf(lines[end]) > 0)) end += 1;
  while (end > start + 1 && lines[end - 1]?.trim() === "") end -= 1;
  const disabled = lines.slice(start + 1, end).some(isDisabled);
  return { start, end, disabled };
}

function countEntries(lines: readonly string[], item: { start: number; end: number }): number {
  let count = 0;
  for (let index = item.start + 1; index < item.end; index += 1) {
    if (/^\s*- id: /.test(lines[index] ?? "")) count += 1;
  }
  return count;
}

function isDisabled(line: string): boolean {
  return /^\s*disabled:\s*true\s*$/.test(line);
}

/** A top-level list item, which keeps the document a non-empty YAML array. */
function hasRootEntry(lines: readonly string[]): boolean {
  return lines.some((line) => /^-(?:\s|$)/.test(line));
}
