#!/usr/bin/env node
// Copy the hook wrapper assets next to the bundled bin.js, so the path
// resolution in src/lib/resolve-caliber.ts can find them via the same
// npm-global layout assumption it uses for bin.js.
//
// Two assets, and only one of them is still used for new installs:
//
//   hook-runner.vbs   legacy. WScript.Shell.Run replaces the child's pipes
//                     with a fresh console, so a hook reading stdin got
//                     nothing: `learn observe` timed out after 5 s and
//                     recorded zero events. Kept only so an existing
//                     settings.json that still references it keeps working.
//   hook-launcher.cs  current. Compiled on demand on Windows into
//                     hook-launcher.exe (see resolveCaliberHookInvoker),
//                     hiding the console window while passing the real std
//                     handles through.
//
// Keep this script tiny and ESM so it runs under the same Node we use
// for the rest of the build pipeline without a transpile step.

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const name of ['hook-runner.vbs', 'hook-launcher.cs']) {
  const src = resolve(here, '..', 'assets', name);
  const dst = resolve(here, '..', 'dist', name);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  console.log(`copied: ${src} → ${dst}`);
}
