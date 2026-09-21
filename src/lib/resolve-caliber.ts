import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

let _resolved: string | null = null;

const WINDOWS_EXEC_EXT = /\.(cmd|exe|bat)$/i;
const NPX_RESOLUTION_RE = /[\\/]npx(?:\.(?:cmd|exe|bat))? --yes @rely-ai\/caliber$/i;

/**
 * Pick the best executable from `where`/`which` output.
 *
 * On Windows, npm installs both an extensionless POSIX shell shim and a
 * `.cmd` shim. `where` lists the POSIX shim first, but Node cannot exec it
 * directly — only `.cmd`/`.exe`/`.bat` are spawnable on Windows.
 */
export function pickExecutable(out: string): string {
  const lines = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (process.platform === 'win32') {
    return lines.find((l) => WINDOWS_EXEC_EXT.test(l)) ?? lines[0] ?? '';
  }
  return lines[0] ?? '';
}

/**
 * Resolve the absolute path to the `caliber` binary.
 * Caches the result so the lookup happens at most once per process.
 *
 * Always returns an absolute path when possible so that hook commands
 * embedded in .git/hooks/pre-commit or .claude/settings.json continue
 * to work even when the hook executor runs with a stripped $PATH
 * (e.g. Claude Code hooks use /usr/bin:/bin:/usr/sbin:/sbin on macOS).
 */
export function resolveCaliber(): string {
  if (_resolved) return _resolved;

  const whichCmd = process.platform === 'win32' ? 'where caliber' : 'which caliber';
  const whichNpxCmd = process.platform === 'win32' ? 'where npx' : 'which npx';

  // 0. Detect npx context — temp paths become stale after the npx process exits.
  //    Prefer a globally-installed caliber (stable absolute path). If not found,
  //    resolve npx to an absolute path so the hook command survives restricted $PATH.
  const isNpx = process.argv[1]?.includes('_npx') || process.env.npm_execpath?.includes('npx');
  if (isNpx) {
    // Prefer a globally-installed caliber over the ephemeral npx invocation
    try {
      const out = execSync(whichCmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      const caliberPath = pickExecutable(out);
      if (caliberPath) {
        _resolved = caliberPath;
        return _resolved;
      }
    } catch {
      // not globally installed — fall through to npx
    }
    // Resolve npx to an absolute path so hooks don't depend on $PATH at runtime
    try {
      const out = execSync(whichNpxCmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }).trim();
      const npxPath = pickExecutable(out);
      if (npxPath) {
        _resolved = `${npxPath} --yes @rely-ai/caliber`;
        return _resolved;
      }
    } catch {
      // npx not found on PATH — fall back to bare name
    }
    _resolved = 'npx --yes @rely-ai/caliber';
    return _resolved;
  }

  // 1. Find caliber on PATH — capture the absolute path so hook commands work
  //    in restricted $PATH environments (git hooks, Claude Code hooks, CI).
  try {
    const out = execSync(whichCmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    const caliberPath = pickExecutable(out);
    if (caliberPath) {
      _resolved = caliberPath;
      return _resolved;
    }
  } catch {
    // not on PATH — fall through
  }

  // 2. Derive from our own process.argv[1] (the script being executed)
  //    Only accept paths that look like a caliber binary — avoids picking up
  //    test runner scripts (vitest, jest) in CI/test environments.
  const binPath = process.argv[1];
  if (binPath && /caliber/.test(binPath) && fs.existsSync(binPath)) {
    _resolved = binPath;
    return _resolved;
  }

  // 3. Last resort: bare command (may still fail in /bin/sh)
  _resolved = 'caliber';
  return _resolved;
}

/** True when the resolved binary is a multi-word npx invocation (bare or absolute path). */
export function isNpxResolution(): boolean {
  const r = resolveCaliber();
  if (r === 'npx --yes @rely-ai/caliber') return true;
  // Match absolute paths on POSIX (/npx) and Windows (\npx, \npx.cmd, \npx.exe)
  return NPX_RESOLUTION_RE.test(r);
}

/**
 * Returns a display-friendly caliber binary name for embedding in
 * user-facing text and committed files (CLAUDE.md, skills, cursor rules).
 *
 * Unlike resolveCaliber() — which returns an absolute path so hook
 * subprocesses with stripped PATH can still find the binary — this
 * function returns just `caliber` (or `npx @rely-ai/caliber` for npx
 * users) on the assumption that the user's interactive shell has caliber
 * on PATH and that committed content will be read by teammates whose
 * absolute install paths differ.
 *
 * See audit finding F-P0-3 in
 * docs/superpowers/specs/2026-04-29-caliber-install-audit-findings.md
 */
export function displayCaliberName(): string {
  return isNpxResolution() ? 'npx @rely-ai/caliber' : 'caliber';
}

/** Reset cached resolution — only for tests. */
export function resetResolvedCaliber(): void {
  _resolved = null;
  _resolvedHookInvoker = null;
}

let _resolvedHookInvoker: string | null = null;

/**
 * Shared Windows cmd-shim bypass: given a ``caliber.cmd`` path, return
 * ``"<node>" "<.../dist/bin.js>"`` so callers can skip ``cmd.exe``.
 * Used by both the pre-commit hook (needs stdout — no VBS) and the
 * Claude/Cursor learning-hook invoker (may wrap with VBS).
 *
 * Returns null when the transformation can't apply — non-Windows, not
 * a ``.cmd``, unconventional npm layout, or ``node`` missing from PATH.
 */
export function resolveWindowsNodeBinInvocation(cmd: string): string | null {
  if (process.platform !== 'win32') return null;
  if (!/\.cmd$/i.test(cmd)) return null;

  const npmDir = path.dirname(cmd);
  const binJs = path.join(npmDir, 'node_modules', '@rely-ai', 'caliber', 'dist', 'bin.js');
  if (!fs.existsSync(binJs)) return null;

  let nodePath: string;
  try {
    const out = execSync('where node', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
    nodePath = pickExecutable(out);
    if (!nodePath) return null;
  } catch {
    return null;
  }

  const fwdNode = nodePath.replace(/\\/g, '/');
  const fwdBin = binJs.replace(/\\/g, '/');
  return `"${fwdNode}" "${fwdBin}"`;
}

/**
 * Build ``hook-launcher.exe`` next to ``bin.js`` if it is not there yet, and
 * return its path.
 *
 * Replaces the ``wscript`` + ``hook-runner.vbs`` wrapper, which hid the
 * console window but broke the hooks it wrapped. ``WScript.Shell.Run`` hands
 * the child a fresh console rather than the parent's pipes, so a hook reading
 * stdin saw nothing: ``learn observe`` waited out ``readStdin``'s 5 s timeout,
 * got an empty string, hit ``if (!raw.trim()) return;`` and recorded nothing —
 * five seconds per tool call, exit code 0, no error anywhere. Measured
 * 2026-09-21 on two machines running the same projects: with WSH,
 * ``eventCount`` 9 and frozen for four months; without it, 13728.
 *
 * The launcher instead calls CreateProcess with CREATE_NO_WINDOW *and*
 * STARTF_USESTDHANDLES pointed at this process's own handles, so the window
 * is suppressed and stdin/stdout/exit code survive. Both flags are needed;
 * CREATE_NO_WINDOW alone reproduces the VBS defect, because a child takes its
 * handles from STARTUPINFO only when STARTF_USESTDHANDLES is set.
 *
 * Compiled on demand with the csc.exe that ships with the .NET Framework on
 * every Windows, so no binary is published. Returns null on every failure —
 * not Windows, no compiler, no source, unwritable dist, compile error — and
 * the caller then uses the node-direct form, which works and merely flashes.
 */
function ensureHookLauncher(binJs: string): string | null {
  if (process.platform !== 'win32') return null;
  const dir = path.dirname(binJs);
  const exe = path.join(dir, 'hook-launcher.exe');
  const src = path.join(dir, 'hook-launcher.cs');
  try {
    if (fs.existsSync(exe)) {
      // Rebuild when the shipped source is newer, so an upgrade does not keep
      // running the previous version's launcher.
      if (!fs.existsSync(src) || fs.statSync(src).mtimeMs <= fs.statSync(exe).mtimeMs) {
        return exe;
      }
    }
    if (!fs.existsSync(src)) return null;
    const csc = findFrameworkCsc();
    if (!csc) return null;
    const res = spawnSync(csc, ['/nologo', '/target:winexe', '/optimize+', `/out:${exe}`, src], {
      encoding: 'utf-8',
      timeout: 60_000,
      windowsHide: true,
    });
    if (res.error || res.status !== 0 || !fs.existsSync(exe)) return null;
    return exe;
  } catch {
    return null;
  }
}

/** The csc.exe bundled with the .NET Framework, newest first. */
function findFrameworkCsc(): string | null {
  for (const root of [
    'C:\\Windows\\Microsoft.NET\\Framework64',
    'C:\\Windows\\Microsoft.NET\\Framework',
  ]) {
    let versions: string[];
    try {
      versions = fs
        .readdirSync(root)
        .filter((v) => v.startsWith('v'))
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const v of versions) {
      const csc = path.join(root, v, 'csc.exe');
      if (fs.existsSync(csc)) return csc;
    }
  }
  return null;
}

/**
 * Return the command prefix to embed in fire-and-forget hook command
 * strings (Claude settings.json / Cursor hooks.json learning hooks).
 *
 * On Windows: bypass the ``.cmd`` shim via ``resolveWindowsNodeBinInvocation``,
 * then wrap with ``hook-launcher.exe`` when it can be built (hides the
 * node.exe console flash). If it cannot be built, fall back to the
 * node-direct form rather than a hard hook failure.
 *
 * The launcher is stdio-transparent, which the previous ``wscript`` +
 * ``hook-runner.vbs`` wrapper was not — see ``ensureHookLauncher``. So the
 * old restriction is gone: this is now safe for hooks that need stdin or
 * stdout, and in fact every hook needs stdin, which is why the VBS silently
 * emptied the learning pipeline on Windows.
 */
export function resolveCaliberHookInvoker(): string {
  if (_resolvedHookInvoker) return _resolvedHookInvoker;

  const base = resolveCaliber();
  const nodeDirect = resolveWindowsNodeBinInvocation(base);
  if (!nodeDirect) {
    _resolvedHookInvoker = base;
    return _resolvedHookInvoker;
  }

  // Parse `"node" "bin.js"` back to paths for optional VBS wrapping.
  const match = nodeDirect.match(/^"([^"]+)" "([^"]+)"$/);
  if (!match) {
    _resolvedHookInvoker = nodeDirect;
    return _resolvedHookInvoker;
  }
  const [, fwdNode, fwdBin] = match;
  const launcher = ensureHookLauncher(fwdBin);
  if (launcher) {
    const fwdLauncher = launcher.replace(/\\/g, '/');
    _resolvedHookInvoker = `"${fwdLauncher}" "${fwdNode}" "${fwdBin}"`;
    return _resolvedHookInvoker;
  }

  _resolvedHookInvoker = nodeDirect;
  return _resolvedHookInvoker;
}

/**
 * Check whether a hook command refers to caliber, regardless of whether
 * it uses a bare `caliber` or an absolute path ending in `caliber`.
 * Matches by looking for the caliber binary name + the subcommand tail.
 *
 * Example: matches both `caliber refresh --quiet` and `/usr/local/bin/caliber refresh --quiet`
 */
export function isCaliberCommand(command: string, subcommandTail: string): boolean {
  // Exact legacy match
  if (command === `caliber ${subcommandTail}`) return true;
  // Absolute-path match: ends with /caliber <tail>
  if (command.endsWith(`/caliber ${subcommandTail}`)) return true;
  // Absolute-path match for Windows ``.cmd`` shim: ends with
  // /caliber.cmd <tail> (case-insensitive .cmd suffix)
  if (/[\\/]caliber\.cmd"? /i.test(command) && command.endsWith(` ${subcommandTail}`)) {
    return true;
  }
  // Bare npx match
  if (command === `npx --yes @rely-ai/caliber ${subcommandTail}`) return true;
  if (command === `npx @rely-ai/caliber ${subcommandTail}`) return true;
  // Absolute-path npx match: '/abs/path/npx --yes @rely-ai/caliber <tail>'
  if (command.endsWith(`/npx --yes @rely-ai/caliber ${subcommandTail}`)) return true;
  if (command.endsWith(`/npx @rely-ai/caliber ${subcommandTail}`)) return true;
  // Node-direct invocation match: '"<node>" "<...caliber/dist/bin.js>" <tail>'
  // — the Windows cmd-shim bypass. Matches the quoted bin.js suffix +
  // whitespace + tail; node prefix is variable across hosts so we don't
  // pin it. Accepts both forward and back slashes inside the quotes
  // because pre-commit shells store forward, claude.json stores either.
  // ALSO matches a wrapped form — '"<hook-launcher.exe>" "<node>"
  // "<bin.js>" <tail>', or the legacy 'wscript //nologo "<vbs>" ...' still
  // sitting in settings.json from an older install — because the bin.js
  // suffix is identical, and anything before it is wrapper noise that does
  // not change the caliber identity of the command.
  if (
    /[\\/]@rely-ai[\\/]caliber[\\/]dist[\\/]bin\.js"? /i.test(command) &&
    command.endsWith(` ${subcommandTail}`)
  ) {
    return true;
  }
  return false;
}
