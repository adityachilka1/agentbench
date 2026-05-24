import { realpathSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidTraceError, exportTrace, formatExport } from "./export.js";

let workDir: string;

beforeEach(async () => {
  // Same macOS quirk other tests handle: realpath the symlinked tmpdir so
  // path-equality assertions hold across the CI matrix (Ubuntu / macOS / Windows).
  workDir = realpathSync(await mkdtemp(path.join(tmpdir(), "agentbench-export-")));
});

afterEach(() => {
  // beforeEach doesn't chdir — no cleanup needed.
});

async function writeTrace(name: string, body: unknown): Promise<string> {
  const full = path.join(workDir, name);
  await writeFile(full, typeof body === "string" ? body : JSON.stringify(body, null, 2), "utf8");
  return full;
}

const TINY_TRACE = {
  name: "refund-policy",
  model: "claude-sonnet-4-6",
  steps: [
    { kind: "user", content: "What is your refund policy?" },
    {
      kind: "assistant",
      content: "Let me look that up.",
      toolCalls: [
        {
          name: "search_kb",
          arguments: { query: "refund policy" },
          result: "30-day money-back guarantee.",
          latencyMs: 42,
        },
      ],
    },
  ],
};

describe("exportTrace — markdown", () => {
  it("renders the basic happy path", async () => {
    const tracePath = await writeTrace("trace.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "markdown" });

    expect(result.format).toBe("markdown");
    expect(path.basename(result.outPath)).toBe("trace.md");
    expect(result.bytesWritten).toBeGreaterThan(0);

    const md = await readFile(result.outPath, "utf8");
    // Frontmatter-ish header
    expect(md).toMatch(/^# refund-policy\n/);
    expect(md).toContain("- Name: refund-policy");
    expect(md).toContain("- Model: claude-sonnet-4-6");
    expect(md).toContain("- Steps: 2");
    // User step → blockquote
    expect(md).toContain("> What is your refund policy?");
    // Assistant content as prose
    expect(md).toContain("Let me look that up.");
    // Tool calls subsection
    expect(md).toContain("### Tool calls");
    expect(md).toContain("#### 1. `search_kb`");
    expect(md).toContain("```json");
    expect(md).toContain('"query": "refund policy"');
    expect(md).toContain("- Result: `30-day money-back guarantee.`");
    expect(md).toContain("- Latency: 42 ms");
    // Trailing newline
    expect(md.endsWith("\n")).toBe(true);
  });

  it("produces headings in the expected order", async () => {
    const tracePath = await writeTrace("ordered.json", {
      name: "ordered",
      steps: [
        { kind: "user", content: "first" },
        {
          kind: "assistant",
          content: "second",
          toolCalls: [{ name: "lookup", arguments: { q: "x" } }],
        },
        { kind: "user", content: "third" },
        { kind: "assistant", content: "fourth", toolCalls: [] },
      ],
    });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    // Pull every h1/h2/h3/h4 in document order
    const headings = [...md.matchAll(/^#{1,4} .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual([
      "# ordered",
      "## Step 1 — user",
      "## Step 2 — assistant",
      "### Tool calls",
      "#### 1. `lookup`",
      "## Step 3 — user",
      "## Step 4 — assistant",
    ]);
  });

  it("renders an assistant step with no tool calls (no Tool calls subsection)", async () => {
    const tracePath = await writeTrace("no-tools.json", {
      name: "no-tools",
      steps: [
        { kind: "user", content: "hi" },
        { kind: "assistant", content: "hello!", toolCalls: [] },
      ],
    });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    expect(md).toContain("hello!");
    expect(md).not.toContain("### Tool calls");
  });

  it("renders several tool calls in order with numbered subheadings", async () => {
    const tracePath = await writeTrace("many-tools.json", {
      name: "many-tools",
      steps: [
        { kind: "user", content: "do three things" },
        {
          kind: "assistant",
          content: "ok",
          toolCalls: [
            { name: "first_call", arguments: { i: 1 } },
            { name: "second_call", arguments: { i: 2 }, latencyMs: 7 },
            { name: "third_call", arguments: { i: 3 }, result: { ok: true } },
          ],
        },
      ],
    });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    const headings = [...md.matchAll(/^#### .+$/gm)].map((m) => m[0]);
    expect(headings).toEqual([
      "#### 1. `first_call`",
      "#### 2. `second_call`",
      "#### 3. `third_call`",
    ]);
    expect(md).toContain("- Latency: 7 ms");
    expect(md).toContain('- Result: `{"ok":true}`');
  });

  it("truncates long result previews with a real ellipsis (U+2026, not '...')", async () => {
    const longResult = "x".repeat(500);
    const tracePath = await writeTrace("long.json", {
      name: "long",
      steps: [
        { kind: "user", content: "fetch" },
        {
          kind: "assistant",
          content: "",
          toolCalls: [{ name: "fetch", arguments: {}, result: longResult }],
        },
      ],
    });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    // Real U+2026 character
    expect(md).toContain("…");
    // NOT the three-dot variant on the truncation line
    const resultLine = md.split("\n").find((l) => l.startsWith("- Result:"));
    expect(resultLine).toBeDefined();
    expect(resultLine).not.toContain("...");
  });
});

describe("exportTrace — html", () => {
  it("renders the basic happy path as self-contained HTML", async () => {
    const tracePath = await writeTrace("trace.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "html" });

    expect(result.format).toBe("html");
    expect(path.basename(result.outPath)).toBe("trace.html");

    const html = await readFile(result.outPath, "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>refund-policy");
    expect(html).toContain("<style>");
    // Frontmatter as a <dl>
    expect(html).toContain("<dt>Name</dt>");
    expect(html).toContain("<dt>Model</dt>");
    expect(html).toContain("<dt>Steps</dt>");
    // User blockquote
    expect(html).toContain('<blockquote class="user-content">');
    expect(html).toContain("What is your refund policy?");
    // Tool-call subsection
    expect(html).toContain("Tool calls");
    expect(html).toContain("<code>search_kb</code>");
    expect(html).toContain("30-day money-back guarantee.");
    expect(html).toContain("42 ms");
  });

  it("contains NO <script> tag and NO external assets", async () => {
    const tracePath = await writeTrace("trace.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "html" });
    const html = await readFile(result.outPath, "utf8");
    expect(html).not.toMatch(/<script\b/i);
    // No <link rel="stylesheet"> or external src= references.
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/src=["']https?:/i);
    expect(html).not.toMatch(/href=["']https?:/i);
  });

  it("HTML-escapes content that contains angle brackets and ampersands", async () => {
    const tracePath = await writeTrace("xss.json", {
      name: "xss-attempt",
      steps: [
        { kind: "user", content: "<script>alert('x')</script> & friends" },
        { kind: "assistant", content: "", toolCalls: [] },
      ],
    });
    const result = await exportTrace({ tracePath, format: "html" });
    const html = await readFile(result.outPath, "utf8");
    // Raw <script> in user content must be escaped, not present as a tag.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp; friends");
    // And we must not have introduced an executable <script> via the user content.
    const scriptMatches = html.match(/<script\b/gi);
    expect(scriptMatches).toBeNull();
  });
});

describe("exportTrace — json", () => {
  it("renders pretty-printed JSON with 2-space indent", async () => {
    const tracePath = await writeTrace("trace.json", TINY_TRACE);
    const result = await exportTrace({
      tracePath,
      format: "json",
      outPath: path.join(workDir, "out.json"),
    });
    expect(result.format).toBe("json");
    const json = await readFile(result.outPath, "utf8");
    // Pretty indent (one of the canonical lines)
    expect(json).toContain('\n  "name": "refund-policy"');
    expect(json.endsWith("\n")).toBe(true);
    // Round-trips to the same Trace
    const round = JSON.parse(json);
    expect(round.name).toBe("refund-policy");
    expect(round.steps).toHaveLength(2);
  });
});

describe("exportTrace — output path resolution", () => {
  it("defaults to <basename>.md when format is markdown and no --out given", async () => {
    const tracePath = await writeTrace("refund.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "markdown" });
    expect(result.outPath).toBe(path.join(workDir, "refund.md"));
    expect((await stat(result.outPath)).isFile()).toBe(true);
  });

  it("defaults to <basename>.html when format is html", async () => {
    const tracePath = await writeTrace("refund.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "html" });
    expect(result.outPath).toBe(path.join(workDir, "refund.html"));
  });

  it("honours an explicit --out override (any extension allowed)", async () => {
    const tracePath = await writeTrace("refund.json", TINY_TRACE);
    const explicit = path.join(workDir, "share/report.markdown");
    // Caller is responsible for the parent directory existing in normal use,
    // but here we control workDir so make it.
    await writeFile(path.join(workDir, ".gitkeep"), "", "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(explicit), { recursive: true });
    const result = await exportTrace({ tracePath, format: "markdown", outPath: explicit });
    expect(result.outPath).toBe(explicit);
    expect((await stat(explicit)).isFile()).toBe(true);
  });
});

describe("exportTrace — error paths", () => {
  it("throws when the file is missing", async () => {
    const ghost = path.join(workDir, "ghost.json");
    await expect(exportTrace({ tracePath: ghost, format: "markdown" })).rejects.toThrow(
      /path does not exist/,
    );
  });

  it("throws InvalidTraceError for JSON that isn't a trace shape", async () => {
    const tracePath = await writeTrace("trace.json", { hello: "world" });
    await expect(exportTrace({ tracePath, format: "markdown" })).rejects.toBeInstanceOf(
      InvalidTraceError,
    );
  });

  it("throws InvalidTraceError for malformed JSON", async () => {
    const tracePath = await writeTrace("trace.json", "{ not json");
    await expect(exportTrace({ tracePath, format: "markdown" })).rejects.toBeInstanceOf(
      InvalidTraceError,
    );
  });
});

describe("exportTrace — edge cases", () => {
  it("renders a trace with zero steps", async () => {
    const tracePath = await writeTrace("empty.json", { name: "empty", steps: [] });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    expect(md).toContain("- Steps: 0");
    expect(md).toContain("_No steps recorded._");
    expect(md).not.toContain("## Step");
  });

  it("renders without a model field (falls back to n/a)", async () => {
    const tracePath = await writeTrace("no-model.json", {
      name: "no-model",
      steps: [
        { kind: "user", content: "hi" },
        { kind: "assistant", content: "hello", toolCalls: [] },
      ],
    });
    const result = await exportTrace({ tracePath, format: "markdown" });
    const md = await readFile(result.outPath, "utf8");
    expect(md).toContain("- Model: n/a");
  });
});

describe("formatExport", () => {
  it("renders a single-line summary", async () => {
    const tracePath = await writeTrace("trace.json", TINY_TRACE);
    const result = await exportTrace({ tracePath, format: "markdown" });
    const line = formatExport(result);
    expect(line).toContain("wrote ");
    expect(line).toContain("(markdown,");
    expect(line).toMatch(/\d+ bytes\)$/);
  });
});
