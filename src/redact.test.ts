import { realpathSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PATTERNS,
  DEFAULT_PII_KEYS,
  NotATraceError,
  loadRulesFile,
  redactTrace,
  validateRedactedFile,
} from "./redact.js";

let workDir: string;

beforeEach(async () => {
  // Same macOS quirk other tests handle: realpath through the symlink so
  // path-equality assertions hold across CI matrix platforms.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-redact-")));
});

afterEach(() => {
  // beforeEach doesn't chdir — no cleanup needed.
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

const baseTrace = (overrides: Record<string, unknown> = {}) => ({
  name: "demo",
  steps: [
    { kind: "user", content: "hello" },
    { kind: "assistant", content: "hi back", toolCalls: [] },
  ],
  ...overrides,
});

describe("redactTrace — email redaction", () => {
  it("replaces email-shaped strings inside content fields", async () => {
    const tracePath = await writeTrace("trace.json", {
      name: "emails",
      steps: [
        { kind: "user", content: "ping me at alice@example.com please" },
        { kind: "assistant", content: "ok", toolCalls: [] },
      ],
    });

    const result = await redactTrace({ tracePath });

    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("ping me at <REDACTED:email> please");
    expect(result.counts.byReason.email).toBe(1);
    expect(result.counts.total).toBe(1);
  });

  it("redacts emails inside tool-call arguments too", async () => {
    const tracePath = await writeTrace("trace.json", {
      name: "tool-emails",
      steps: [
        { kind: "user", content: "send" },
        {
          kind: "assistant",
          content: "",
          toolCalls: [{ name: "send_mail", arguments: { to: "bob@example.com" } }],
        },
      ],
    });

    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[1].toolCalls[0].arguments.to).toBe("<REDACTED:email>");
    expect(result.counts.byReason.email).toBe(1);
  });
});

describe("redactTrace — API key redaction", () => {
  it("redacts sk- prefixed keys", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "use sk-proj-abc123def456ghi789jkl012mno" },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("use <REDACTED:api-key>");
    expect(result.counts.byReason["api-key"]).toBe(1);
  });

  it("redacts Bearer tokens", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "Authorization: Bearer abc.def-ghi_jkl" },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("Authorization: <REDACTED:api-key>");
    expect(result.counts.byReason["api-key"]).toBe(1);
  });

  it("redacts ghp_, ghs_, xoxb-, npm_ tokens", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          {
            kind: "user",
            content:
              "ghp_abcdef1234567890abcdef xoxb-1234567890-abc ghs_xyzxyzxyzxyzxyzxyz01 npm_abcdefghijklmnopqrst",
          },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    // All four should be redacted.
    expect(out.steps[0].content).toBe(
      "<REDACTED:api-key> <REDACTED:api-key> <REDACTED:api-key> <REDACTED:api-key>",
    );
    expect(result.counts.byReason["api-key"]).toBe(4);
  });
});

describe("redactTrace — JWT redaction", () => {
  it("redacts JWT-shaped strings", async () => {
    // Build a real-shaped JWT > 80 chars.
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4iLCJpYXQiOjE1MTYyMzkwMjJ9.signaturepartherewithlength";
    expect(jwt.length).toBeGreaterThan(80);
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: `token=${jwt}` },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("token=<REDACTED:jwt>");
    expect(result.counts.byReason.jwt).toBe(1);
  });

  it("leaves short eyJ- strings alone (below JWT length floor)", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          // 3 dot-separated chunks but total length way under 80.
          { kind: "user", content: "eyJa.b.c" },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("eyJa.b.c");
    expect(result.counts.byReason.jwt).toBeUndefined();
  });
});

describe("redactTrace — UUIDs are preserved", () => {
  it("does NOT redact UUID-shaped strings", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "request 550e8400-e29b-41d4-a716-446655440000 please" },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("request 550e8400-e29b-41d4-a716-446655440000 please");
    expect(result.counts.total).toBe(0);
  });
});

describe("redactTrace — PII keys", () => {
  it("replaces value of PII-keyed fields wholesale (case-insensitive)", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "log in" },
          {
            kind: "assistant",
            content: "",
            toolCalls: [
              {
                name: "login",
                arguments: {
                  email: "alice@example.com",
                  password: "hunter2",
                  Authorization: "anything-goes-here",
                  apiKey: "secret-value",
                },
              },
            ],
          },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    const args = out.steps[1].toolCalls[0].arguments;
    expect(args.email).toBe("<REDACTED:pii>");
    expect(args.password).toBe("<REDACTED:pii>");
    expect(args.Authorization).toBe("<REDACTED:pii>");
    expect(args.apiKey).toBe("<REDACTED:pii>");
    expect(result.counts.byReason.pii).toBe(4);
  });

  it("PII-key match short-circuits recursion — nested object inside is replaced as a whole", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        meta: { auth: { token: "xyz", nested: { deep: "stuff" } } },
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.meta.auth).toBe("<REDACTED:pii>");
    expect(result.counts.byReason.pii).toBe(1);
  });
});

describe("redactTrace — composition", () => {
  it("applies multiple redactor types together with correct counts", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          {
            kind: "user",
            content: "email alice@example.com and use sk-proj-abcdefghij1234567890abcd",
          },
          {
            kind: "assistant",
            content: "",
            toolCalls: [{ name: "x", arguments: { email: "bob@example.com", password: "p" } }],
          },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    expect(result.counts.byReason.email).toBe(1); // user content email
    expect(result.counts.byReason["api-key"]).toBe(1); // user content sk-
    expect(result.counts.byReason.pii).toBe(2); // email + password keys
    expect(result.counts.total).toBe(4);
  });
});

describe("redactTrace — dry run", () => {
  it("--dry-run writes nothing but returns counts", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "ping alice@example.com" },
          { kind: "assistant", content: "ok", toolCalls: [] },
        ],
      }),
    );

    const result = await redactTrace({ tracePath, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.counts.byReason.email).toBe(1);
    // No file was written.
    await expect(stat(result.outPath)).rejects.toThrow();
  });
});

describe("redactTrace — custom rules", () => {
  it("extends defaults with user-supplied patterns and piiKeys", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "internal-id INTERNAL-12345 ok" },
          {
            kind: "assistant",
            content: "",
            toolCalls: [{ name: "x", arguments: { dob: "1990-01-01" } }],
          },
        ],
      }),
    );

    const result = await redactTrace({
      tracePath,
      rules: {
        patterns: [{ pattern: /INTERNAL-\d+/g, reason: "internal-id" }],
        piiKeys: ["dob"],
      },
    });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps[0].content).toBe("internal-id <REDACTED:internal-id> ok");
    expect(out.steps[1].toolCalls[0].arguments.dob).toBe("<REDACTED:pii>");
    expect(result.counts.byReason["internal-id"]).toBe(1);
    expect(result.counts.byReason.pii).toBe(1);
  });

  it("loadRulesFile parses a JSON rules file and compiles patterns", async () => {
    const rulesPath = path.join(workDir, "rules.json");
    await writeFile(
      rulesPath,
      JSON.stringify({
        patterns: ["INTERNAL-\\d+", "PROJ-[A-Z]+"],
        piiKeys: ["dob"],
      }),
      "utf8",
    );
    const rules = await loadRulesFile(rulesPath);
    expect(rules.patterns).toHaveLength(2);
    expect(rules.patterns?.[0]?.pattern.test("INTERNAL-99")).toBe(true);
    expect(rules.piiKeys).toEqual(["dob"]);
  });

  it("loadRulesFile throws on malformed JSON", async () => {
    const rulesPath = path.join(workDir, "bad.json");
    await writeFile(rulesPath, "{ not json", "utf8");
    await expect(loadRulesFile(rulesPath)).rejects.toThrow(/not valid JSON/);
  });

  it("loadRulesFile throws on invalid regex", async () => {
    const rulesPath = path.join(workDir, "bad-rx.json");
    await writeFile(rulesPath, JSON.stringify({ patterns: ["[unclosed"] }), "utf8");
    await expect(loadRulesFile(rulesPath)).rejects.toThrow(/invalid regex/);
  });
});

describe("redactTrace — error paths", () => {
  it("throws when the file is missing", async () => {
    const ghost = path.join(workDir, "ghost.json");
    await expect(redactTrace({ tracePath: ghost })).rejects.toThrow(/could not read trace/);
  });

  it("throws when JSON is malformed", async () => {
    const tracePath = await writeTrace("trace.json", "{ not json");
    await expect(redactTrace({ tracePath })).rejects.toThrow(/not valid JSON/);
  });

  it("throws NotATraceError for valid JSON that isn't a trace shape", async () => {
    const tracePath = await writeTrace("trace.json", { hello: "world" });
    await expect(redactTrace({ tracePath })).rejects.toBeInstanceOf(NotATraceError);
  });
});

describe("redactTrace — output validity", () => {
  it("redacted file still passes TraceSchema validation", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "alice@example.com" },
          {
            kind: "assistant",
            content: "",
            toolCalls: [{ name: "send", arguments: { email: "x@y.com", token: "t" } }],
          },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    expect(await validateRedactedFile(result.outPath)).toBe(true);
  });

  it("preserves step ordering and structural shape", async () => {
    const tracePath = await writeTrace(
      "trace.json",
      baseTrace({
        steps: [
          { kind: "user", content: "first alice@example.com" },
          { kind: "assistant", content: "second", toolCalls: [{ name: "a", arguments: {} }] },
          { kind: "user", content: "third" },
          { kind: "assistant", content: "fourth", toolCalls: [] },
        ],
      }),
    );
    const result = await redactTrace({ tracePath });
    const out = JSON.parse(await readFile(result.outPath, "utf8"));
    expect(out.steps.map((s: { kind: string }) => s.kind)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(out.steps[1].content).toBe("second");
    expect(out.steps[3].content).toBe("fourth");
    expect(out.steps[1].toolCalls[0].name).toBe("a");
  });

  it("writes to default <basename>.redacted.<ext> when outPath not supplied", async () => {
    const tracePath = await writeTrace("refund.json", baseTrace());
    const result = await redactTrace({ tracePath });
    expect(path.basename(result.outPath)).toBe("refund.redacted.json");
    expect((await stat(result.outPath)).isFile()).toBe(true);
  });

  it("honours an explicit outPath", async () => {
    const tracePath = await writeTrace("refund.json", baseTrace());
    const explicit = path.join(workDir, "share-this.json");
    const result = await redactTrace({ tracePath, outPath: explicit });
    expect(result.outPath).toBe(explicit);
    expect((await stat(explicit)).isFile()).toBe(true);
  });
});

describe("DEFAULT_PATTERNS / DEFAULT_PII_KEYS", () => {
  it("exports the documented default sets", () => {
    // Sanity check on the surface area the README documents.
    const reasons = new Set(DEFAULT_PATTERNS.map((p) => p.reason));
    expect(reasons.has("email")).toBe(true);
    expect(reasons.has("api-key")).toBe(true);
    expect(reasons.has("jwt")).toBe(true);
    expect(new Set(DEFAULT_PII_KEYS)).toEqual(
      new Set([
        "email",
        "phone",
        "ssn",
        "password",
        "token",
        "secret",
        "apiKey",
        "api_key",
        "authorization",
        "auth",
      ]),
    );
  });
});
