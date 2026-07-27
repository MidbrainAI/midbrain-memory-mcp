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

const API_BASE = process.env.MIDBRAIN_API_URL || "https://memory.midbrain.ai";
const API_V1 = `${API_BASE}/api/v1`;
const API_ACCOUNT = `${API_V1}/account`;

// Endpoint paths — internal, consumed via instance methods and static constants.
const ENDPOINTS = {
  SEARCH_SEMANTIC:   `${API_V1}/memories/search/semantic`,
  SEARCH_LEXICAL:    `${API_V1}/memories/search/lexical`,
  SEARCH_PROCEDURAL: `${API_V1}/memories/search/procedural`,
  EPISODIC:          `${API_V1}/memories/episodic`,
  SEMANTIC_FILES:    `${API_V1}/memories/semantic/files`,
  PROCEDURAL:        `${API_V1}/memories/procedural`,
};

const PK_DEFAULT_LIMIT    = 5;
const PK_DEFAULT_MIN_SCORE = 0.5;
const PK_DEFAULT_TIMEOUT_MS = 2000;

const DEFAULT_SEARCH_LIMIT = 10;
const PRODUCT_USER_AGENT = "midbrain-memory-mcp";

export class MidbrainApi {
  #key;
  #source;
  #cacheScope;

  /** @param {string} key  API key. @param {string} source  Debug label for key origin. */
  constructor(key, source) {
    this.#key = key;
    this.#source = source;
    this.#cacheScope = createHash("sha256")
      .update(`${API_BASE}\0${key}`)
      .digest("hex");
  }

  /**
   * Factory: resolve key from a client adapter, return ready-to-use instance.
   * @param {import('./clients/base.mjs').BaseClient} client
   * @param {string} [projectDir]
   */
  static async create(client, projectDir) {
    const result = await client.resolveKey(projectDir);
    if (!result) throw new Error("No API key configured. Run: npx midbrain-memory-mcp install");
    return new MidbrainApi(result.key, result.source);
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
    return new MidbrainApi(result.key, result.source);
  }

  /** Key source label (for debug logging). */
  get keySource() { return this.#source; }

  /** Last 4 chars of the key (for safe logging). */
  get keyFingerprint() {
    return this.#key.length >= 4 ? `...${this.#key.slice(-4)}` : '****';
  }

  /**
   * Authenticated GET request with query params. Falls back to POST on 404/405.
   * @param {string} endpoint  Full URL.
   * @param {Record<string, string|number|undefined>} [params]
   * @returns {Promise<any>} Parsed JSON.
   */
  async fetch(endpoint, params = {}) {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    console.error(`[API] url=${url} key_source=${this.#source}`);

    let response = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#key}` },
    });

    // GET->POST fallback: if GET endpoint not yet deployed, retry with legacy POST.
    if (response.status === 404 || response.status === 405) {
      console.error(`[API] GET ${url.toString()} returned ${response.status}, retrying with POST`);
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
      });
    }

    console.error(`[API] status=${response.status}`);

    if (!response.ok) {
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
    if (process.env.MIDBRAIN_SIMULATE_OFFLINE === "1") {
      logger.warn("STORE ERROR: simulated offline (MIDBRAIN_SIMULATE_OFFLINE=1)");
      return false;
    }
    try {
      const response = await fetch(ENDPOINTS.EPISODIC, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#key}`,
          "User-Agent": PRODUCT_USER_AGENT,
        },
        body: JSON.stringify({ text, role, memory_metadata: memoryMetadata }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        logger.error(`STORE ERROR: status=${response.status} body=${body}`);
        return false;
      }
      logger.debug(`STORED: status=${response.status}`);
      return true;
    } catch (err) {
      logger.error(`STORE ERROR: ${err instanceof Error ? err.message : String(err)}`);
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
      const url = new URL(ENDPOINTS.SEARCH_PROCEDURAL);
      url.searchParams.set("query", query);
      url.searchParams.set("limit",     String(limit     ?? PK_DEFAULT_LIMIT));
      url.searchParams.set("min_score", String(minScore  ?? PK_DEFAULT_MIN_SCORE));
      for (const id of (excludeIds ?? [])) {
        url.searchParams.append("exclude_ids", String(id));
      }

      const response = await fetch(url.toString(), {
        method:  "GET",
        headers: { Authorization: `Bearer ${this.#key}` },
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

  /**
   * Authenticated JSON request against the account surface.
   * @param {string} method   HTTP method.
   * @param {string} suffix   Path under /api/v1/account (e.g. "/agents").
   * @param {object} [body]   JSON body for write requests.
   * @returns {Promise<any>}  Parsed JSON, or null for 204.
   */
  async #accountRequest(method, suffix, body) {
    const headers = {
      Authorization: `Bearer ${this.#key}`,
      "User-Agent": PRODUCT_USER_AGENT,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetch(`${API_ACCOUNT}${suffix}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "(no body)");
      throw new Error(`Account API ${response.status}: ${text}`);
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
