// ABOUTME: Rebuilds the core's model descriptor from the model a host hands back at request time.
// ABOUTME: Shared by every agent host (Pi, OMP) whose registry keeps its own copy of the model.

import { getCachedModels, type KiroModel } from "./models.js";

/** What a host's model carries back to the provider; Pi's and OMP's models both fit. */
export interface KiroHostModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number | null;
  maxTokens?: number | null;
  kiroModelId?: string;
  kiroProfileArn?: string;
  additionalModelRequestFieldsSchema?: Record<string, unknown>;
}

/**
 * A host's registry keeps its own model, built from the config the provider
 * registered, so the catalog entry is looked up again here rather than carried
 * through: the effort ladder and the request-fields schema decide effort
 * mapping, and a request must use the same ones the catalog advertised.
 *
 * Looks up the region's authenticated cache, not the static bootstrap list:
 * models discovered only through the authenticated catalog would otherwise
 * miss this lookup and fall through to guessing a wire id from the
 * dash-spelled local `id`, which Kiro rejects as `INVALID_MODEL_ID`.
 */
export function toKiroModelForHost(model: KiroHostModel, region: string): KiroModel {
  const known = getCachedModels(region).find((candidate) => candidate.id === model.id);
  return {
    ...(known ?? {
      id: model.id,
      // No fallback to `model.id`: that dash-spelled local id is not a valid
      // Kiro wire id. `""` is falsy, so `resolveKiroModel` runs its own
      // cache/bootstrap/dot-normalize resolution instead of being
      // short-circuited by a value that is really just `model.id` again.
      kiroModelId: model.kiroModelId ?? "",
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      cost: { ...model.cost },
      contextWindow: model.contextWindow ?? 200_000,
      maxTokens: model.maxTokens ?? 8_192,
    }),
    region,
    ...(model.kiroProfileArn ? { profileArn: model.kiroProfileArn } : {}),
    ...(model.additionalModelRequestFieldsSchema
      ? { additionalModelRequestFieldsSchema: model.additionalModelRequestFieldsSchema }
      : {}),
  };
}
