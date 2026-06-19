/**
 * Build-time injected defines.
 *
 * In the CDN bundle (esbuild.cdn.mjs), `__WIDGET_VERSION__` is replaced
 * at build time with the `version` field from package.json via esbuild's
 * `define` option. At runtime this is a string literal, never a global.
 *
 * For the tsc (npm) build the tsconfig.json targets `lib: ["DOM"]` and does
 * not run esbuild define substitution, so we declare it here as a global
 * ambient constant so `tsc --noEmit` stays clean.
 */
declare const __WIDGET_VERSION__: string;
