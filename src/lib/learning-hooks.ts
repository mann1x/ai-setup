import fs from 'fs';
import path from 'path';
import { resolveCaliberHookInvoker, isCaliberCommand } from './resolve-caliber.js';

// ── Claude Code hooks ────────────────────────────────────────────────

const SETTINGS_PATH = path.join('.claude', 'settings.json');

const HOOK_TAILS = [
  {
    event: 'PostToolUse',
    tail: 'learn observe',
    description: 'Caliber: recording tool usage for session learning',
  },
  {
    event: 'PostToolUseFailure',
    tail: 'learn observe --failure',
    description: 'Caliber: recording tool failure for session learning',
  },
  {
    event: 'UserPromptSubmit',
    tail: 'learn observe --prompt',
    description: 'Caliber: recording user prompt for correction detection',
  },
  {
    event: 'SessionEnd',
    tail: 'learn finalize --auto',
    description: 'Caliber: finalizing session learnings',
  },
] as const;

function getHookConfigs() {
  // resolveCaliberHookInvoker() returns node-direct invocation on
  // Windows when the resolved caliber binary is a ``.cmd`` shim
  // (npm-global layout), bypassing the visible cmd.exe flash that
  // Claude Code would otherwise see on every hook fire. POSIX and
  // non-shim Windows installs fall through to the plain
  // ``resolveCaliber()`` path unchanged.
  const bin = resolveCaliberHookInvoker();
  return HOOK_TAILS.map(({ event, tail, description }) => ({
    event,
    command: `${bin} ${tail}`,
    tail,
    description,
  }));
}

interface HookEntry {
  type: string;
  command: string;
  description?: string;
}

interface HookMatcher {
  matcher: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(SETTINGS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function hasLearningHook(matchers: HookMatcher[], tail: string): boolean {
  return matchers.some((entry) => entry.hooks?.some((h) => isCaliberCommand(h.command, tail)));
}

export function areLearningHooksInstalled(): boolean {
  const settings = readSettings();
  if (!settings.hooks) return false;

  return HOOK_TAILS.every((cfg) => {
    const matchers = settings.hooks![cfg.event];
    return Array.isArray(matchers) && hasLearningHook(matchers, cfg.tail);
  });
}

/**
 * Rewrite caliber-owned hook commands that no longer match the invoker this
 * version resolves.
 *
 * Installation is identity-checked with ``isCaliberCommand``, which is
 * deliberately blind to the wrapper prefix — correct for "is this entry ours?"
 * and wrong for "is this entry current?". Without a refresh, changing *how*
 * the hook is invoked only ever reaches projects that had no hooks yet: the
 * ones already running the previous form look installed and get skipped
 * forever. That is precisely how the wscript wrapper went on discarding
 * stdin in existing projects long after the resolver stopped emitting it.
 *
 * Only the command text is touched. Position, matcher and description are
 * left alone, so an entry the user reordered or re-described stays theirs.
 */
export function refreshLearningHooks(): { updated: number } {
  const settings = readSettings();
  if (!settings.hooks) return { updated: 0 };

  let updated = 0;
  for (const cfg of getHookConfigs()) {
    const matchers = settings.hooks[cfg.event];
    if (!Array.isArray(matchers)) continue;
    for (const entry of matchers) {
      for (const h of entry.hooks ?? []) {
        if (isCaliberCommand(h.command, cfg.tail) && h.command !== cfg.command) {
          h.command = cfg.command;
          updated++;
        }
      }
    }
  }

  if (updated > 0) writeSettings(settings);
  return { updated };
}

export function installLearningHooks(): {
  installed: boolean;
  alreadyInstalled: boolean;
  refreshed: number;
} {
  if (areLearningHooksInstalled()) {
    // Present but possibly stale — an upgrade has to reach these too.
    return { installed: false, alreadyInstalled: true, refreshed: refreshLearningHooks().updated };
  }

  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};

  const configs = getHookConfigs();
  for (const cfg of configs) {
    if (!Array.isArray(settings.hooks[cfg.event])) {
      settings.hooks[cfg.event] = [];
    }

    if (!hasLearningHook(settings.hooks[cfg.event], cfg.tail)) {
      settings.hooks[cfg.event].push({
        matcher: '',
        hooks: [{ type: 'command', command: cfg.command, description: cfg.description }],
      });
    }
  }

  writeSettings(settings);
  // A partially-installed project can hold stale entries next to the ones
  // just added.
  return { installed: true, alreadyInstalled: false, refreshed: refreshLearningHooks().updated };
}

// ── Cursor hooks (https://cursor.com/docs/hooks) ─────────────────────
// Cursor uses .cursor/hooks.json with camelCase event names and a flatter structure.

const CURSOR_HOOKS_PATH = path.join('.cursor', 'hooks.json');

const CURSOR_HOOK_EVENTS = [
  { event: 'postToolUse', tail: 'learn observe' },
  { event: 'postToolUseFailure', tail: 'learn observe --failure' },
  { event: 'userPromptSubmit', tail: 'learn observe --prompt' },
  { event: 'sessionEnd', tail: 'learn finalize --auto' },
] as const;

interface CursorHooksConfig {
  version: number;
  hooks: Record<string, Array<{ command: string }>>;
}

function readCursorHooks(): CursorHooksConfig {
  if (!fs.existsSync(CURSOR_HOOKS_PATH)) return { version: 1, hooks: {} };
  try {
    return JSON.parse(fs.readFileSync(CURSOR_HOOKS_PATH, 'utf-8'));
  } catch {
    return { version: 1, hooks: {} };
  }
}

function writeCursorHooks(config: CursorHooksConfig): void {
  const dir = path.dirname(CURSOR_HOOKS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CURSOR_HOOKS_PATH, JSON.stringify(config, null, 2));
}

function hasCursorHook(entries: Array<{ command: string }>, tail: string): boolean {
  return entries.some((e) => isCaliberCommand(e.command, tail));
}

export function areCursorLearningHooksInstalled(): boolean {
  const config = readCursorHooks();
  return CURSOR_HOOK_EVENTS.every((cfg) => {
    const entries = config.hooks[cfg.event];
    return Array.isArray(entries) && hasCursorHook(entries, cfg.tail);
  });
}

/** ``refreshLearningHooks`` for Cursor's flatter ``.cursor/hooks.json``. */
export function refreshCursorLearningHooks(): { updated: number } {
  const config = readCursorHooks();
  const bin = resolveCaliberHookInvoker();

  let updated = 0;
  for (const cfg of CURSOR_HOOK_EVENTS) {
    const entries = config.hooks[cfg.event];
    if (!Array.isArray(entries)) continue;
    const desired = `${bin} ${cfg.tail}`;
    for (const e of entries) {
      if (isCaliberCommand(e.command, cfg.tail) && e.command !== desired) {
        e.command = desired;
        updated++;
      }
    }
  }

  if (updated > 0) writeCursorHooks(config);
  return { updated };
}

export function installCursorLearningHooks(): {
  installed: boolean;
  alreadyInstalled: boolean;
  refreshed: number;
} {
  if (areCursorLearningHooksInstalled()) {
    return {
      installed: false,
      alreadyInstalled: true,
      refreshed: refreshCursorLearningHooks().updated,
    };
  }

  const config = readCursorHooks();
  // Same Windows cmd-shim bypass as the Claude Code installer — see
  // ``resolveCaliberHookInvoker`` for the rationale.
  const bin = resolveCaliberHookInvoker();

  for (const cfg of CURSOR_HOOK_EVENTS) {
    if (!Array.isArray(config.hooks[cfg.event])) {
      config.hooks[cfg.event] = [];
    }
    if (!hasCursorHook(config.hooks[cfg.event], cfg.tail)) {
      config.hooks[cfg.event].push({ command: `${bin} ${cfg.tail}` });
    }
  }

  writeCursorHooks(config);
  return {
    installed: true,
    alreadyInstalled: false,
    refreshed: refreshCursorLearningHooks().updated,
  };
}

export function removeCursorLearningHooks(): { removed: boolean; notFound: boolean } {
  const config = readCursorHooks();
  let removedAny = false;

  for (const cfg of CURSOR_HOOK_EVENTS) {
    const entries = config.hooks[cfg.event];
    if (!Array.isArray(entries)) continue;

    const idx = entries.findIndex((e) => isCaliberCommand(e.command, cfg.tail));
    if (idx !== -1) {
      entries.splice(idx, 1);
      removedAny = true;
      if (entries.length === 0) delete config.hooks[cfg.event];
    }
  }

  if (!removedAny) return { removed: false, notFound: true };

  writeCursorHooks(config);
  return { removed: true, notFound: false };
}

// ── Claude Code hooks (continued) ────────────────────────────────────

export function removeLearningHooks(): { removed: boolean; notFound: boolean } {
  const settings = readSettings();
  if (!settings.hooks) return { removed: false, notFound: true };

  let removedAny = false;

  for (const cfg of HOOK_TAILS) {
    const matchers = settings.hooks[cfg.event];
    if (!Array.isArray(matchers)) continue;

    const idx = matchers.findIndex((entry) =>
      entry.hooks?.some((h) => isCaliberCommand(h.command, cfg.tail)),
    );
    if (idx !== -1) {
      matchers.splice(idx, 1);
      removedAny = true;

      if (matchers.length === 0) delete settings.hooks[cfg.event];
    }
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  if (!removedAny) return { removed: false, notFound: true };

  writeSettings(settings);
  return { removed: true, notFound: false };
}
