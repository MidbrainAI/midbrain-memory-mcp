// Dev shim — re-exports from source tree.
// In production, the installer copies dist/midbrain-shared.mjs (the bundle) instead.
export { MidbrainApi } from '../../shared/midbrain-api.mjs';
export { makeLogger, logFile, logDir } from '../../shared/logger.mjs';
export { homeRelativePath } from '../../shared/diagnostics.mjs';
export { buildCaptureMetadata } from '../../shared/capture-metadata.mjs';
export { getClient } from '../../shared/clients/registry.mjs';
export { hookProjectDir, logProjectFallback } from '../../shared/project-dir.mjs';
export { extractInjectedPkIds, formatPkContext, isPkInjectionEnabled, stripInjectedContext, scrubInjectedPkContext } from '../../shared/pk-inject.mjs';
export { loadIdentityContext, scrubIdentityContext } from '../../shared/identity-context.mjs';
