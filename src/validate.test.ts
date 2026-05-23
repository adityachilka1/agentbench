import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatValidate, formatValidateJson, validateAgentbenchFile } from "./validate.js";

let workDir: string;
let prevCwd: string;

beforeEach(async () => {
  // Same macOS quirk init.test.ts / list.test.ts handle: tmpdir() returns
  // /var/folders/... which resolves to /private/var/folders/... once chdir'd.
  // Pre-resolve so cwd-based path equality holds across the CI matrix.
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-validate-")));
  prevCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(() => {
  process.chdir(prevCwd);
});

const VALID_TRACE = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [{ name: "search_kb", arguments: { query: "refund policy" } }],
    },
  ],
};

async function writeTrace(file: string, body: unknown): Promise<string> {
  const full = path.join(workDir, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return full;
}

describe("validateAgentbenchFile — happy path", () => {
  it("returns ok: true with no issues for a well-formed trace", async () => {
    const file = await writeTrace("good.json", VALID_TRACE);
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.ok).toBe(true);
    expect(result.files[0]?.issues).toEqual([]);
    expect(result.summary).toMatch(/1 ok/);
  });

  it("accepts a minimal trace: just `name` + empty `steps`, with a warning", async () => {
    const file = await writeTrace("minimal.json", { name: "empty", steps: [] });
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(true); // empty is a warning, not an error
    const issues = result.files[0]?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("warning");
    expect(issues[0]?.message).toMatch(/no steps/);
  });
});

describe("validateAgentbenchFile — error classes", () => {
  it("flags malformed JSON with severity 'error' and root path", async () => {
    const file = await writeTrace("broken.json", "{ not real json");
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(false);
    const issues = result.files[0]?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]?.severity).toBe("error");
    expect(issues[0]?.message).toMatch(/malformed JSON/);
  });

  it("flags a missing required field (`name`) as an error", async () => {
    const file = await writeTrace("no-name.json", { steps: [] });
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(false);
    const issues = result.files[0]?.issues ?? [];
    expect(issues.some((i) => i.path === "name" && i.severity === "error")).toBe(true);
  });

  it("flags a wrong type on a field (`steps` not an array) as an error", async () => {
    const file = await writeTrace("wrong-type.json", { name: "x", steps: "not an array" });
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(false);
    const issues = result.files[0]?.issues ?? [];
    expect(issues.some((i) => i.path === "steps")).toBe(true);
  });

  it("flags an unknown step `kind` as an error on the discriminator", async () => {
    const file = await writeTrace("bad-kind.json", {
      name: "x",
      steps: [{ kind: "system", content: "nope" }],
    });
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(false);
    const issues = result.files[0]?.issues ?? [];
    expect(issues.some((i) => i.message.toLowerCase().includes("kind"))).toBe(true);
  });

  it("throws when the target path does not exist", async () => {
    const missing = path.join(workDir, "definitely-not-here.json");
    await expect(validateAgentbenchFile(missing)).rejects.toThrow(/does not exist/);
  });
});

describe("validateAgentbenchFile — warnings", () => {
  it("warns on duplicate tool-call names within the same assistant step", async () => {
    const file = await writeTrace("dup-tools.json", {
      name: "dup",
      steps: [
        {
          kind: "assistant",
          content: "",
          toolCalls: [
            { name: "search", arguments: { q: "a" } },
            { name: "search", arguments: { q: "b" } },
          ],
        },
      ],
    });
    const result = await validateAgentbenchFile(file);
    expect(result.ok).toBe(true); // duplicates are a warning
    const issues = result.files[0]?.issues ?? [];
    const dupWarn = issues.find((i) => i.message.includes("duplicate tool call"));
    expect(dupWarn?.severity).toBe("warning");
    expect(dupWarn?.path).toMatch(/steps\.0\.toolCalls\.1/);
  });
});

describe("validateAgentbenchFile — directory mode", () => {
  it("aggregates per-file results, ok=false if any file fails", async () => {
    const dir = path.join(workDir, "mixed");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "good.json"), JSON.stringify(VALID_TRACE), "utf8");
    await writeFile(path.join(dir, "bad.json"), "{ broken", "utf8");

    const result = await validateAgentbenchFile(dir);
    expect(result.ok).toBe(false);
    expect(result.files).toHaveLength(2);
    const byName = Object.fromEntries(result.files.map((f) => [path.basename(f.path), f]));
    expect(byName["good.json"]?.ok).toBe(true);
    expect(byName["bad.json"]?.ok).toBe(false);
    expect(result.summary).toMatch(/2 files/);
    expect(result.summary).toMatch(/1 failed/);
  });

  it("recurses into nested subdirs and picks up .agentbench files too", async () => {
    const dir = path.join(workDir, "nested");
    await mkdir(path.join(dir, "support"), { recursive: true });
    await writeFile(
      path.join(dir, "support", "refund.agentbench"),
      JSON.stringify(VALID_TRACE),
      "utf8",
    );
    await writeFile(path.join(dir, "top.json"), JSON.stringify(VALID_TRACE), "utf8");

    const result = await validateAgentbenchFile(dir);
    expect(result.ok).toBe(true);
    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => path.basename(f.path)).sort()).toEqual([
      "refund.agentbench",
      "top.json",
    ]);
  });

  it("skips bench.json so we don't validate the bench config as a trace", async () => {
    const dir = path.join(workDir, "with-config");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "bench.json"),
      JSON.stringify({ name: "b", version: "0.0.1" }),
      "utf8",
    );
    await writeFile(path.join(dir, "real.json"), JSON.stringify(VALID_TRACE), "utf8");

    const result = await validateAgentbenchFile(dir);
    expect(result.files).toHaveLength(1);
    expect(path.basename(result.files[0]?.path ?? "")).toBe("real.json");
  });

  it("returns ok=true and a clear summary when the directory has no trace files", async () => {
    const dir = path.join(workDir, "empty-dir");
    await mkdir(dir, { recursive: true });
    const result = await validateAgentbenchFile(dir);
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([]);
    expect(result.summary).toMatch(/nothing to validate/);
  });
});

describe("formatValidate / formatValidateJson", () => {
  it("formatValidate renders per-file summary + a final aggregate line", async () => {
    const file = await writeTrace("fmt.json", VALID_TRACE);
    const result = await validateAgentbenchFile(file);
    const out = formatValidate(result);
    expect(out).toMatch(/fmt\.json: ok/);
    expect(out).toMatch(/1 ok/);
  });

  it("formatValidateJson emits a stable shape with trailing newline", async () => {
    const file = await writeTrace("json-shape.json", VALID_TRACE);
    const result = await validateAgentbenchFile(file);
    const text = formatValidateJson(result);
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).sort()).toEqual(["files", "ok", "path", "summary"]);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.files)).toBe(true);
    expect(Object.keys(parsed.files[0]).sort()).toEqual(["issues", "ok", "path", "summary"]);
  });
});
