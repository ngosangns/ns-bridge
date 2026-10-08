/**
 * Build-time replacement for `@earendil-works/pi-coding-agent`.
 * ns-pi-provider only imports types from it; an empty module makes esbuild
 * fail loudly if a runtime import ever appears.
 */
export {};
