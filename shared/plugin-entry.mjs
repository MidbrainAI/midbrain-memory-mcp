/**
 * Bundle entry point for the OpenCode and OpenClaw plugin runtimes.
 *
 * esbuild bundles this file and all its transitive dependencies into a
 * single dist/midbrain-shared.mjs. The OpenCode plugin (midbrain-memory.ts)
 * and the OpenClaw plugin (plugins/openclaw/index.js) import from this bundle
 * at runtime.
 *
 * Only export what the plugin actually needs at runtime.
 */

export { MidbrainApi } from './midbrain-api.mjs';
export { appendToCache } from './episodic-cache.mjs';
export { DEFAULT_API_BASE, resolveApiHost } from './api-host.mjs';
export { makeLogger, logFile, logDir } from './logger.mjs';
export { homeRelativePath } from './diagnostics.mjs';
export { buildCaptureMetadata } from './capture-metadata.mjs';
export { getClient } from './clients/registry.mjs';
export { extractInjectedPkIds, formatPkContext, isPkInjectionEnabled, stripInjectedContext, scrubInjectedPkContext } from './pk-inject.mjs';
