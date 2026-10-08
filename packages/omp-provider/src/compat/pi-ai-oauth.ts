/**
 * Build-time replacement for `@earendil-works/pi-ai/oauth`.
 *
 * ns-pi-provider's kiro module calls `registerOAuthProvider` best-effort so
 * Pi's `/login` lists it. On OMP, `pi.registerProvider(..., { oauth })`
 * already registers the OAuth provider (scoped to this extension's source id,
 * so it is cleaned up on reload). A second, unscoped global registration
 * would outlive the extension, so this is intentionally a no-op.
 */
export function registerOAuthProvider(_provider: unknown): void {
  // no-op on OMP — see module comment
}
