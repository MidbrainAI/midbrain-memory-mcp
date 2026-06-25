/**
 * Unit tests for shared/device-auth.mjs
 *
 * Tests the device-code authorization flow with mocked fetch and child_process.
 * No real network calls or browser opens.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process.spawn to prevent browser opening
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

// Mock readline for prompt() calls
const mockQuestion = vi.fn();
vi.mock("readline", () => ({
  default: {
    createInterface: () => ({
      question: mockQuestion,
      close: vi.fn(),
    }),
  },
}));

const { deviceCodeLogin } = await import("../shared/device-auth.mjs");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(responses) {
  let callIndex = 0;
  return vi.fn(async (url, _opts) => {
    const resp = responses[callIndex++];
    if (!resp) throw new Error(`Unexpected fetch call #${callIndex}: ${url}`);
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => resp.body,
      text: async () => JSON.stringify(resp.body),
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deviceCodeLogin", () => {
  let originalFetch;
  let originalStderr;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Suppress console.error output during tests
    originalStderr = console.error;
    console.error = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.error = originalStderr;
    vi.restoreAllMocks();
  });

  it("completes the full flow for a new user (no agents)", async () => {
    globalThis.fetch = mockFetch([
      // 1. POST /authorize
      {
        body: {
          device_code: "dc_test123",
          user_code: "ABCD-1234",
          verification_uri: "https://example.com/account/device/ABCD-1234",
          expires_in: 900,
          interval: 0, // no delay in tests
        },
      },
      // 2. POST /token — approved, no agents
      {
        body: {
          status: "approved",
          email: "test@example.com",
          agents: [],
        },
      },
      // 3. POST /finalize — new agent created
      {
        body: {
          api_key: "sk-test-key-123",
          agent_id: "agent_abc123",
          agent_name: "My Agent",
          key_alias: "my-agent-key-mcp",
        },
      },
    ]);

    const result = await deviceCodeLogin({ baseUrl: "https://example.com" });

    expect(result).toEqual({
      apiKey: "sk-test-key-123",
      agentId: "agent_abc123",
      agentName: "My Agent",
      keyAlias: "my-agent-key-mcp",
    });

    // Verify the correct endpoints were called
    const calls = globalThis.fetch.mock.calls;
    expect(calls[0][0]).toBe("https://example.com/api/v1/auth/device/authorize");
    expect(calls[1][0]).toBe("https://example.com/api/v1/auth/device/token");
    expect(calls[2][0]).toBe("https://example.com/api/v1/auth/device/finalize");

    // Finalize should have agent_name (new agent), not agent_id
    const finalizeBody = JSON.parse(calls[2][1].body);
    expect(finalizeBody.agent_name).toBe("My Agent");
    expect(finalizeBody.agent_id).toBeUndefined();

    // Browser should have been opened with the verification URI (code in path)
    const { spawn } = await import("node:child_process");
    expect(spawn).toHaveBeenCalled();
    const spawnArgs = spawn.mock.calls[0];
    const allArgs = [spawnArgs[0], ...spawnArgs[1]];
    expect(allArgs.some(a => a.includes("https://example.com/account/device/ABCD-1234"))).toBe(true);
  });

  it("lets user select an existing agent", async () => {
    globalThis.fetch = mockFetch([
      // 1. POST /authorize
      {
        body: {
          device_code: "dc_existing",
          user_code: "WXYZ-5678",
          verification_uri: "https://example.com/account/device/WXYZ-5678",
          interval: 0,
        },
      },
      // 2. POST /token — approved, has agents
      {
        body: {
          status: "approved",
          email: "user@example.com",
          agents: [
            { agent_id: "agent_111", name: "Work Agent" },
            { agent_id: "agent_222", name: "Personal Agent" },
          ],
        },
      },
      // 3. POST /finalize — existing agent
      {
        body: {
          api_key: "sk-existing-key",
          agent_id: "agent_111",
          agent_name: "Work Agent",
          key_alias: "work-agent-key-mcp",
        },
      },
    ]);

    // Mock the prompt to select agent #1
    mockQuestion.mockImplementation((q, cb) => cb("1"));

    const result = await deviceCodeLogin({ baseUrl: "https://example.com" });

    expect(result.apiKey).toBe("sk-existing-key");
    expect(result.agentId).toBe("agent_111");
    expect(result.agentName).toBe("Work Agent");

    // Finalize should have agent_id (existing), not agent_name
    const finalizeBody = JSON.parse(globalThis.fetch.mock.calls[2][1].body);
    expect(finalizeBody.agent_id).toBe("agent_111");
    expect(finalizeBody.agent_name).toBeUndefined();
  });

  it("handles pending polls before approval", async () => {
    globalThis.fetch = mockFetch([
      // 1. POST /authorize
      {
        body: {
          device_code: "dc_poll",
          user_code: "POLL-1234",
          verification_uri: "https://example.com/account/device/POLL-1234",
          interval: 0,
        },
      },
      // 2. POST /token — pending
      {
        body: { error: "authorization_pending" },
      },
      // 3. POST /token — pending again
      {
        body: { error: "authorization_pending" },
      },
      // 4. POST /token — approved
      {
        body: {
          status: "approved",
          email: "poll@example.com",
          agents: [],
        },
      },
      // 5. POST /finalize
      {
        body: {
          api_key: "sk-poll-key",
          agent_id: "agent_poll",
          agent_name: "My Agent",
          key_alias: "my-agent-key-mcp",
        },
      },
    ]);

    const result = await deviceCodeLogin({ baseUrl: "https://example.com" });
    expect(result.apiKey).toBe("sk-poll-key");

    // Should have called /token 3 times (2 pending + 1 approved)
    const tokenCalls = globalThis.fetch.mock.calls.filter(
      ([url]) => url.includes("/token")
    );
    expect(tokenCalls).toHaveLength(3);
  });

  it("throws on expired device code", async () => {
    globalThis.fetch = mockFetch([
      // 1. POST /authorize
      {
        body: {
          device_code: "dc_expired",
          user_code: "EXPR-0000",
          verification_uri: "https://example.com/account/device/EXPR-0000",
          interval: 0,
        },
      },
      // 2. POST /token — expired
      {
        ok: false,
        status: 410,
        body: { detail: "Device code expired" },
      },
    ]);

    await expect(deviceCodeLogin({ baseUrl: "https://example.com" }))
      .rejects.toThrow("expired");
  });

  it("throws on failed authorize request", async () => {
    globalThis.fetch = mockFetch([
      {
        ok: false,
        status: 503,
        body: { detail: "Service unavailable" },
      },
    ]);

    await expect(deviceCodeLogin({ baseUrl: "https://example.com" }))
      .rejects.toThrow("Failed to start device authorization");
  });

  it("throws on failed finalize request", async () => {
    globalThis.fetch = mockFetch([
      // authorize
      {
        body: {
          device_code: "dc_fail",
          user_code: "FAIL-0000",
          verification_uri: "https://example.com/account/device/FAIL-0000",
          interval: 0,
        },
      },
      // token — approved, no agents
      {
        body: {
          status: "approved",
          email: "fail@example.com",
          agents: [],
        },
      },
      // finalize — server error
      {
        ok: false,
        status: 500,
        body: { detail: "Internal server error" },
      },
    ]);

    await expect(deviceCodeLogin({ baseUrl: "https://example.com" }))
      .rejects.toThrow("Failed to finalize");
  });
});
