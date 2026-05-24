/**
 * `agentbench export <trace>` — pretty-print a recorded trace into a
 * human-readable report.
 *
 * `agentbench` traces are JSON. JSON is great for diffing and machine
 * consumption, useless for reading. When you want to attach a trace to a
 * PR comment, paste it into a design review doc, drop it into a blog
 * post, or just eyeball what an agent actually did, you want a rendered
 * version. `export` is that step.
 *
 * Three output formats:
 *
 *   - **markdown** (default): tidy `.md` file with a frontmatter header
 *     (name, model, steps count) and one section per step. User steps
 *     render as a blockquote of `content`. Assistant steps render as
 *     content prose followed by a "Tool calls" subsection listing each
 *     `ToolCall` with its name, arguments as a fenced JSON block, a
 *     result preview, and latency if recorded.
 *   - **html**: single self-contained `.html` file with inline CSS in a
 *     tokyonight-ish palette. Same content as the markdown rendering but
 *     styled. Mobile-friendly. No external assets, no scripts, no
 *     trackers — just `<style>` and `<body>`.
 *   - **json**: a pretty-printed normalisation pass (2-space indent)
 *     through `TraceSchema`. Mostly useful for round-tripping a
 *     hand-edited trace through validation before sharing.
 *
 * Long tool-call result previews are truncated with a real ellipsis (`…`,
 * U+2026) — never `...` — so the output looks intentional, not malformed.
 *
 * Like `bless` and `redact`, `export` validates the input against
 * `validateAgentbenchFile` before rendering. Refusing to render an
 * invalid trace keeps the promise: if `export` produced this file, the
 * input was a real trace.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolCall, Trace, TraceStep } from "./trace.js";
import { TraceSchema } from "./trace.js";
import { validateAgentbenchFile } from "./validate.js";

export type ExportFormat = "markdown" | "html" | "json";

export interface ExportOptions {
  /** Path to the trace file to read. */
  tracePath: string;
  /** Output format. Defaults to `"markdown"` at the CLI layer. */
  format: ExportFormat;
  /**
   * Where to write the rendered file. Defaults to a sibling of the input
   * named `<basename>.{md|html|json}`.
   */
  outPath?: string;
}

export interface ExportResult {
  /** Absolute path of the input trace file. */
  tracePath: string;
  /** Format actually rendered. */
  format: ExportFormat;
  /** Absolute path the rendered file was written to. */
  outPath: string;
  /** Bytes written to disk (utf-8). */
  bytesWritten: number;
}

/** Thrown when the trace JSON parses but isn't a valid Trace. */
export class InvalidTraceError extends Error {
  constructor(tracePath: string, summary: string) {
    super(
      `refusing to export an invalid trace: ${tracePath}\n  ${summary}\n  rendering an invalid trace would just produce confusing output — fix the file (or re-record) before exporting`,
    );
    this.name = "InvalidTraceError";
  }
}

/** Result-preview cap for tool-call result rendering. */
const RESULT_PREVIEW_LIMIT = 240;
/** Real ellipsis. Use this — never `...`. */
const ELLIPSIS = "…";

/** Map a format name to its on-disk extension (no leading dot). */
const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  markdown: "md",
  html: "html",
  json: "json",
};

/**
 * Render a trace file as Markdown, HTML, or pretty-printed JSON. See
 * {@link ExportOptions}.
 *
 * Order of operations:
 *
 *   1. Validate the input against `TraceSchema` via `validateAgentbenchFile`
 *      (same path `compare` / `bless` / `redact` rely on). Refuse to render
 *      anything that isn't a valid trace.
 *   2. Re-parse the validated JSON into a typed `Trace`. `validate` proves
 *      the shape; this gives us the typed object to walk.
 *   3. Render to the requested format. Pure string assembly — no template
 *      engine, no HTML parser, nothing on the dep tree.
 *   4. Resolve the output path (explicit `outPath` wins; otherwise sibling
 *      with the format extension).
 *   5. Write. No atomic-rename dance here — `export` is a derived
 *      artifact, not a baseline; partial writes are fine to redo.
 */
export async function exportTrace(options: ExportOptions): Promise<ExportResult> {
  const tracePath = path.resolve(options.tracePath);

  // 1. Validate. validateAgentbenchFile already handles missing files,
  //    malformed JSON, and schema drift in one place — re-use it so the
  //    validator and the renderer can never disagree on what counts as a
  //    valid trace.
  const validation = await validateAgentbenchFile(tracePath);
  if (!validation.ok) {
    throw new InvalidTraceError(tracePath, validation.files[0]?.summary ?? validation.summary);
  }

  // 2. Re-parse into a typed Trace. We know it parses (validate just
  //    succeeded), so this can only throw on a race where the file
  //    changed between the two reads. Surface that clearly.
  let raw: string;
  try {
    raw = await readFile(tracePath, "utf8");
  } catch (err) {
    throw new Error(`could not read trace ${tracePath}: ${(err as Error).message}`);
  }
  const parseResult = TraceSchema.safeParse(JSON.parse(raw));
  if (!parseResult.success) {
    // Defensive: validate just said the file was fine. If we land here the
    // file changed under us. Tell the user that, don't pretend we got a
    // schema error.
    throw new Error(
      `trace changed between validation and render: ${tracePath} — re-run \`agentbench export\``,
    );
  }
  const trace = parseResult.data;

  // 3. Render.
  let rendered: string;
  switch (options.format) {
    case "markdown":
      rendered = renderMarkdown(trace);
      break;
    case "html":
      rendered = renderHtml(trace);
      break;
    case "json":
      rendered = renderJson(trace);
      break;
  }

  // 4. Resolve output path.
  const outPath = options.outPath
    ? path.resolve(options.outPath)
    : defaultOutPath(tracePath, options.format);

  // 5. Write. Plain write — derived artifact, no atomic rename needed.
  await writeFile(outPath, rendered, "utf8");

  return {
    tracePath,
    format: options.format,
    outPath,
    bytesWritten: Buffer.byteLength(rendered, "utf8"),
  };
}

/**
 * Default output path: sibling of the input, basename with the format's
 * extension swapped in. `recordings/refund.json` + `markdown` →
 * `recordings/refund.md`.
 */
function defaultOutPath(tracePath: string, format: ExportFormat): string {
  const dir = path.dirname(tracePath);
  const base = path.basename(tracePath);
  const ext = path.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return path.join(dir, `${stem}.${FORMAT_EXTENSIONS[format]}`);
}

// ---------- Markdown renderer ----------------------------------------------

/**
 * Render a trace as Markdown. Plain string assembly — no templating engine,
 * no Markdown library. Output uses sentence-case headings to keep the
 * report readable as prose, not as an enum.
 *
 * Structure:
 *
 *   # <name>
 *
 *   - Name: <name>
 *   - Model: <model | n/a>
 *   - Steps: <count>
 *
 *   ## Step 1 — user
 *   > content
 *
 *   ## Step 2 — assistant
 *   content prose
 *   ### Tool calls
 *   #### 1. tool_name
 *   - Arguments
 *   ```json ... ```
 *   - Result: <preview>
 *   - Latency: <n> ms
 */
function renderMarkdown(trace: Trace): string {
  const lines: string[] = [];

  lines.push(`# ${trace.name}`);
  lines.push("");
  lines.push(`- Name: ${trace.name}`);
  lines.push(`- Model: ${trace.model ?? "n/a"}`);
  lines.push(`- Steps: ${trace.steps.length}`);
  lines.push("");

  if (trace.steps.length === 0) {
    lines.push("_No steps recorded._");
    lines.push("");
    return `${lines.join("\n")}`;
  }

  for (let i = 0; i < trace.steps.length; i++) {
    const step = trace.steps[i];
    if (!step) continue;
    lines.push(`## Step ${i + 1} — ${step.kind}`);
    lines.push("");
    appendStepMarkdown(lines, step);
    lines.push("");
  }

  // Single trailing newline — friendly to POSIX tools.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function appendStepMarkdown(lines: string[], step: TraceStep): void {
  if (step.kind === "user") {
    if (step.content.trim() === "") {
      lines.push("> _(empty)_");
      return;
    }
    // Blockquote every line of user content — keeps multi-line input
    // visually distinct from assistant prose.
    for (const ln of step.content.split("\n")) {
      lines.push(`> ${ln}`);
    }
    return;
  }
  // assistant
  if (step.content.trim() !== "") {
    lines.push(step.content);
    lines.push("");
  }
  if (step.toolCalls.length === 0) {
    if (step.content.trim() === "") {
      lines.push("_(no content, no tool calls)_");
    }
    return;
  }
  lines.push("### Tool calls");
  lines.push("");
  for (let i = 0; i < step.toolCalls.length; i++) {
    const call = step.toolCalls[i];
    if (!call) continue;
    appendToolCallMarkdown(lines, i + 1, call);
  }
}

function appendToolCallMarkdown(lines: string[], index: number, call: ToolCall): void {
  lines.push(`#### ${index}. \`${call.name}\``);
  lines.push("");
  lines.push("- Arguments:");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(call.arguments ?? {}, null, 2));
  lines.push("```");
  lines.push("");
  if (call.result !== undefined) {
    lines.push(`- Result: ${formatResultPreview(call.result)}`);
  }
  if (typeof call.latencyMs === "number") {
    lines.push(`- Latency: ${call.latencyMs} ms`);
  }
  lines.push("");
}

/**
 * Format a tool-call `result` for inline rendering. Strings render verbatim
 * (truncated with a real ellipsis if long); everything else is
 * JSON-stringified. Newlines are collapsed to spaces so the preview always
 * fits on one line in the markdown bullet.
 */
function formatResultPreview(result: unknown): string {
  let s: string;
  if (typeof result === "string") {
    s = result;
  } else {
    try {
      s = JSON.stringify(result);
    } catch {
      s = String(result);
    }
  }
  // Collapse runs of whitespace + newlines so a one-line bullet stays a
  // one-line bullet. Deliberately destructive — full result preservation
  // is the JSON export's job, not Markdown's.
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > RESULT_PREVIEW_LIMIT) {
    return `\`${s.slice(0, RESULT_PREVIEW_LIMIT)}${ELLIPSIS}\``;
  }
  return `\`${s}\``;
}

// ---------- HTML renderer --------------------------------------------------

/**
 * Render a trace as a self-contained HTML document. Inline `<style>` only,
 * no `<script>`, no external assets — safe to paste into a GitHub gist or
 * attach to an email. tokyonight-ish palette (deep blue background, soft
 * lavender + cyan accents, off-white prose). Mobile-friendly via a single
 * `max-width` and the meta-viewport tag.
 */
function renderHtml(trace: Trace): string {
  const parts: string[] = [];

  parts.push("<!doctype html>");
  parts.push('<html lang="en">');
  parts.push("<head>");
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  parts.push(`<title>${escapeHtml(trace.name)} — agentbench export</title>`);
  parts.push(`<style>${HTML_STYLES}</style>`);
  parts.push("</head>");
  parts.push("<body>");
  parts.push('<main class="trace">');

  parts.push("<header>");
  parts.push(`<h1>${escapeHtml(trace.name)}</h1>`);
  parts.push('<dl class="meta">');
  parts.push(`<dt>Name</dt><dd>${escapeHtml(trace.name)}</dd>`);
  parts.push(`<dt>Model</dt><dd>${escapeHtml(trace.model ?? "n/a")}</dd>`);
  parts.push(`<dt>Steps</dt><dd>${trace.steps.length}</dd>`);
  parts.push("</dl>");
  parts.push("</header>");

  if (trace.steps.length === 0) {
    parts.push('<p class="empty"><em>No steps recorded.</em></p>');
  } else {
    for (let i = 0; i < trace.steps.length; i++) {
      const step = trace.steps[i];
      if (!step) continue;
      parts.push(renderStepHtml(i + 1, step));
    }
  }

  parts.push("</main>");
  parts.push("</body>");
  parts.push("</html>");
  parts.push("");

  return parts.join("\n");
}

function renderStepHtml(index: number, step: TraceStep): string {
  const parts: string[] = [];
  parts.push(`<section class="step step--${step.kind}">`);
  parts.push(
    `<h2><span class="step-index">Step ${index}</span> <span class="step-kind">${step.kind}</span></h2>`,
  );

  if (step.kind === "user") {
    if (step.content.trim() === "") {
      parts.push('<blockquote class="user-content"><em>(empty)</em></blockquote>');
    } else {
      parts.push(
        `<blockquote class="user-content">${renderMultilineHtml(step.content)}</blockquote>`,
      );
    }
  } else {
    if (step.content.trim() !== "") {
      parts.push(`<div class="assistant-content">${renderMultilineHtml(step.content)}</div>`);
    }
    if (step.toolCalls.length === 0) {
      if (step.content.trim() === "") {
        parts.push('<p class="empty"><em>(no content, no tool calls)</em></p>');
      }
    } else {
      parts.push('<section class="tool-calls">');
      parts.push("<h3>Tool calls</h3>");
      for (let i = 0; i < step.toolCalls.length; i++) {
        const call = step.toolCalls[i];
        if (!call) continue;
        parts.push(renderToolCallHtml(i + 1, call));
      }
      parts.push("</section>");
    }
  }

  parts.push("</section>");
  return parts.join("\n");
}

function renderToolCallHtml(index: number, call: ToolCall): string {
  const parts: string[] = [];
  parts.push('<article class="tool-call">');
  parts.push(
    `<h4><span class="tool-index">${index}.</span> <code>${escapeHtml(call.name)}</code></h4>`,
  );
  parts.push("<dl>");
  parts.push("<dt>Arguments</dt>");
  parts.push(
    `<dd><pre><code class="lang-json">${escapeHtml(
      JSON.stringify(call.arguments ?? {}, null, 2),
    )}</code></pre></dd>`,
  );
  if (call.result !== undefined) {
    parts.push("<dt>Result</dt>");
    parts.push(
      `<dd><code class="result">${escapeHtml(formatResultPreviewPlain(call.result))}</code></dd>`,
    );
  }
  if (typeof call.latencyMs === "number") {
    parts.push("<dt>Latency</dt>");
    parts.push(`<dd>${call.latencyMs} ms</dd>`);
  }
  parts.push("</dl>");
  parts.push("</article>");
  return parts.join("\n");
}

/**
 * HTML-safe variant of `formatResultPreview` — no surrounding backticks
 * (the `<code>` element supplies the visual cue) and the ellipsis still
 * uses the real U+2026 character so it survives copy-paste cleanly.
 */
function formatResultPreviewPlain(result: unknown): string {
  let s: string;
  if (typeof result === "string") {
    s = result;
  } else {
    try {
      s = JSON.stringify(result);
    } catch {
      s = String(result);
    }
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > RESULT_PREVIEW_LIMIT) {
    return `${s.slice(0, RESULT_PREVIEW_LIMIT)}${ELLIPSIS}`;
  }
  return s;
}

/**
 * Render multi-line content: split on newlines, HTML-escape each line,
 * join with `<br>`. Preserves paragraph breaks visually without
 * introducing `<p>` tags that would fight with the surrounding
 * blockquote/div container.
 */
function renderMultilineHtml(s: string): string {
  return s.split("\n").map(escapeHtml).join("<br>\n");
}

function escapeHtml(s: string): string {
  // Standard 5-char escape. & first so we don't double-escape entities
  // produced by the later substitutions.
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Inline stylesheet. Tokyonight-ish palette: deep navy background, soft
 * lavender text, cyan + magenta accents. System font for prose, monospaced
 * for code. Mobile-first — `max-width` on `.trace` is the only width
 * constraint, so the report flows freely on narrow viewports.
 */
const HTML_STYLES = `
:root {
  --bg: #1a1b26;
  --bg-elev: #1f2335;
  --bg-code: #16161e;
  --fg: #c0caf5;
  --fg-dim: #9aa5ce;
  --fg-mute: #565f89;
  --accent: #7dcfff;
  --accent-warm: #bb9af7;
  --rule: #2a2e42;
  --user: #9ece6a;
  --assistant: #7dcfff;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); }
body {
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.trace { max-width: 760px; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
header { border-bottom: 1px solid var(--rule); padding-bottom: 1.25rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.75rem; margin: 0 0 1rem; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 1.15rem; margin: 0 0 .75rem; font-weight: 600; letter-spacing: -0.005em; }
h3 { font-size: .95rem; margin: 1.25rem 0 .5rem; font-weight: 600; color: var(--fg-dim); }
h4 { font-size: .9rem; margin: 1rem 0 .5rem; font-weight: 600; color: var(--fg-dim); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; margin: 0; font-size: .9rem; }
.meta dt { color: var(--fg-mute); font-weight: 500; }
.meta dd { margin: 0; color: var(--fg); }
.step { padding: 1.25rem 0; border-bottom: 1px solid var(--rule); }
.step:last-of-type { border-bottom: none; }
.step-index { color: var(--fg-mute); font-weight: 500; }
.step-kind { color: var(--accent); text-transform: lowercase; }
.step--user .step-kind { color: var(--user); }
.step--assistant .step-kind { color: var(--assistant); }
blockquote.user-content {
  margin: 0; padding: .75rem 1rem; border-left: 3px solid var(--user);
  background: var(--bg-elev); border-radius: 0 6px 6px 0; color: var(--fg);
}
.assistant-content { color: var(--fg); margin-bottom: .25rem; }
.tool-calls { margin-top: .5rem; }
.tool-call { padding: .75rem 0; border-top: 1px dashed var(--rule); }
.tool-call:first-of-type { border-top: none; padding-top: .25rem; }
.tool-index { color: var(--fg-mute); }
.tool-call dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem; margin: 0; font-size: .9rem; }
.tool-call dt { color: var(--fg-mute); font-weight: 500; padding-top: .15rem; }
.tool-call dd { margin: 0; color: var(--fg); min-width: 0; }
code, pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; font-size: .85rem; }
code { color: var(--accent-warm); }
pre {
  margin: 0; padding: .75rem .9rem; background: var(--bg-code); border-radius: 6px;
  overflow-x: auto; border: 1px solid var(--rule);
}
pre code { color: var(--fg); background: none; padding: 0; }
.result { color: var(--fg); word-break: break-word; }
.empty { color: var(--fg-mute); font-style: italic; }
@media (max-width: 540px) {
  .trace { padding: 1.25rem .9rem 3rem; }
  h1 { font-size: 1.4rem; }
  .meta, .tool-call dl { grid-template-columns: 1fr; gap: .1rem; }
  .meta dt, .tool-call dt { color: var(--fg-mute); margin-top: .35rem; }
}
`.trim();

// ---------- JSON renderer --------------------------------------------------

/**
 * "Render" a trace as JSON. Just a normalisation pass: re-emit through
 * `TraceSchema`-validated data with 2-space indent and a trailing newline.
 * Useful for stripping noise (extra whitespace, key ordering) before
 * sharing.
 */
function renderJson(trace: Trace): string {
  return `${JSON.stringify(trace, null, 2)}\n`;
}

/** Render an `ExportResult` as a human-friendly one-line string. */
export function formatExport(result: ExportResult): string {
  return `wrote ${result.outPath} (${result.format}, ${result.bytesWritten} bytes)`;
}
