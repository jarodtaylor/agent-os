import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_SERVER_NAME, codexConfigPath, extractCodexToken, readCodexToken } from "../src/codex-credential";
import { TOKEN_HEADER } from "../src/paths";

// Direct coverage for the single-source credential module (issue #24). Before this file, extractCodexToken's
// ~11 fail-closed branches were exercised only TRANSITIVELY through the gate/installer suites via TOML
// fixtures — so a malformed-shape regression could hide behind a coincidentally-passing higher-level test
// (e.g. the wholesale-replace test reads the token back with the same function it's meant to check). These
// pin the pure extractor and the fail-closed file reader against their contracts directly.

describe("extractCodexToken — pure, total, fail-closed at every level", () => {
  const withToken = (value: unknown) => ({
    mcp_servers: { [CODEX_SERVER_NAME]: { http_headers: { [TOKEN_HEADER]: value } } },
  });

  test("returns the trimmed token for a well-formed config", () => {
    expect(extractCodexToken(withToken("the-token"))).toBe("the-token");
    expect(extractCodexToken(withToken("  padded  "))).toBe("padded"); // trimmed
  });

  // Every non-string-at-the-exact-path shape must yield null, never throw — the security gate depends on this
  // totality (a throw in the auth path would be a 500, not a clean 403).
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "not-a-config"],
    ["a top-level array", []],
    ["no mcp_servers", {}],
    ["mcp_servers a string", { mcp_servers: "x" }],
    ["mcp_servers null", { mcp_servers: null }],
    ["mcp_servers an array", { mcp_servers: [] }],
    ["no agent-os entry", { mcp_servers: {} }],
    ["entry a string", { mcp_servers: { [CODEX_SERVER_NAME]: "x" } }],
    ["entry an array", { mcp_servers: { [CODEX_SERVER_NAME]: [] } }],
    ["no http_headers", { mcp_servers: { [CODEX_SERVER_NAME]: {} } }],
    ["http_headers a number", { mcp_servers: { [CODEX_SERVER_NAME]: { http_headers: 42 } } }],
    ["http_headers null", { mcp_servers: { [CODEX_SERVER_NAME]: { http_headers: null } } }],
    ["token key absent", { mcp_servers: { [CODEX_SERVER_NAME]: { http_headers: {} } } }],
    ["token a number", withToken(12345)],
    ["token a boolean", withToken(true)],
    ["token empty", withToken("")],
    ["token whitespace-only", withToken("   ")],
  ])("returns null: %s", (_label, config) => {
    expect(extractCodexToken(config)).toBeNull();
  });

  test("a present-but-WRONG-key http_headers table is 'no usable token', not accidentally reused", () => {
    // Gap the wholesale-replace installer test can't prove on its own (it reads back via the same function):
    // a foreign header key must not satisfy our exact-key lookup. Otherwise a stale wrong-keyed value could be
    // mistaken for our credential.
    const config = { mcp_servers: { [CODEX_SERVER_NAME]: { http_headers: { "x-someone-elses-bearer": "nope" } } } };
    expect(extractCodexToken(config)).toBeNull();
  });

  test("ignores a token embedded under a DIFFERENT server name", () => {
    const config = { mcp_servers: { "not-us": { http_headers: { [TOKEN_HEADER]: "theirs" } } } };
    expect(extractCodexToken(config)).toBeNull();
  });
});

describe("readCodexToken — fail-closed file reader (the gate's + uninstall's shared reader)", () => {
  let dir: string;
  const configPath = () => join(dir, "config.toml");
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-cred-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent file ⇒ null", () => {
    expect(readCodexToken(configPath())).toBeNull();
  });

  test("valid config with an embedded token ⇒ the token", () => {
    writeFileSync(configPath(), `[mcp_servers.${CODEX_SERVER_NAME}.http_headers]\n"${TOKEN_HEADER}" = "abc123"\n`);
    expect(readCodexToken(configPath())).toBe("abc123");
  });

  test("CORRUPT TOML ⇒ null (fail closed, never a throw into the auth path)", () => {
    writeFileSync(configPath(), `[mcp_servers.${CODEX_SERVER_NAME}\nbroken = `);
    expect(readCodexToken(configPath())).toBeNull();
  });

  test("valid TOML with no agent-os entry ⇒ null", () => {
    writeFileSync(configPath(), `model = "gpt-5.4"\n\n[mcp_servers.other]\nurl = "http://example.invalid"\n`);
    expect(readCodexToken(configPath())).toBeNull();
  });

  test("entry present but no http_headers ⇒ null", () => {
    writeFileSync(configPath(), `[mcp_servers.${CODEX_SERVER_NAME}]\nurl = "http://127.0.0.1:4319/mcp"\n`);
    expect(readCodexToken(configPath())).toBeNull();
  });
});

describe("codexConfigPath", () => {
  test("joins ~/.codex/config.toml under an explicit home", () => {
    expect(codexConfigPath("/tmp/fake-home")).toBe(join("/tmp/fake-home", ".codex", "config.toml"));
  });
});
