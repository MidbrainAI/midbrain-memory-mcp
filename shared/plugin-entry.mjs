/**
 * Bundle entry point for the OpenCode plugin runtime.
 *
 * esbuild bundles this file and all its transitive dependencies into a
 * single dist/midbrain-shared.mjs. The OpenCode plugin (midbrain-memory.ts)
 * imports from this bundle at runtime.
 *
 * Only export what the plugin actually needs at runtime.
 */

export { MidbrainApi } from './midbrain-api.mjs';
export { makeDebugLogger } from './logger.mjs';
export { getClient } from './clients/registry.mjs';
