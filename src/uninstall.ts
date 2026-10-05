/**
 * `vscode:uninstall` hook.
 *
 * Runs from a bare Node process after VS Code exits, so it cannot use the
 * `vscode` API — it reads the state file the installer wrote. Without this, a
 * patched installation would stay patched (with a stale media URL) after the
 * extension is removed.
 *
 * Deliberately swallows every error: failing here must not break uninstalling.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { setChecksumValue, stateFilePath } from './workbench/installer';
import { CSS_FILE, BOOT_FILE, CORE_FILE, WEB_STUB_FILE, WEB_STUB_JS_FILE, ASSETS_FILE, LEGACY_FILES, checksum, isPatched, stripPatch } from './workbench/patch';

interface PatchState {
  appRoot: string;
  htmlPath: string;
  productPath: string;
  checksumKey: string;
  patchedChecksum?: string;
}

/** Every state file we may have written — one per VS Code installation. */
function listStateFiles(): string[] {
  const dir = dirname(stateFilePath());
  const found: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (/^workbench-patch(-[0-9a-f]{8})?\.json$/.test(name)) found.push(join(dir, name));
    }
  } catch {
    /* no state directory → nothing was patched */
  }
  return found;
}

async function restoreOne(statePath: string): Promise<void> {
  const state = JSON.parse(await readFile(statePath, 'utf8')) as PatchState;
  const htmlPath = state.htmlPath;
  const backupPath = `${htmlPath}.we-orig`;

  if (existsSync(htmlPath)) {
    const current = await readFile(htmlPath, 'utf8');
    const entryNow = readChecksumEntry(state);
    // Never write the pristine backup back after a VS Code update: it belongs to
    // the previous version, and restoring it would replace the new workbench.html.
    const tableReplaced = Boolean(state.patchedChecksum && entryNow && entryNow !== state.patchedChecksum);

    let restored: string | null = null;
    if (!isPatched(current)) {
      restored = null; // already clean — an update replaced the file
    } else if (tableReplaced || !existsSync(backupPath)) {
      restored = stripPatch(current);
    } else {
      const backup = await readFile(backupPath, 'utf8');
      restored = isPatched(backup) ? stripPatch(current) : backup;
    }

    if (restored !== null && restored !== current) {
      await writeFile(htmlPath, restored, 'utf8');
      if (existsSync(state.productPath)) {
        const product = await readFile(state.productPath, 'utf8');
        await writeFile(state.productPath, setChecksumValue(product, state.checksumKey, checksum(restored)), 'utf8');
      }
    }
  }

  const dir = dirname(htmlPath);
  for (const name of [CSS_FILE, BOOT_FILE, CORE_FILE, WEB_STUB_FILE, WEB_STUB_JS_FILE, ASSETS_FILE, ...LEGACY_FILES]) {
    await rm(join(dir, name), { force: true });
  }
  await rm(backupPath, { force: true });
  await rm(`${state.productPath}.we-orig`, { force: true });
  await rm(statePath, { force: true });
}

async function main(): Promise<void> {
  for (const statePath of listStateFiles()) {
    try {
      await restoreOne(statePath);
    } catch {
      /* one broken state file must not stop the others */
    }
  }
}

function readChecksumEntry(state: PatchState): string | null {
  try {
    const product = JSON.parse(readFileSync(state.productPath, 'utf8')) as { checksums?: Record<string, string> };
    return product.checksums?.[state.checksumKey] ?? null;
  } catch {
    return null;
  }
}

main().catch(() => {
  /* never break uninstall */
});
