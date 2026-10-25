// ABOUTME: Standard-price context windows for Kiro models whose vendor bills long prompts at a premium.
// ABOUTME: Hosts compact inside this window by default, so a turn never crosses into the dearer tier.

/**
 * Prompt size, in input tokens, above which the vendor bills the whole request
 * at its long-context rate, keyed by local model id.
 *
 * Only vendor-published tiers belong here, each checked against Kiro's own
 * billing:
 *
 * - GPT-5.6 Luna, Sol and Terra: OpenAI prices prompts over 272K input tokens
 *   at its long-context rate (2x input) for the full request
 *   (https://developers.openai.com/api/docs/pricing,
 *   https://developers.openai.com/api/docs/models/gpt-5.6-luna), and Codex
 *   ships all three with a 272K `context_window` against an 872K maximum
 *   (openai/codex `codex-rs/models-manager/models.json`). For luna, Kiro's
 *   credits double from about the same size: see `KIRO_UNCAPPED_MODELS` in
 *   `cache-from-credits.ts`, measured from the usage ledger. Sol and Terra have
 *   no ledger turns yet, so their Kiro tier is the vendor's, unmeasured.
 *
 * Claude models are absent on purpose. Anthropic bills Claude 4.6 and later
 * across the full 1M window at the standard rate
 * (https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing),
 * and Kiro's credits for `claude-sonnet-5-5` stay flat past 340K prompt tokens.
 */
export const KIRO_LONG_CONTEXT_THRESHOLDS: Readonly<Record<string, number>> = {
  "gpt-5-6-luna": 272_000,
  "gpt-5-6-sol": 272_000,
  "gpt-5-6-terra": 272_000,
};

/**
 * Where a Claude model whose window runs past 200K should compact, in input
 * tokens.
 *
 * Anthropic bills Claude 4.6 and later flat across the 1M window
 * (https://platform.claude.com/docs/en/about-claude/pricing#long-context-pricing),
 * so there is no price cliff to stop before — but Kiro credits grow linearly
 * with prompt size even when the prompt is cached. Measured from
 * `~/.ns-bridge/usage` (`claude-sonnet-5-5`, 3,810 turns, 2026-10-21..24):
 * credits ≈ -0.035 + 0.0235·newK + 0.00289·cachedK + 0.30·outputK (R² ≈ 0.81).
 * A warm turn costs ~0.50 credits at 150K against ~2.3–2.55 extrapolated at
 * 850K, so a session compacting at 150K costs ~2.6–2.9x less than one
 * compacting at 850K — OMP's default on a 1M window — counting the summary
 * call and the cold first turn after compaction. No ledger turn went above
 * ~347K, so the 850K figures are extrapolated. Anthropic's own server-side
 * compaction (`compact_20260112`) defaults its trigger to 150,000 input tokens
 * (https://platform.claude.com/docs/en/build-with-claude/compaction-threshold).
 */
export const KIRO_CLAUDE_COMPACTION_TARGET = 150_000;

/**
 * The compaction target for one model, or `undefined` when it has none: hosts
 * compact at their own default inside the window they are given.
 *
 * Only Claude models with a window past 200K carry a target. "auto" routes to
 * whatever model the service picks, so it cannot promise one either.
 */
export function kiroCompactionTarget(model: { id: string; contextWindow: number }): number | undefined {
  if (!model.id.startsWith("claude-")) return undefined;
  if (model.contextWindow <= 200_000) return undefined;
  if (KIRO_CLAUDE_COMPACTION_TARGET >= model.contextWindow) return undefined;
  return KIRO_CLAUDE_COMPACTION_TARGET;
}

/**
 * The window a host should run `model` in when extended context is off: its
 * vendor's standard-price window, or the full Kiro window when no premium tier
 * starts inside it.
 */
export function kiroStandardContextWindow(model: { id: string; contextWindow: number }): number {
  const threshold = Object.hasOwn(KIRO_LONG_CONTEXT_THRESHOLDS, model.id)
    ? KIRO_LONG_CONTEXT_THRESHOLDS[model.id]
    : undefined;
  return threshold !== undefined && threshold < model.contextWindow ? threshold : model.contextWindow;
}
