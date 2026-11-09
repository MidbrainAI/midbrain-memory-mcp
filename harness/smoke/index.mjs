/** Stable API for callers that extend package preparation and client selection. */
export const SMOKE_API_VERSION = 1;
export {runDrySmoke,classifyNativeProbe,verifySmokeRequests} from './lib/dry-smoke.mjs';
export {freezeReleaseCandidate,fileHash,assertCandidate} from './lib/candidate.mjs';
export {TOOL_CONTRACTS} from './lib/tool-contracts.mjs';
export {renderDrySmokeHtml,renderDrySmokeJUnit} from './lib/dry-smoke-report.mjs';
export {renderSmokeMarkdown} from './lib/markdown.mjs';
export {DRY_SMOKE_ROWS,DRY_SMOKE_CLIENTS,drySmokeExitCode} from './lib/dry-smoke-policy.mjs';
