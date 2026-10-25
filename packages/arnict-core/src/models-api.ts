// ABOUTME: Reads the live /v1/models id list with the same key chat completions uses.
// ABOUTME: Ids feed arnictModelsFromModelIds, which adds names, windows, and published rates.

import { loadArnictApiKey } from "./auth.js";
import { ArnictApiError, arnictApiErrorFromResponse } from "./errors.js";
import { arnictBaseUrl } from "./stream.js";

export async function fetchArnictModelIds(
  options: { apiKey?: string; baseUrl?: string; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiKey = options.apiKey ?? (await loadArnictApiKey()).apiKey;
  const base = (options.baseUrl ?? arnictBaseUrl()).replace(/\/$/, "");
  let response: Response;
  try {
    response = await fetchImpl(`${base}/models`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ArnictApiError(
      `Arnict models request failed: ${(error instanceof Error ? error.message : "network error").slice(0, 300)}`,
    );
  }
  if (!response.ok) throw await arnictApiErrorFromResponse(response, apiKey);
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ArnictApiError("Arnict models response was not JSON");
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new ArnictApiError("Arnict models response was not JSON");
  const ids: string[] = [];
  for (const entry of data) {
    const id = (entry as { id?: unknown } | null)?.id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}
