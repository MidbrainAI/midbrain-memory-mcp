/**
 * shared/midbrain-api.mjs
 *
 * HTTP client for the MidBrain Memory API.
 * Handles authentication, endpoint routing, and both read-path (GET)
 * and write-path (POST episodic) operations.
 *
 * Usage:
 *   const api = await MidbrainApi.create(getClient('opencode'), projectDir);
 *   const results = await api.searchSemantic({ query: '...', limit: 10 });
 *   api.storeEpisodic(text, 'user', debugLog);
 *
 * Node 20 + Bun compatible. No npm deps (uses native fetch).
 */

const API_BASE = "https://memory.midbrain.ai";
const API_V1 = `${API_BASE}/api/v1`;

// Endpoint paths — internal, consumed via instance methods and static constants.
const ENDPOINTS = {
  SEARCH_SEMANTIC: `${API_V1}/memories/search/semantic`,
  SEARCH_LEXICAL:  `${API_V1}/memories/search/lexical`,
  EPISODIC:        `${API_V1}/memories/episodic`,
  SEMANTIC_FILES:  `${API_V1}/memories/semantic/files`,
};

const DEFAULT_SEARCH_LIMIT = 10;

export class MidbrainApi {
  #key;
  #source;

  /** @param {string} key  API key. @param {string} source  Debug label for key origin. */
  constructor(key, source) {
    this.#key = key;
    this.#source = source;
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
   * @param {string} text
   * @param {"user"|"assistant"} role
   * @param {function(string): void} debugLogFn
   * @param {Record<string, string>} [memoryMetadata] - Optional metadata (e.g. { client: "codex" }).
   */
  async storeEpisodic(text, role, debugLogFn, memoryMetadata) {
    debugLogFn(`STORE: role=${role} textLen=${text.length}`);
    try {
      const response = await fetch(ENDPOINTS.EPISODIC, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#key}`,
        },
        body: JSON.stringify({ text, role, memory_metadata: memoryMetadata }),
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "(no body)");
        debugLogFn(`STORE ERROR: status=${response.status} body=${body}`);
        return false;
      }
      debugLogFn(`STORED: status=${response.status}`);
      return true;
    } catch (err) {
      debugLogFn(`STORE ERROR: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // --- Static endpoint constants (for callers that build URLs directly) ---

  static get SEARCH_SEMANTIC()  { return ENDPOINTS.SEARCH_SEMANTIC; }
  static get SEARCH_LEXICAL()   { return ENDPOINTS.SEARCH_LEXICAL; }
  static get EPISODIC()         { return ENDPOINTS.EPISODIC; }
  static get SEMANTIC_FILES()   { return ENDPOINTS.SEMANTIC_FILES; }
  static get DEFAULT_SEARCH_LIMIT() { return DEFAULT_SEARCH_LIMIT; }
  static get API_BASE_URL()     { return API_BASE; }
}
