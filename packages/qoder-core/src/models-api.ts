// ABOUTME: The Qoder model list. The model server exposes no list endpoint, so
// the catalog comes from the bootstrap spec (the ids the CLI itself offers).

import type { ResolvedQoderAuth } from "./auth.js";
import { type QoderModelSpec, qoderBootstrapModels } from "./catalog.js";

export async function fetchQoderModels(
  _options: { auth?: ResolvedQoderAuth; signal?: AbortSignal } = {},
): Promise<QoderModelSpec[]> {
  return qoderBootstrapModels();
}
