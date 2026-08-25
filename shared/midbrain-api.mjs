/**
 * shared/midbrain-api.mjs
 *
 * HTTP client for the MidBrain Memory API.
 * Handles authentication, endpoint routing, and both read-path (GET)
 * and write-path (POST episodic) operations. Also exposes the account
 * management surface (/api/v1/account: agents + keys) for instances
 * constructed with the user API key via MidbrainApi.createForUser().
 *
 * Episodic write resilience: when a POST to the episodic endpoint fails,
 * the entry is appended to a local NDJSON cache file. On the next
 * successful POST, all cached entries are flushed. Entries that still
 * fail during flush are re-cached so nothing is lost.
 *
 * Usage:
 *   const api = await MidbrainApi.create(getClient('opencode'), projectDir);
 *   const results = await api.searchSemantic({ query: '...', limit: 10 });
 *   api.storeEpisodic(text, 'user', logger);
 *
 * Node 20 + Bun compatible. No npm deps (uses native fetch).
 */

import { createHash } from "crypto";

import { appendToCache, beginCacheFlush, finishCacheFlush, hasCachedEntries } from "./episodic-cache.mjs";
import { DEFAULT_API_BASE, resolveApiHost } from "./api-host.mjs";
import { PKG_NAME, PKG_VERSION } from "./clients/utils.mjs";

const API_BASE_FROM_ENV = Boolean(process.env.MIDBRAIN_API_URL);
const API_BASE = process.env.MIDBRAIN_API_URL || DEFAULT_API_BASE;
const API_BASE_SCOPE = API_BASE_FROM_ENV ? "environment" : "default";
const API_BASE_SOURCE = API_BASE_FROM_ENV ? "env:MIDBRAIN_API_URL" : "default";

function buildEndpoints(apiBase) {
  const apiV1 = `${apiBase}/api/v1`;
  return {
    SEARCH_SEMANTIC:   `${apiV1}/memories/search/semantic`,
    SEARCH_LEXICAL:    `${apiV1}/memories/search/lexical`,
    SEARCH_PROCEDURAL: `${apiV1}/memories/search/procedural`,
    EPISODIC:          `${apiV1}/memories/episodic`,
    SEMANTIC_FILES:    `${apiV1}/memories/semantic/files`,
    PROCEDURAL:        `${apiV1}/memories/procedural`,
  };
}

// Compatibility-only static endpoints retain the v0.4.7 import-time behavior.
const ENDPOINTS = buildEndpoints(API_BASE);

const PK_DEFAULT_LIMIT    = 5;
const PK_DEFAULT_MIN_SCORE = 0.5;
const PK_DEFAULT_TIMEOUT_MS = 2000;

const DEFAULT_SEARCH_LIMIT = 10;
// Base UA product token, e.g. "midbrain-memory-mcp/0.4.8". Per-instance
// #userAgent appends the resolved client id (e.g. "opencode") as a second
// space-separated UA-stack token -- see MidbrainApi constructor and #headers.
const PRODUCT_USER_AGENT = `${PKG_NAME}/${PKG_VERSION}`;
const ERROR_BODY_MAX = 200;

/**
 * Bound and sanitize an account-API error body before surfacing it: cap the
 * length and strip bearer tokens / sk-style secrets so a server error can never
 * echo a credential fragment through MCP output.
 * @param {string} text
 * @returns {string} A short, safe `: <detail>` suffix, or "".
 */
function sanitizeErrorBody(text) {
  if (!text) return "";
  let clean = String(text)
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\b(sk|mb|pk)[-_][A-Za-z0-9._-]{6,}/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (clean.length > ERROR_BODY_MAX) clean = `${clean.slice(0, ERROR_BODY_MAX)}…`;
  return `: ${clean}`;
}

async function inspectCredentialScopes(client, projectDir, result) {
  if (typeof client.inspectCredentialScopes !== "function") {
    return { entries: [], shadowNote: null };
  }
  try {
    return await client.inspectCredentialScopes(projectDir, result);
  } catch {
    return { entries: [], shadowNote: null };
  }
}

export class MidbrainApi {
  #key;
  #source;
  #cacheScope;
  #apiBase;
  #apiBaseScope;
  #apiBaseSource;
  #keyScope;
  #credentialScopes;
  #credentialShadowNote;
  #endpoints;
  #userAgent;

  /**
   * @param {string} key API key.
   * @param {string} source Debug label for key origin.
   * @param {{apiBase?: string, apiBaseScope?: string, apiBaseSource?: string,
   *   keyScope?: string, credentialScopes?: object[],
   *   credentialShadowNote?: string|null, clientId?: string}} [options]
   *   `clientId` (e.g. "opencode", "codex", "generic") is appended as a
   *   second UA-stack token -- see #headers.
   */
  constructor(key, source, options = {}) {
    this.#key = key;
    this.#source = source;
    this.#apiBase = options.apiBase || API_BASE;
    this.#apiBaseScope = options.apiBaseScope || API_BASE_SCOPE;
    this.#apiBaseSource = options.apiBaseSource || API_BASE_SOURCE;
    this.#keyScope = options.keyScope;
    this.#credentialScopes = options.credentialScopes || [];
    this.#credentialShadowNote = options.credentialShadowNote || null;
    this.#endpoints = buildEndpoints(this.#apiBase);
    this.#userAgent = options.clientId ? `${PRODUCT_USER_AGENT} ${options.clientId}` : PRODUCT_USER_AGENT;
    this.#cacheScope = createHash("sha256")
      .update(`${this.#apiBase}\0${key}`)
      .digest("hex");
  }

  /**
   * Shared header builder for every request to the memory/account API.
   * @param {{json?: boolean}} [opts] Set `json: true` to add Content-Type
   *   for a JSON request body.
   * @returns {Record<string, string>}
   */
  #headers({ json = false } = {}) {
    const headers = {
      Authorization: `Bearer ${this.#key}`,
      "X-Midbrain-User-Agent": this.#userAgent,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  /**
   * Factory: resolve key from a client adapter, return ready-to-use instance.
   * @param {import('./clients/base.mjs').BaseClient} client
   * @param {string} [projectDir]
   * @param {{clientLabel?: string}} [opts] `clientLabel` overrides `client.id`
   *   as the UA client token -- used by clients whose reported identity can
   *   differ at runtime from their static adapter id (e.g. Claude Code
   *   running inside a NanoClaw container reports "nanoclaw", not "claude").
   */
  static async create(client, projectDir, { clientLabel } = {}) {
    const result = await client.resolveKey(projectDir, { includeScope: true });
    if (!result) throw new Error("No API key configured. Run: npx midbrain-memory-mcp install");
    const host = await resolveApiHost({
      clientId: client.id,
      projectDir,
      keyScope: result.scope,
    });
    const credentialState = await inspectCredentialScopes(client, projectDir, result);
    return new MidbrainApi(result.key, result.source, {
      apiBase: host.url,
      apiBaseScope: host.scope,
      apiBaseSource: host.source,
      keyScope: result.scope,
      credentialScopes: credentialState.entries,
      credentialShadowNote: credentialState.shadowNote,
      clientId: clientLabel || client.id,
    });
  }

  /**
   * Factory for account-level operations: resolves the account USER API key
   * (global-only) from a client adapter. The returned instance is intended for
   * the account methods (listAgents/createAgent/createKey/...), which are
   * authenticated with the user key rather than an agent key.
   *
   * @param {import('./clients/base.mjs').BaseClient} client
   */
  static async createForUser(client) {
    const result = await client.resolveUserKey();
    if (!result) {
      throw new Error(
        "No user API key configured. Set one with the set_user_api_key tool " +
        "or `npx midbrain-memory-mcp@latest user-key set`.",
      );
    }
    // The user key is a global credential, so resolve the host at global scope
    // (never a project host). Binding the host here means account requests go
    // to the user's configured origin instead of the default, so a self-hosted
    // or pinned user never leaks their account credential to memory.midbrain.ai.
    const host = await resolveApiHost({ clientId: client.id, keyScope: "global" });
    return new MidbrainApi(result.key, result.source, {
      apiBase: host.url,
      apiBaseScope: host.scope,
      apiBaseSource: host.source,
      keyScope: "global",
      clientId: client.id,
    });
  }

  /** Key source label (for debug logging). */
  get keySource() { return this.#source; }

  /** Key resolution scope selected by BaseClient.resolveKey(). */
  get keyScope() { return this.#keyScope; }
  get credentialScopes() { return this.#credentialScopes; }
  get credentialShadowNote() { return this.#credentialShadowNote; }
  get cacheScope() { return this.#cacheScope; }

  /** Effective API base and its resolution metadata. */
  get effectiveApiBase() { return this.#apiBase; }
  get apiBaseScope() { return this.#apiBaseScope; }
  get apiBaseSource() { return this.#apiBaseSource; }

  // Instance endpoint getters. Server consumers must use these, not statics.
  get SEARCH_SEMANTIC() { return this.#endpoints.SEARCH_SEMANTIC; }
  get SEARCH_LEXICAL() { return this.#endpoints.SEARCH_LEXICAL; }
  get SEARCH_PROCEDURAL() { return this.#endpoints.SEARCH_PROCEDURAL; }
  get EPISODIC() { return this.#endpoints.EPISODIC; }
  get SEMANTIC_FILES() { return this.#endpoints.SEMANTIC_FILES; }
  get PROCEDURAL() { return this.#endpoints.PROCEDURAL; }

  /**
   * @deprecated Retained for compatibility only. Credential fragments must
   * never be written to user-facing output or shipped logs.
   */
  get keyFingerprint() {
    return this.#key.length >= 4 ? `...${this.#key.slice(-4)}` : '****';
  }

  /**
   * Authenticated GET request with query params. Falls back to POST on 404/405
   * unless `allowPostFallback` is false (read-only callers such as the
   * diagnostics probe must never let a GET escalate to a write-method request
   * against a write endpoint).
   * @param {string} endpoint  Full URL.
   * @param {Record<string, string|number|undefined>} [params]
   * @param {{allowPostFallback?: boolean}} [opts]
   * @returns {Promise<any>} Parsed JSON.
   */
  async fetch(endpoint, params = {}, { allowPostFallback = true } = {}) {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    // Never log the resolved key path (it can embed a username); the scope
    // label is sufficient for debugging.
    console.error(`[API] url=${url} key_scope=${this.#keyScope || "unknown"}`);

    let response = await fetch(url.toString(), {
      method: "GET",
      headers: this.#headers(),
    });

    // GET->POST fallback: if GET endpoint not yet deployed, retry with legacy POST.
    if (allowPostFallback && (response.status === 404 || response.status === 405)) {
      console.error(`[API] GET ${url.toString()} returned ${response.status}, retrying with POST`);
      response = await fetch(endpoint, {
        method: "POST",
        headers: this.#headers({ json: true }),
        body: JSON.stringify(params),
      });
    }

    console.error(`[API] status=${response.status}`);

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error(
          `API 401 (auth failed): host=${this.#apiBase} key_scope=${this.#keyScope || "unknown"} — run memory_diagnostics for details`,
        );
      }
      const body = await response.text().catch(() => "(no body)");
      throw new Error(`API ${response.status}: ${body}`);
    }
    return response.json();
  }

  /**
   * POST an episodic memory. Callers may ignore the returned promise for
   * fire-and-forget capture, or await its boolean result for retry decisions.
   *
   * Resilience: on failure the entry is appended to a local NDJSON cache.
   * On the next successful call, all cached entries are flushed (best-effort).
   *
   * @param {string} text
   * @param {"user"|"assistant"} role
   * @param {{info: function(string): void, debug: function(string): void,
   *   warn: function(string): void, error: function(string): void}} logger
   *   Leveled logger (see shared/logger.mjs).
   * @param {Record<string, string>} [memoryMetadata] - Optional metadata (e.g. { client: "codex" }).
   */
  async storeEpisodic(text, role, logger, memoryMetadata) {
    logger.info(`STORE: role=${role} textLen=${text.length}`);
    const ok = await this.#postEpisodic(text, role, memoryMetadata, logger);
    if (!ok) {
      appendToCache({ text, role, memory_metadata: memoryMetadata }, this.#cacheScope);
      logger.debug("STORE: cached entry for later flush");
      return false;
    }
    // Success — flush any previously cached entries.
    if (hasCachedEntries(this.#cacheScope)) {
      await this.#flushCache(logger);
    }
    return true;
  }

  /**
   * Raw POST to the episodic endpoint. Returns true on 2xx, false otherwise.
   * Never throws.
   */
  async #postEpisodic(text, role, memoryMetadata, logger) {
    const binding = `host=${this.#apiBase} key_scope=${this.#keyScope || "unknown"}`;
    if (process.env.MIDBRAIN_SIMULATE_OFFLINE === "1") {
      logger.warn(`STORE ERROR: ${binding} simulated offline (MIDBRAIN_SIMULATE_OFFLINE=1)`);
      return false;
    }
    try {
      const response = await fetch(this.#endpoints.EPISODIC, {
        method: "POST",
        headers: this.#headers({ json: true }),
        body: JSON.stringify({ text, role, memory_metadata: memoryMetadata }),
      });
      if (!response.ok) {
        await response.text().catch(() => undefined);
        logger.error(`STORE ERROR: status=${response.status} ${binding}`);
        return false;
      }
      logger.debug(`STORED: status=${response.status}`);
      return true;
    } catch {
      logger.error(`STORE ERROR: ${binding} network-error`);
      return false;
    }
  }

  /**
   * Attempt to POST all cached entries. Entries that still fail are
   * re-written to the cache file so they survive for the next attempt.
   */
  async #flushCache(logger) {
    const flush = beginCacheFlush(this.#cacheScope);
    if (!flush.claimed) return;
    const entries = flush.entries;
    if (entries.length === 0) {
      finishCacheFlush(flush, []);
      return;
    }
    logger.info(`CACHE FLUSH: ${entries.length} cached entries`);
    const survivors = [];
    for (const entry of entries) {
      const ok = await this.#postEpisodic(
        entry.text, entry.role, entry.memory_metadata, logger,
      );
      if (!ok) survivors.push(entry);
    }
    if (survivors.length > 0) {
      finishCacheFlush(flush, survivors);
      logger.warn(`CACHE FLUSH: ${survivors.length} entries still pending`);
    } else {
      finishCacheFlush(flush, []);
      logger.info("CACHE FLUSH: all entries flushed successfully");
    }
  }

  /**
   * Search procedural knowledge entries by semantic similarity.
   * Hard timeout via AbortSignal.timeout — never throws, returns [] on any failure.
   *
   * @param {object} opts
   * @param {string}   opts.query       - Natural language search query.
   * @param {number}   [opts.limit]     - Max results (default 5).
   * @param {number}   [opts.minScore]  - Minimum similarity threshold (default 0.5).
   * @param {number[]} [opts.excludeIds] - Entry ids to skip (session dedup).
   * @param {number}   [opts.timeoutMs] - Abort timeout in ms (default 2000).
   * @returns {Promise<Array<{id:number,title:string,content:string,source_ids:number[],score:number}>>}
   */
  async searchProcedural({ query, limit, minScore, excludeIds, timeoutMs } = {}) {
    try {
      const url = new URL(this.#endpoints.SEARCH_PROCEDURAL);
      url.searchParams.set("query", query);
      url.searchParams.set("limit",     String(limit     ?? PK_DEFAULT_LIMIT));
      url.searchParams.set("min_score", String(minScore  ?? PK_DEFAULT_MIN_SCORE));
      for (const id of (excludeIds ?? [])) {
        url.searchParams.append("exclude_ids", String(id));
      }

      const response = await fetch(url.toString(), {
        method:  "GET",
        headers: this.#headers(),
        signal:  AbortSignal.timeout(timeoutMs ?? PK_DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) return [];
      const data = await response.json();
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  // --- Account management (user-key authenticated) ---
  //
  // These operate on /api/v1/account and require this instance to hold the
  // account USER API key (see MidbrainApi.createForUser). They let the caller
  // manage agents and agent API keys.

  /** Account surface (/api/v1/account) derived from THIS instance's base. */
  get #accountBase() {
    return `${this.#apiBase}/api/v1/account`;
  }

  /**
   * Authenticated JSON request against the account surface.
   * @param {string} method   HTTP method.
   * @param {string} suffix   Path under /api/v1/account (e.g. "/agents").
   * @param {object} [body]   JSON body for write requests.
   * @returns {Promise<any>}  Parsed JSON, or null for 204.
   */
  async #accountRequest(method, suffix, body) {
    const headers = this.#headers({ json: body !== undefined });

    // Build the URL from the instance base (resolved per user-key scope), never
    // a module-level default — a self-hosted user must not hit memory.midbrain.ai.
    const response = await fetch(`${this.#accountBase}${suffix}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Account API ${response.status}${sanitizeErrorBody(text)}`);
    }
    if (response.status === 204) return null;
    return response.json().catch(() => null);
  }

  /** List agents owned by the user. @returns {Promise<Array<object>>} */
  async listAgents() {
    const data = await this.#accountRequest("GET", "/agents");
    return Array.isArray(data) ? data : [];
  }

  /**
   * Create a server-managed (key_provider="midbrain") agent.
   * @param {{name: string, description?: string}} params
   * @returns {Promise<object>} AgentOut
   */
  async createAgent({ name, description } = {}) {
    if (!name) throw new Error("createAgent requires a name");
    const body = { name };
    if (description !== undefined) body.description = description;
    return this.#accountRequest("POST", "/agents", body);
  }

  /**
   * Create an API key for an agent. The raw key is returned exactly once.
   * @param {{agent_id: string, key_alias: string, max_budget?: number, read_only?: boolean}} params
   * @returns {Promise<object>} KeyResponse (includes `key` secret + `token`)
   */
  async createKey({ agent_id, key_alias, max_budget, read_only } = {}) {
    if (!agent_id) throw new Error("createKey requires an agent_id");
    if (!key_alias) throw new Error("createKey requires a key_alias");
    const body = { agent_id, key_alias };
    if (max_budget !== undefined) body.max_budget = max_budget;
    if (read_only !== undefined) body.read_only = read_only;
    return this.#accountRequest("POST", "/keys", body);
  }

  /**
   * Delete an agent. Per the account API this HARD-deletes the agent AND
   * cascades to its API keys (and memories) — so this alone is sufficient
   * compensating cleanup for a minted-but-unstored key. Returns null (204).
   * @param {string} agent_id
   * @returns {Promise<null>}
   */
  async deleteAgent(agent_id) {
    if (!agent_id) throw new Error("deleteAgent requires an agent_id");
    return this.#accountRequest("DELETE", `/agents/${encodeURIComponent(agent_id)}`);
  }

  // --- Static endpoint constants (for callers that build URLs directly) ---

  static get SEARCH_SEMANTIC()    { return ENDPOINTS.SEARCH_SEMANTIC; }
  static get SEARCH_LEXICAL()     { return ENDPOINTS.SEARCH_LEXICAL; }
  static get SEARCH_PROCEDURAL()  { return ENDPOINTS.SEARCH_PROCEDURAL; }
  static get EPISODIC()           { return ENDPOINTS.EPISODIC; }
  static get SEMANTIC_FILES()     { return ENDPOINTS.SEMANTIC_FILES; }
  static get PROCEDURAL()         { return ENDPOINTS.PROCEDURAL; }
  static get DEFAULT_SEARCH_LIMIT() { return DEFAULT_SEARCH_LIMIT; }
  static get API_BASE_URL()       { return API_BASE; }
}
