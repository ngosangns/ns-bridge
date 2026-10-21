// ABOUTME: The compaction budget every host derives from one catalog entry.
// ABOUTME: One formula, so a refresh writes the same numbers each host compacts at.

/**
 * Output tokens held back from a context window before compaction triggers.
 *
 * This is Pi's built-in `reserveTokens`, the one amount a host already treats
 * as "held back" without clipping a normal turn. It is a reservation, not the
 * completion ceiling: reporting a 128k ceiling as reserved, on top of the
 * Harness headroom, compacts a 256k window near 62k.
 */
export const COMPACTION_RESERVE_FLOOR = 16_384;

/** What one catalog entry is worth to compaction. Both numbers come from the entry itself. */
export interface CompactionBudgetInput {
  contextWindow: number;
  maxTokens: number;
}

/**
 * The compaction budget written next to a catalog entry and read back by hosts.
 *
 * `reserveTokens` is what a host holds back. `thresholdTokens` is where
 * compaction triggers: the window minus that reservation.
 */
export interface CompactionBudget {
  reserveTokens: number;
  thresholdTokens: number;
}

/**
 * The compaction budget for one catalog entry, or `undefined` when the entry
 * has no usable window.
 *
 * The reservation is the smaller of the catalog's completion ceiling and
 * {@link COMPACTION_RESERVE_FLOOR}. A ceiling at or below the floor is already
 * a fair reservation, so it is kept whole. A window no larger than the floor
 * cannot hold less than its ceiling, so the ceiling is kept there too.
 *
 * Non-positive or non-finite input is not a budget. Callers leave the field
 * off the catalog entry rather than invent one.
 */
export function compactionBudget(model: CompactionBudgetInput): CompactionBudget | undefined {
  const { contextWindow, maxTokens } = model;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return undefined;
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) return undefined;

  const ceiling = Math.floor(maxTokens);
  const reserveTokens =
    contextWindow <= COMPACTION_RESERVE_FLOOR ? ceiling : Math.max(1, Math.min(ceiling, COMPACTION_RESERVE_FLOOR));
  return { reserveTokens, thresholdTokens: contextWindow - reserveTokens };
}
