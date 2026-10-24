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
