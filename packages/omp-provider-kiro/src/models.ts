// ABOUTME: Projects the kiro-core catalog onto OMP's provider-model configuration.

import type { Model } from "@oh-my-pi/pi-ai";
import { getKiroEndpoints, type KiroModel, kiroCompactionTarget, kiroStandardContextWindow } from "ns-kiro-core";

/** The subset of OMP's `ProviderModelConfig` this provider fills in. */
export interface OmpKiroModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: Model["thinking"];
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** The window OMP runs the model in by default: the vendor's standard-price window. */
  contextWindow: number;
  /**
   * Kiro's full window, present only when it exceeds {@link contextWindow}.
   * OMP records the pair as standard and extended tiers and widens to this one
   * only when `extendedContext` is on or a `compaction.modelThresholds` entry
   * for the model reaches past the standard window.
   */
  maxContextWindow?: number;
  maxTokens: number;
  /**
   * Wire id Kiro accepts, when it differs from {@link id}. Request time needs
   * this exact catalog id — a model absent from kiro-core's bootstrap list
   * would otherwise fall back to guessing the wire id from the dash-spelled
   * local `id`, which Kiro rejects as `INVALID_MODEL_ID`.
   */
  kiroModelId: string;
  /** Region this row was projected for, when a local session was available. */
  kiroRegion?: string;
  /** Profile stamped from that session. Request time falls back to the live credential. */
  kiroProfileArn?: string;
  baseUrl?: string;
  /** Catalog schema this model's structured effort/thinking fields derive from. */
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
  /**
   * Relative billing weight, when kiro-cli published one. Carried through
   * because `cost` cannot express it: Kiro bills in credits and publishes no
   * per-token prices, so `cost` stays zero and this is what distinguishes an
   * expensive model from a cheap one.
   */
  rateMultiplier?: number;
  rateUnit?: string;
}

/**
 * The smallest window whose OMP default compaction threshold reaches
 * `threshold`.
 *
 * Mirrors OMP's default compaction rule (oh-my-pi `pi-agent-core`
 * `compaction.ts`, `effectiveReserveTokens` / `resolveThresholdTokens`): OMP
 * holds back `max(floor(0.15·W), 16384)` of a window `W` and compacts at the
 * remainder. Registering a model at the window this returns makes OMP's own
 * default threshold land exactly on the compaction target — 176,470 for the
 * 150,000 Claude target.
 */
export function ompWindowForThreshold(threshold: number): number {
  const reaches = (window: number) => window - Math.max(Math.floor(window * 0.15), 16_384) >= threshold;
  let window = Math.max(Math.ceil(threshold / 0.85), threshold);
  while (!reaches(window)) window += 1;
  while (window > 1 && reaches(window - 1)) window -= 1;
  return window;
}

export function toOmpModelConfig(model: KiroModel): OmpKiroModelConfig {
  // OMP compacts at a share of `contextWindow`, so a model is registered at
  // the window whose default threshold matches where the model should
  // compact: a vendor's standard-price window when one exists, otherwise the
  // window sized for the per-model compaction target (176,470 for the 150,000
  // Claude target). Kiro's full window stays available as OMP's opt-in
  // extended tier via `extendedContext` or a `compaction.modelThresholds`
  // entry past the standard window.
  const target = kiroCompactionTarget(model);
  const standardWindow =
    target !== undefined
      ? Math.min(ompWindowForThreshold(target), model.contextWindow)
      : kiroStandardContextWindow(model);
  return {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.efforts?.length
      ? {
          thinking: {
            mode: "effort",
            efforts: [...model.efforts],
            ...(model.supportsSummarizedThinking ? { supportsDisplay: true } : {}),
          } as Model["thinking"],
        }
      : {}),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: standardWindow,
    ...(standardWindow < model.contextWindow ? { maxContextWindow: model.contextWindow } : {}),
    maxTokens: model.maxTokens,
    kiroModelId: model.kiroModelId,
    ...(model.additionalModelRequestFieldsSchema
      ? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
      : {}),
    ...(model.rateMultiplier !== undefined ? { rateMultiplier: model.rateMultiplier } : {}),
    ...(model.rateUnit !== undefined ? { rateUnit: model.rateUnit } : {}),
  };
}

export function kiroBaseUrl(region: string): string {
  return getKiroEndpoints(region).runtime;
}
