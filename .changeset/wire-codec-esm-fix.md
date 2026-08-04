---
"@oxpulse/wire-codec": patch
---

Fix ESM bundler resolution: switch tsconfig to module/moduleResolution "node16" and add .js extensions to all relative imports in codec.ts.

The published dist/codec.js contained extensionless imports (`from "./dicts"`, `from "./envelope-v2"`, `from "./brands"`) that broke strict ESM consumers (Vite, SvelteKit, Node ESM). Root cause: `moduleResolution: "bundler"` allowed extensionless imports in TS source, and tsc preserved them in output. With `moduleResolution: "node16"`, tsc enforces explicit `.js` extensions in ESM output.

Closes #2845.
