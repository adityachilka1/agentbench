/**
 * Test-only helper for snapshotting the human-readable output of every
 * `agentbench` subcommand. Strategy B from the design note: instead of
 * spawning the built CLI as a child process (slow, depends on a fresh
 * `tsup` build, can't easily share fixtures), we directly call the
 * formatter functions the CLI's action handlers use and replicate the
 * tiny prefix/suffix decoration each handler applies (the `kleur.green("✓")`
 * mark, the trailing `\n`, the `mark` swap between green/yellow/red). The
 * helper then strips:
 *
 *   - ANSI color codes — `kleur` will emit them when stdout is a TTY but
 *     CI logs already disable colour; either way, snapshots must not
 *     drift on whether colour happens to be on.
 *   - Absolute paths — fixtures live under `os.tmpdir()` which differs
 *     between hosts (and is symlinked on macOS via `/private/var/folders/`).
 *     Replace any prefix matching the configured `tmp` root with `<tmp>`.
 *   - Timestamps — anything matching ISO 8601 (`2025-01-02T03:04:05.678Z`)
 *     becomes `<ts>`, so `list` / `validate` outputs that include mtime
 *     don't drift run-to-run.
 *   - Line endings — Windows CI runs `\r\n`; collapse to `\n`.
 *   - Path separators — `formatList` quotes paths with the platform
 *     separator; normalise quoted paths to forward-slash for Windows
 *     parity.
 *
 * The helper itself is ~50 LOC of pure string transformation — no
 * spawn(), no temp build, no surprise from a bundler.
 */

/** ANSI CSI / SGR escape sequences used by `kleur`. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: standard ANSI strip.
const ANSI_RE = /\[[0-9;]*m/g;

/** ISO 8601 instants — `list` records mtime as `2025-01-02T03:04:05.678Z`. */
const ISO_TS_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z/g;

export interface RenderedCli {
  stdout: string;
  exitCode: number;
}

export interface NormaliseOptions {
  /**
   * Absolute path prefix to redact to `<tmp>` — usually the fixtures'
   * realpath'd tmp dir. Substring match, not regex, so callers don't have
   * to escape platform path separators.
   */
  tmpPrefix?: string;
}

/**
 * Apply the documented normalisations to a captured stdout buffer. Pure —
 * no I/O. Exposed standalone so individual tests can normalise inline
 * fragments without going through `renderCommand`.
 */
export function normaliseCliOutput(raw: string, opts: NormaliseOptions = {}): string {
  let out = raw.replace(ANSI_RE, "");
  out = out.replace(/\r\n/g, "\n");
  if (opts.tmpPrefix !== undefined && opts.tmpPrefix !== "") {
    // Replace every occurrence — paths may repeat (per-trace path in
    // stats, largest-trace pointer, etc.).
    while (out.includes(opts.tmpPrefix)) {
      out = out.replace(opts.tmpPrefix, "<tmp>");
    }
  }
  out = out.replace(ISO_TS_RE, "<ts>");
  // Windows path separators inside any `<tmp>/...` substring → forward.
  // The redaction above means we only need to fix what's left of `<tmp>`.
  out = out.replace(/<tmp>([^\s)]*)/g, (_m, tail: string) => `<tmp>${tail.replace(/\\/g, "/")}`);
  return out;
}

/**
 * Run a small async action that returns the rendered CLI output as a
 * string (as if the action handler had concatenated everything it would
 * have written to stdout) and apply the snapshot-safe normalisations.
 *
 * The `exitCode` parameter mirrors what the CLI's action handler would
 * have passed to `process.exit`; tests can assert it alongside the
 * stdout. Defaults to 0 (the success path).
 */
export async function renderCommand(
  action: () => Promise<{ stdout: string; exitCode?: number }>,
  opts: NormaliseOptions = {},
): Promise<RenderedCli> {
  const { stdout, exitCode } = await action();
  return {
    stdout: normaliseCliOutput(stdout, opts),
    exitCode: exitCode ?? 0,
  };
}
