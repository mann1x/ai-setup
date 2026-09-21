import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, error: new Error('no csc in tests') })),
}));

const mockedExecSync = vi.mocked(execSync);

const VBS_OBSERVE =
  'wscript //nologo "C:/x/@rely-ai/caliber/dist/hook-runner.vbs" ' +
  '"C:/Program Files/nodejs/node.exe" "C:/x/@rely-ai/caliber/dist/bin.js" learn observe';
const VBS_FINALIZE =
  'wscript //nologo "C:/x/@rely-ai/caliber/dist/hook-runner.vbs" ' +
  '"C:/Program Files/nodejs/node.exe" "C:/x/@rely-ai/caliber/dist/bin.js" learn finalize --auto';

/**
 * Hook commands are stored relative to the project root (`.claude/settings.json`),
 * so these tests need a real cwd rather than a mocked fs.
 */
describe('learning-hook refresh (an installed hook is not necessarily a current one)', () => {
  let cwd: string;
  let tmp: string;

  beforeEach(async () => {
    cwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caliber-hook-refresh-'));
    process.chdir(tmp);
    fs.mkdirSync('.claude');
    mockedExecSync.mockReturnValue('/usr/local/bin/caliber\n' as never);
    const { resetResolvedCaliber } = await import('../resolve-caliber.js');
    resetResolvedCaliber();
  });

  afterEach(() => {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function writeSettings(obj: unknown): void {
    fs.writeFileSync(path.join('.claude', 'settings.json'), JSON.stringify(obj, null, 2));
  }

  function readSettings(): {
    hooks: Record<string, Array<{ hooks: Array<{ command: string; description?: string }> }>>;
  } {
    return JSON.parse(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf-8'));
  }

  it('rewrites a stale caliber command an older version installed', async () => {
    // The wscript form is what a pre-fix install wrote. It is still a caliber
    // command, so `areLearningHooksInstalled()` says yes and installation is
    // skipped — which is why nothing but an explicit refresh can repair it.
    writeSettings({
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: VBS_OBSERVE }] }],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: VBS_FINALIZE }] }],
      },
    });

    const { installLearningHooks } = await import('../learning-hooks.js');
    const r = installLearningHooks();

    expect(r.alreadyInstalled).toBe(false); // two of four events were missing
    expect(r.refreshed).toBe(2);

    const after = readSettings();
    expect(after.hooks.PostToolUse[0].hooks[0].command).toBe(
      '/usr/local/bin/caliber learn observe',
    );
    expect(after.hooks.SessionEnd[0].hooks[0].command).toBe(
      '/usr/local/bin/caliber learn finalize --auto',
    );
    expect(JSON.stringify(after)).not.toContain('wscript');
  });

  it('refreshes a fully-installed project that install() would otherwise skip', async () => {
    writeSettings({
      hooks: {
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: VBS_OBSERVE }] }],
        PostToolUseFailure: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: VBS_OBSERVE.replace('observe', 'observe --failure') },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            matcher: '',
            hooks: [
              { type: 'command', command: VBS_OBSERVE.replace('observe', 'observe --prompt') },
            ],
          },
        ],
        SessionEnd: [{ matcher: '', hooks: [{ type: 'command', command: VBS_FINALIZE }] }],
      },
    });

    const { installLearningHooks, areLearningHooksInstalled } =
      await import('../learning-hooks.js');
    expect(areLearningHooksInstalled()).toBe(true);

    const r = installLearningHooks();
    expect(r).toEqual({ installed: false, alreadyInstalled: true, refreshed: 4 });
    expect(JSON.stringify(readSettings())).not.toContain('wscript');
  });

  it('is idempotent — a current project is rewritten zero times', async () => {
    const { installLearningHooks, refreshLearningHooks } = await import('../learning-hooks.js');
    installLearningHooks();
    const before = fs.readFileSync(path.join('.claude', 'settings.json'), 'utf-8');

    expect(refreshLearningHooks().updated).toBe(0);
    expect(fs.readFileSync(path.join('.claude', 'settings.json'), 'utf-8')).toBe(before);
  });

  it('leaves hooks that are not caliber alone', async () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: VBS_OBSERVE }] },
          { matcher: '', hooks: [{ type: 'command', command: 'my-own-linter --fix' }] },
        ],
      },
    });

    const { refreshLearningHooks } = await import('../learning-hooks.js');
    expect(refreshLearningHooks().updated).toBe(1);

    const after = readSettings();
    expect(after.hooks.PostToolUse[1].hooks[0].command).toBe('my-own-linter --fix');
  });

  it('preserves the entry the user may have re-described', async () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: VBS_OBSERVE, description: 'mine, do not touch' }],
          },
        ],
      },
    });

    const { refreshLearningHooks } = await import('../learning-hooks.js');
    refreshLearningHooks();

    const entry = readSettings().hooks.PostToolUse[0] as unknown as {
      matcher: string;
      hooks: Array<{ command: string; description?: string }>;
    };
    expect(entry.matcher).toBe('Edit');
    expect(entry.hooks[0].description).toBe('mine, do not touch');
    expect(entry.hooks[0].command).toBe('/usr/local/bin/caliber learn observe');
  });

  it('upgrades the SessionEnd refresh hook too', async () => {
    // Same hole in the other installer: findHookIndex() matches on identity,
    // so a stale refresh command reported "already enabled" forever.
    writeSettings({
      hooks: {
        SessionEnd: [
          {
            matcher: '',
            hooks: [
              {
                type: 'command',
                command:
                  'wscript //nologo "C:/x/@rely-ai/caliber/dist/hook-runner.vbs" ' +
                  '"C:/Program Files/nodejs/node.exe" ' +
                  '"C:/x/@rely-ai/caliber/dist/bin.js" refresh --quiet',
              },
            ],
          },
        ],
      },
    });

    const { installHook } = await import('../hooks.js');
    const r = installHook();
    expect(r).toEqual({ installed: false, alreadyInstalled: true, upgraded: true });
    expect(readSettings().hooks.SessionEnd[0].hooks[0].command).toBe(
      '/usr/local/bin/caliber refresh --quiet',
    );

    // Second run has nothing to do.
    expect(installHook().upgraded).toBe(false);
  });
});
