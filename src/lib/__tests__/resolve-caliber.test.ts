import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resolveCaliber,
  isNpxResolution,
  resetResolvedCaliber,
  isCaliberCommand,
  pickExecutable,
  displayCaliberName,
  resolveCaliberHookInvoker,
} from '../resolve-caliber.js';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';

function withPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, error: new Error('no csc in tests') })),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, existsSync: vi.fn(() => false) } };
});

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);

/**
 * Make the on-demand ``hook-launcher.exe`` compile appear to succeed.
 *
 * The launcher is built by ``ensureHookLauncher`` from the ``.cs`` source
 * shipped next to ``bin.js``, so the happy path needs four things to line up:
 * the source present, a Framework ``csc.exe`` found, a ``csc`` run that exits
 * 0, and the ``.exe`` on disk afterwards. The exe is absent before the
 * compile and present after it, which is what ``compiled`` tracks — asserting
 * against a mock that claims the exe already exists would never exercise the
 * compile at all.
 */
function mockLauncherCompile(): void {
  let compiled = false;
  vi.spyOn(fs, 'readdirSync').mockReturnValue(['v4.0.30319', 'v2.0.50727'] as never);
  vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith('hook-launcher.exe')) return compiled;
    return (
      s.endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
      s.endsWith('@rely-ai/caliber/dist/bin.js') ||
      s.endsWith('hook-launcher.cs') ||
      s.endsWith('csc.exe')
    );
  });
  mockedSpawnSync.mockImplementation((() => {
    compiled = true;
    return { status: 0, stdout: '', stderr: '' };
  }) as never);
}

describe('resolveCaliber', () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetResolvedCaliber();
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('returns bare npx command when argv[1] contains _npx and caliber/npx not on PATH', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc123/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const result = resolveCaliber();
    expect(result).toBe('npx --yes @rely-ai/caliber');
  });

  it('returns absolute npx path when in npx context and npx is on PATH but caliber is not', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc123/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('which caliber') || cmd.includes('where caliber'))
        throw new Error('not found');
      if (cmd.includes('which npx') || cmd.includes('where npx')) return '/opt/homebrew/bin/npx\n';
      throw new Error('unexpected');
    });
    const result = resolveCaliber();
    expect(result).toBe('/opt/homebrew/bin/npx --yes @rely-ai/caliber');
  });

  it('returns absolute caliber path when in npx context but caliber is globally installed', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc123/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('which caliber') || cmd.includes('where caliber'))
        return '/opt/homebrew/bin/caliber\n';
      throw new Error('unexpected');
    });
    const result = resolveCaliber();
    expect(result).toBe('/opt/homebrew/bin/caliber');
  });

  it('returns npx command when npm_execpath contains npx and caliber/npx not on PATH', () => {
    process.argv[1] = '/some/path/caliber';
    process.env.npm_execpath = '/usr/local/lib/node_modules/npm/bin/npx-cli.js';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    const result = resolveCaliber();
    expect(result).toBe('npx --yes @rely-ai/caliber');
  });

  it('returns absolute path when caliber is found on PATH', () => {
    process.argv[1] = '/usr/local/bin/caliber';
    delete process.env.npm_execpath;
    mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
    const result = resolveCaliber();
    expect(result).toBe('/usr/local/bin/caliber');
  });

  it('caches the result across calls', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    resolveCaliber();
    process.argv[1] = '/usr/local/bin/caliber';
    expect(resolveCaliber()).toBe('npx --yes @rely-ai/caliber');
  });

  it('resetResolvedCaliber clears the cache', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(resolveCaliber()).toBe('npx --yes @rely-ai/caliber');

    resetResolvedCaliber();
    process.argv[1] = '/usr/local/bin/caliber';
    delete process.env.npm_execpath;
    mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
    expect(resolveCaliber()).toBe('/usr/local/bin/caliber');
  });
});

describe('isNpxResolution', () => {
  beforeEach(() => {
    resetResolvedCaliber();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when resolved to bare npx', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(isNpxResolution()).toBe(true);
  });

  it('returns true when resolved to absolute-path npx', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('which caliber') || cmd.includes('where caliber'))
        throw new Error('not found');
      if (cmd.includes('which npx') || cmd.includes('where npx')) return '/opt/homebrew/bin/npx\n';
      throw new Error('unexpected');
    });
    expect(isNpxResolution()).toBe(true);
  });

  it('returns false when resolved to absolute caliber path', () => {
    process.argv[1] = '/usr/local/bin/caliber';
    delete process.env.npm_execpath;
    mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
    expect(isNpxResolution()).toBe(false);
  });
});

describe('pickExecutable', () => {
  it('returns the first line on POSIX', () => {
    withPlatform('linux', () => {
      expect(pickExecutable('/usr/local/bin/caliber\n/opt/bin/caliber')).toBe(
        '/usr/local/bin/caliber',
      );
    });
  });

  it('prefers .cmd over the POSIX shim on Windows', () => {
    withPlatform('win32', () => {
      const out =
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\caliber\nC:\\Users\\dev\\AppData\\Roaming\\npm\\caliber.cmd';
      expect(pickExecutable(out)).toBe('C:\\Users\\dev\\AppData\\Roaming\\npm\\caliber.cmd');
    });
  });

  it('prefers .exe / .bat over extensionless on Windows', () => {
    withPlatform('win32', () => {
      expect(pickExecutable('C:\\bin\\foo\nC:\\bin\\foo.exe')).toBe('C:\\bin\\foo.exe');
      expect(pickExecutable('C:\\bin\\foo\nC:\\bin\\foo.bat')).toBe('C:\\bin\\foo.bat');
    });
  });

  it('falls back to first line on Windows when no .cmd/.exe/.bat present', () => {
    withPlatform('win32', () => {
      expect(pickExecutable('C:\\bin\\foo\nC:\\bin\\bar')).toBe('C:\\bin\\foo');
    });
  });

  it('returns empty string for empty input', () => {
    expect(pickExecutable('')).toBe('');
    expect(pickExecutable('\n\n')).toBe('');
  });

  it('handles CRLF line endings from Windows `where`', () => {
    withPlatform('win32', () => {
      expect(pickExecutable('C:\\bin\\foo\r\nC:\\bin\\foo.cmd\r\n')).toBe('C:\\bin\\foo.cmd');
    });
  });

  it('matches the extension only — not `cmd` substrings in directory names', () => {
    withPlatform('win32', () => {
      expect(pickExecutable('C:\\cmd-tools\\bin\\caliber')).toBe('C:\\cmd-tools\\bin\\caliber');
      expect(pickExecutable('C:\\cmd-tools\\bin\\caliber\nC:\\cmd-tools\\bin\\caliber.cmd')).toBe(
        'C:\\cmd-tools\\bin\\caliber.cmd',
      );
    });
  });
});

describe('resolveCaliber on Windows', () => {
  beforeEach(() => {
    resetResolvedCaliber();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('selects caliber.cmd over the POSIX shim', () => {
    withPlatform('win32', () => {
      process.argv[1] = 'C:\\Users\\dev\\AppData\\Roaming\\npm\\caliber';
      delete process.env.npm_execpath;
      mockedExecSync.mockReturnValue(
        'C:\\Users\\dev\\AppData\\Roaming\\npm\\caliber\nC:\\Users\\dev\\AppData\\Roaming\\npm\\caliber.cmd\n',
      );
      expect(resolveCaliber()).toBe('C:\\Users\\dev\\AppData\\Roaming\\npm\\caliber.cmd');
    });
  });

  it('selects npx.cmd over the POSIX shim in npx context', () => {
    withPlatform('win32', () => {
      process.argv[1] =
        'C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\caliber';
      mockedExecSync.mockImplementation((cmd: string) => {
        if (cmd.includes('where caliber')) throw new Error('not found');
        if (cmd.includes('where npx'))
          return 'C:\\Users\\dev\\AppData\\Roaming\\npm\\npx\nC:\\Users\\dev\\AppData\\Roaming\\npm\\npx.cmd\n';
        throw new Error('unexpected');
      });
      const result = resolveCaliber();
      expect(result).toBe('C:\\Users\\dev\\AppData\\Roaming\\npm\\npx.cmd --yes @rely-ai/caliber');
      expect(isNpxResolution()).toBe(true);
    });
  });
});

describe('isCaliberCommand', () => {
  it('matches bare caliber with subcommand', () => {
    expect(isCaliberCommand('caliber refresh --quiet', 'refresh --quiet')).toBe(true);
  });

  it('matches absolute path', () => {
    expect(isCaliberCommand('/usr/local/bin/caliber refresh --quiet', 'refresh --quiet')).toBe(
      true,
    );
  });

  it('matches npx --yes form', () => {
    expect(isCaliberCommand('npx --yes @rely-ai/caliber refresh --quiet', 'refresh --quiet')).toBe(
      true,
    );
  });

  it('matches npx without --yes', () => {
    expect(isCaliberCommand('npx @rely-ai/caliber refresh --quiet', 'refresh --quiet')).toBe(true);
  });

  it('does not match unrelated commands', () => {
    expect(isCaliberCommand('npm run refresh --quiet', 'refresh --quiet')).toBe(false);
  });
});

describe('displayCaliberName (F-P0-3)', () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetResolvedCaliber();
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    resetResolvedCaliber();
    vi.restoreAllMocks();
  });

  it('returns "caliber" for global install (no npx)', () => {
    process.argv[1] = '/usr/local/bin/caliber';
    delete process.env.npm_execpath;
    mockedExecSync.mockReturnValue('/Users/someone/.nvm/versions/node/v20/bin/caliber\n');
    expect(displayCaliberName()).toBe('caliber');
  });

  it('returns "npx @rely-ai/caliber" when npx resolution is used', () => {
    process.argv[1] = '/home/user/.npm/_npx/abc/node_modules/.bin/caliber';
    mockedExecSync.mockImplementation(() => {
      throw new Error('not found');
    });
    expect(displayCaliberName()).toBe('npx @rely-ai/caliber');
  });

  it('does NOT return an absolute path even when caliber resolves to one', () => {
    process.argv[1] = '/usr/local/bin/caliber';
    delete process.env.npm_execpath;
    mockedExecSync.mockReturnValue('/Users/someone/.nvm/versions/node/v20/bin/caliber\n');
    const display = displayCaliberName();
    expect(display).not.toMatch(/^\//);
    expect(display).not.toContain('.nvm');
    expect(display).not.toContain('Users');
  });
});

describe('resolveCaliberHookInvoker (Windows cmd-shim bypass)', () => {
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    resetResolvedCaliber();
    // Both module mocks are shared across the file, and `not.toHaveBeenCalled`
    // on a leaked call list is an assertion that passes for the wrong reason.
    mockedExecSync.mockReset();
    mockedSpawnSync.mockReset();
    mockedSpawnSync.mockImplementation((() => ({
      status: 1,
      error: new Error('no csc in tests'),
    })) as never);
    originalArgv = [...process.argv];
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    resetResolvedCaliber();
    vi.restoreAllMocks();
  });

  it('on POSIX returns the resolveCaliber() value unchanged', () => {
    withPlatform('linux', () => {
      mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
      expect(resolveCaliberHookInvoker()).toBe('/usr/local/bin/caliber');
    });
  });

  it('on Windows returns the .cmd path unchanged when bin.js is missing', () => {
    withPlatform('win32', () => {
      // No bin.js sibling (existsSync mock returns false by default).
      mockedExecSync.mockReturnValue('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n');
      const got = resolveCaliberHookInvoker();
      expect(got).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd');
    });
  });

  it('on Windows returns node-direct invocation when .cmd + bin.js + node are present', () => {
    withPlatform('win32', () => {
      // Two execSync calls: first `where caliber`, then `where node`.
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      // bin.js sibling exists.
      vi.spyOn(fs, 'existsSync').mockImplementation(
        (p) =>
          String(p).endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
          String(p).endsWith('@rely-ai/caliber/dist/bin.js'),
      );

      const got = resolveCaliberHookInvoker();
      // Forward-slashed both paths, both quoted, no `caliber.cmd` anywhere.
      expect(got).toContain('"C:/Program Files/nodejs/node.exe"');
      expect(got).toContain('@rely-ai/caliber/dist/bin.js"');
      expect(got).not.toContain('.cmd');
    });
  });

  it('on Windows wraps in hook-launcher.exe, compiling it on demand', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      mockLauncherCompile();

      const got = resolveCaliberHookInvoker();
      // '"<launcher>" "<node>" "<bin.js>"' — the launcher replaces the
      // node.exe console window, not the node invocation inside it, so both
      // the interpreter and the script stay in the command.
      expect(got).toMatch(/^"[^"]*hook-launcher\.exe" /);
      expect(got).toContain('"C:/Program Files/nodejs/node.exe"');
      expect(got).toContain('@rely-ai/caliber/dist/bin.js"');
      expect(got).not.toContain('wscript');
      expect(got).not.toContain('.cmd');

      // Built with the Windows subsystem, or the launcher gets the very
      // console window it exists to suppress, and from the newest Framework.
      const [csc, args] = mockedSpawnSync.mock.calls[0] as [string, string[]];
      expect(csc).toContain('Framework64');
      expect(csc).toContain('v4.0.30319');
      expect(args).toContain('/target:winexe');
      expect(args.some((a) => a.startsWith('/out:') && a.endsWith('hook-launcher.exe'))).toBe(true);
    });
  });

  it('on Windows reuses an existing launcher rather than recompiling', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return (
          s.endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
          s.endsWith('@rely-ai/caliber/dist/bin.js') ||
          s.endsWith('hook-launcher.cs') ||
          s.endsWith('hook-launcher.exe')
        );
      });
      // Source older than the exe — nothing to rebuild.
      vi.spyOn(fs, 'statSync').mockImplementation(
        ((p: fs.PathLike) =>
          ({ mtimeMs: String(p).endsWith('.cs') ? 1000 : 2000 }) as fs.Stats) as never,
      );

      const got = resolveCaliberHookInvoker();
      expect(got).toMatch(/^"[^"]*hook-launcher\.exe" /);
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });
  });

  it('on Windows rebuilds the launcher when the shipped source is newer', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      mockLauncherCompile();
      // An upgrade ships a new .cs over the previous version's .exe. Keeping
      // the stale binary is the failure this guards: it would run the old
      // launcher forever, and the whole point of shipping source is that the
      // fix arrives with the package.
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return (
          s.endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
          s.endsWith('@rely-ai/caliber/dist/bin.js') ||
          s.endsWith('hook-launcher.cs') ||
          s.endsWith('hook-launcher.exe') ||
          s.endsWith('csc.exe')
        );
      });
      vi.spyOn(fs, 'statSync').mockImplementation(
        ((p: fs.PathLike) =>
          ({ mtimeMs: String(p).endsWith('.cs') ? 9000 : 1000 }) as fs.Stats) as never,
      );

      resolveCaliberHookInvoker();
      expect(mockedSpawnSync).toHaveBeenCalledTimes(1);
    });
  });

  it('on Windows falls back to node-direct when the launcher cannot be built', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      // Source is there; no Framework csc (readdirSync throws, as it does on
      // any non-Windows host). A missing compiler must cost the flash, not
      // the hook — node-direct works, it is merely visible.
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        return (
          s.endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
          s.endsWith('@rely-ai/caliber/dist/bin.js') ||
          s.endsWith('hook-launcher.cs')
        );
      });
      vi.spyOn(fs, 'readdirSync').mockImplementation((() => {
        throw new Error('ENOENT');
      }) as never);

      const got = resolveCaliberHookInvoker();
      expect(got).not.toContain('hook-launcher');
      expect(got).toContain('"C:/Program Files/nodejs/node.exe"');
      expect(got).toContain('@rely-ai/caliber/dist/bin.js"');
    });
  });

  it('on Windows falls back to node-direct when the compile fails', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockReturnValueOnce('C:\\Program Files\\nodejs\\node.exe\n');
      vi.spyOn(fs, 'readdirSync').mockReturnValue(['v4.0.30319'] as never);
      vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('hook-launcher.exe')) return false;
        return (
          s.endsWith('@rely-ai\\caliber\\dist\\bin.js') ||
          s.endsWith('@rely-ai/caliber/dist/bin.js') ||
          s.endsWith('hook-launcher.cs') ||
          s.endsWith('csc.exe')
        );
      });
      mockedSpawnSync.mockImplementation((() => ({
        status: 1,
        stdout: '',
        stderr: 'error CS1002',
      })) as never);

      const got = resolveCaliberHookInvoker();
      expect(got).not.toContain('hook-launcher');
      expect(got).toContain('@rely-ai/caliber/dist/bin.js"');
    });
  });

  it('never builds a launcher off Windows', () => {
    withPlatform('linux', () => {
      mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
      expect(resolveCaliberHookInvoker()).toBe('/usr/local/bin/caliber');
      expect(mockedSpawnSync).not.toHaveBeenCalled();
    });
  });

  it('on Windows falls back to .cmd when `where node` fails', () => {
    withPlatform('win32', () => {
      mockedExecSync
        .mockReturnValueOnce('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd\n')
        .mockImplementationOnce(() => {
          throw new Error('node not on PATH');
        });
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);

      const got = resolveCaliberHookInvoker();
      expect(got).toBe('C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd');
    });
  });

  it('caches per process — second call does not re-shell out', () => {
    withPlatform('linux', () => {
      mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n');
      const first = resolveCaliberHookInvoker();
      const callsAfterFirst = mockedExecSync.mock.calls.length;
      const second = resolveCaliberHookInvoker();
      expect(second).toBe(first);
      expect(mockedExecSync.mock.calls.length).toBe(callsAfterFirst);
    });
  });
});

describe('isCaliberCommand — node-direct + .cmd shim variants', () => {
  it('matches the hook-launcher-wrapped form', () => {
    // The wrapper prefix must not make an existing entry look foreign, or
    // the installer writes a second hook alongside the first and every tool
    // call runs caliber twice.
    const cmd =
      '"C:/Users/u/AppData/Roaming/npm/node_modules/@rely-ai/caliber/dist/hook-launcher.exe" ' +
      '"C:/Program Files/nodejs/node.exe" ' +
      '"C:/Users/u/AppData/Roaming/npm/node_modules/@rely-ai/caliber/dist/bin.js" learn observe';
    expect(isCaliberCommand(cmd, 'learn observe')).toBe(true);
  });

  it('still matches the legacy wscript-wrapped form left in settings.json', () => {
    // Upgrading replaces the resolver, not the commands already written to
    // disk; those keep working (visibly, and with the stdio defect) until
    // something rewrites them.
    const cmd =
      'wscript //nologo "C:/x/@rely-ai/caliber/dist/hook-runner.vbs" ' +
      '"C:/Program Files/nodejs/node.exe" "C:/x/@rely-ai/caliber/dist/bin.js" learn observe';
    expect(isCaliberCommand(cmd, 'learn observe')).toBe(true);
  });

  it('matches the node-direct hook invoker output format', () => {
    const cmd =
      '"C:/Program Files/nodejs/node.exe" ' +
      '"C:/Users/u/AppData/Roaming/npm/node_modules/@rely-ai/caliber/dist/bin.js" ' +
      'learn observe';
    expect(isCaliberCommand(cmd, 'learn observe')).toBe(true);
  });

  it('matches an absolute caliber.cmd shim invocation', () => {
    const cmd = '"C:\\Users\\u\\AppData\\Roaming\\npm\\caliber.cmd" learn observe';
    expect(isCaliberCommand(cmd, 'learn observe')).toBe(true);
  });

  it('does not match unrelated bin.js paths', () => {
    const cmd =
      '"C:/Program Files/nodejs/node.exe" ' +
      '"C:/some/other/package/dist/bin.js" ' +
      'learn observe';
    expect(isCaliberCommand(cmd, 'learn observe')).toBe(false);
  });
});
