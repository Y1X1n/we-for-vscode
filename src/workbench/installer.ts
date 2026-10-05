/**
 * Workbench patch installer — the disk side of the 方案 B experiment.
 *
 * Everything is reversible and verified against the checksum table:
 *   enable()   backup → write patched html → write css/js → sync checksum
 *   disable()  restore backup → delete css/js → recompute checksum
 *   refresh()  re-inject with the current media URL (idempotent)
 *
 * The product.json checksum is recomputed from the bytes actually on disk, in
 * both directions, so `disable()` lands back on the vendor's original value
 * without us having to trust a copy of it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  CSS_FILE,
  BOOT_FILE,
  CORE_FILE,
  ASSETS_FILE,
  WEB_STUB_FILE,
  WEB_STUB_JS_FILE,
  LEGACY_FILES,
  checksum,
  checksumKeyFor,
  assetVersionFor,
  buildBootJs,
  buildCss,
  buildJs,
  buildWebStubHtml,
  buildWebStubJs,
  injectPatch,
  isPatched,
  stripPatch,
  WorkbenchPatchSettings,
} from './patch';

/** Everything the patch drops next to workbench.html (none of it is checksummed). */
export const PATCH_FILES: readonly string[] = [CSS_FILE, BOOT_FILE, CORE_FILE, WEB_STUB_FILE, WEB_STUB_JS_FILE, ASSETS_FILE];
/** Names older versions used; removed so a stale loader cannot be picked up. */
export const OBSOLETE_FILES: readonly string[] = [...LEGACY_FILES];

export interface WorkbenchTargets {
  appRoot: string;
  htmlPath: string;
  productPath: string;
  checksumKey: string;
  backupHtmlPath: string;
  backupProductPath: string;
}

export interface WorkbenchStatus extends Partial<WorkbenchTargets> {
  /** false when this install layout is not patchable (or appRoot is empty). */
  supported: boolean;
  patched: boolean;
  /** Set when product.json's checksum does not match the html on disk. */
  checksumMismatch?: boolean;
  /**
   * Set by enable() when it changed something a *running* window has already
   * loaded: the block itself, or the asset version the loader resolves at runtime.
   * Such a window keeps showing the previous css/js until it reloads — which is
   * exactly how an update can look like it did nothing. The caller prompts a reload
   * when this is true.
   */
  assetsUpdated?: boolean;
  reason?: string;
}

/**
 * State file the uninstall hook reads (it cannot use the vscode API).
 *
 * One file PER installation: this machine turned out to have two VS Code installs
 * (a user install on C: and another on E:), and a single shared state file meant
 * whichever install patched last would own it — leaving the other one patched with
 * no way to restore it. `appRoot` empty keeps the legacy shared name, which is
 * still read (and adopted) so an existing patch is not orphaned by this change.
 */
export function stateFilePath(appRoot = ''): string {
  const dir = join(homedir(), '.we-for-vscode');
  if (!appRoot) return join(dir, 'workbench-patch.json');
  const tag = createHash('sha1').update(appRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 8);
  return join(dir, `workbench-patch-${tag}.json`);
}

/** Every state file we might have written, for the uninstall hook to clean up. */
export function allStateFilePaths(): string[] {
  return [stateFilePath()];
}

const HTML_CANDIDATES = [
  'out/vs/code/electron-browser/workbench/workbench.html',
  'out/vs/code/electron-sandbox/workbench/workbench.html',
];

export function resolveTargets(appRoot: string): WorkbenchTargets | null {  if (!appRoot) return null;
  const productPath = join(appRoot, 'product.json');
  if (!existsSync(productPath)) return null;
  for (const rel of HTML_CANDIDATES) {
    const htmlPath = join(appRoot, rel);
    if (!existsSync(htmlPath)) continue;
    const checksumKey = checksumKeyFor(htmlPath, appRoot);
    if (!checksumKey) continue;
    return {
      appRoot,
      htmlPath,
      productPath,
      checksumKey,
      backupHtmlPath: `${htmlPath}.we-orig`,
      backupProductPath: `${productPath}.we-orig`,
    };
  }
  return null;
}

export function status(appRoot: string): WorkbenchStatus {
  const targets = resolveTargets(appRoot);
  if (!targets) {
    return { supported: false, patched: false, reason: '找不到可打补丁的 workbench.html（appRoot=' + appRoot + '）' };
  }
  let patched = false;
  let checksumMismatch = false;
  try {
    const htmlBuf = readFileSync(targets.htmlPath);
    patched = isPatched(htmlBuf.toString('utf8'));
    const product = JSON.parse(readFileSync(targets.productPath, 'utf8')) as { checksums?: Record<string, string> };
    const stored = product.checksums?.[targets.checksumKey];
    checksumMismatch = Boolean(stored) && stored !== checksum(htmlBuf);
  } catch {
    checksumMismatch = true;
  }
  return { ...targets, supported: true, patched, checksumMismatch };
}

/** Targeted replacement so product.json keeps its original formatting. */
export function setChecksumValue(productText: string, key: string, value: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`("${escaped}"\\s*:\\s*")([^"]*)(")`);
  if (!re.test(productText)) throw new Error(`product.json 里找不到 checksums["${key}"]`);
  return productText.replace(re, `$1${value}$3`);
}

/** Read + parse a JSON file, or null when it is missing/unreadable. */
async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class WorkbenchInstaller {
  private readonly statePath: string;
  private readonly legacyStatePath: string;

  constructor(
    private readonly appRoot: string,
    private readonly log: { info(m: string, ...a: unknown[]): void; warn(m: string, ...a: unknown[]): void },
    options: { statePath?: string; legacyStatePath?: string } = {},
  ) {
    // Per-install state file; tests point these at temp files so they never touch
    // the real home dir.
    this.statePath = options.statePath ?? stateFilePath(appRoot);
    this.legacyStatePath = options.legacyStatePath ?? stateFilePath();
  }

  status(): WorkbenchStatus {
    return status(this.appRoot);
  }

  /** Write the patch (or refresh it). Returns the status after the write. */
  async enable(settings: WorkbenchPatchSettings): Promise<WorkbenchStatus> {
    const targets = resolveTargets(this.appRoot);
    if (!targets) throw new Error('这个 VS Code 安装不支持打补丁（找不到 workbench.html）');

    const current = await readFile(targets.htmlPath, 'utf8');
    if (!existsSync(targets.backupHtmlPath)) {
      await copyFile(targets.htmlPath, targets.backupHtmlPath);
      this.log.info(`已备份 ${targets.htmlPath} → ${targets.backupHtmlPath}`);
    }
    if (!existsSync(targets.backupProductPath)) {
      await copyFile(targets.productPath, targets.backupProductPath);
      this.log.info(`已备份 ${targets.productPath} → ${targets.backupProductPath}`);
    }

    // Only touch workbench.html when its bytes would actually change. It is a
    // checksummed file: while VS Code runs, the integrity service still compares
    // it against the checksum the main process read at startup, so every rewrite
    // is a chance to raise the "安装似乎已损坏。请重新安装。" toast until the next full
    // restart. The block is now version-free on purpose (see patch.ts): the
    // cache-busting version travels through we-workbench-assets.json instead, which
    // is not checksummed — so after the first patch this file never moves again,
    // update after update.
    const css = buildCss();
    const core = buildJs(settings.origin);
    const boot = buildBootJs();
    const assetVersion = assetVersionFor(settings.origin);
    // What a window that is already open has loaded: it resolved this version at
    // boot. If it changes, that window is stale until it reloads.
    const previousVersion = await this.readAssetVersion(targets);

    const patched = injectPatch(current);
    if (patched !== current) {
      await writeFile(targets.htmlPath, patched, 'utf8');
      this.log.info('已写入 workbench.html（注入块为静态块，此后不再改动）');
    } else {
      this.log.info('workbench.html 无需改动（补丁块已是最新）');
    }
    // Always recompute, never only when the html changed: this also repairs a
    // stale or wrongly-encoded entry left behind by an earlier version.
    await this.syncChecksum(targets, patched);
    const dir = dirname(targets.htmlPath);
    // Loader names from older versions are removed, not overwritten: the HTML no
    // longer references them, and a leftover copy is only confusing.
    for (const name of OBSOLETE_FILES) {
      await rm(join(dir, name), { force: true });
    }
    await writeFile(join(dir, CSS_FILE), css, 'utf8');
    await writeFile(join(dir, BOOT_FILE), boot, 'utf8');
    await writeFile(join(dir, CORE_FILE), core, 'utf8');
    // The Web-wallpaper stub the injected script frames (see buildWebStubHtml). New
    // files next to workbench.html, so they are not covered by the checksum table.
    await writeFile(join(dir, WEB_STUB_FILE), buildWebStubHtml(), 'utf8');
    await writeFile(join(dir, WEB_STUB_JS_FILE), buildWebStubJs(), 'utf8');
    await writeFile(join(dir, ASSETS_FILE), JSON.stringify({ version: assetVersion }), 'utf8');

    await this.writeState(targets, settings);
    const after = this.status();
    const assetsUpdated = patched !== current || previousVersion !== assetVersion;
    if (assetsUpdated) {
      this.log.info('壁纸资源已更新：已打开的窗口需要重载一次才会用上新版');
    }
    return { ...after, assetsUpdated };
  }

  /** Version the currently loaded assets describe, or null when there is none yet. */
  private async readAssetVersion(targets: WorkbenchTargets): Promise<string | null> {
    const parsed = (await readJson(join(dirname(targets.htmlPath), ASSETS_FILE))) as { version?: string } | null;
    return typeof parsed?.version === 'string' ? parsed.version : null;
  }

  /** Restore the installation to its vendor state. */
  async disable(): Promise<WorkbenchStatus> {
    const targets = resolveTargets(this.appRoot);
    if (!targets) throw new Error('这个 VS Code 安装不支持打补丁');

    const currentHtml = await readFile(targets.htmlPath, 'utf8');
    const state = await this.readState();
    const entryNow = this.readChecksumEntry(targets);

    // Three cases, and only the first may restore the backup. After a VS Code
    // update the backup belongs to the PREVIOUS version, and writing it back would
    // replace the new workbench.html with an old one — a good way to break an
    // installation that was otherwise fine.
    let restored: string | null = null;
    if (!isPatched(currentHtml)) {
      this.log.warn('workbench.html 已不含补丁（多半被 VS Code 更新覆盖）——只清理残留文件，不改动安装');
    } else if (state?.patchedChecksum && entryNow && entryNow !== state.patchedChecksum) {
      restored = stripPatch(currentHtml);
      this.log.warn('校验表已被替换（VS Code 更新过），改为就地剥离补丁，不还原旧版本备份');
    } else if (existsSync(targets.backupHtmlPath)) {
      const backup = await readFile(targets.backupHtmlPath, 'utf8');
      // The backup is authoritative *only* if it is itself unpatched — a backup
      // taken from an already-patched file would re-install the patch.
      restored = isPatched(backup) ? stripPatch(currentHtml) : backup;
      if (restored !== backup) this.log.warn('备份文件本身带着补丁，改为就地剥离');
    } else {
      restored = stripPatch(currentHtml);
      this.log.warn('没有找到备份，已就地剥离补丁');
    }

    if (restored !== null && restored !== currentHtml) {
      await writeFile(targets.htmlPath, restored, 'utf8');
      await this.syncChecksum(targets, restored);
    }
    // Every file the patch dropped, including the ones older versions used.
    for (const name of [...PATCH_FILES, ...OBSOLETE_FILES]) {
      await rm(join(dirname(targets.htmlPath), name), { force: true });
    }

    // Remove backups only once the restore is on disk and the checksum is synced.
    await rm(targets.backupHtmlPath, { force: true });
    await rm(targets.backupProductPath, { force: true });
    await rm(this.statePath, { force: true });
    // Drop a legacy shared state file that belongs to this installation too.
    if (this.legacyStatePath !== this.statePath) {
      const legacy = (await readJson(this.legacyStatePath)) as { appRoot?: string } | null;
      if (
        legacy?.appRoot &&
        legacy.appRoot.replace(/\\/g, '/').toLowerCase() === this.appRoot.replace(/\\/g, '/').toLowerCase()
      ) {
        await rm(this.legacyStatePath, { force: true });
      }
    }

    this.log.info('工作台壁纸补丁已移除，安装已还原');
    return this.status();
  }

  private readChecksumEntry(targets: WorkbenchTargets): string | null {
    try {
      const product = JSON.parse(readFileSync(targets.productPath, 'utf8')) as { checksums?: Record<string, string> };
      return product.checksums?.[targets.checksumKey] ?? null;
    } catch {
      return null;
    }
  }

  /** Read our state, adopting the legacy shared file when it belongs to this install. */
  private async readState(): Promise<{ patchedChecksum?: string; appRoot?: string } | null> {
    const own = await readJson(this.statePath);
    if (own) return own as { patchedChecksum?: string; appRoot?: string };
    if (this.legacyStatePath === this.statePath) return null;
    const legacy = (await readJson(this.legacyStatePath)) as { appRoot?: string } | null;
    if (!legacy?.appRoot) return null;
    // Only adopt it when it describes THIS installation, or we would act on another
    // install's backup.
    const same = legacy.appRoot.replace(/\\/g, '/').toLowerCase() === this.appRoot.replace(/\\/g, '/').toLowerCase();
    return same ? legacy : null;
  }

  private async syncChecksum(targets: WorkbenchTargets, html: string): Promise<void> {
    const product = await readFile(targets.productPath, 'utf8');
    const next = setChecksumValue(product, targets.checksumKey, checksum(html));
    if (next !== product) await writeFile(targets.productPath, next, 'utf8');
  }

  private async writeState(targets: WorkbenchTargets, settings: WorkbenchPatchSettings): Promise<void> {
    const payload = JSON.stringify(
      {
        appRoot: targets.appRoot,
        htmlPath: targets.htmlPath,
        productPath: targets.productPath,
        checksumKey: targets.checksumKey,
        files: [...PATCH_FILES],
        origin: settings.origin,
        // Recorded so a later disable() can tell "our patch is still in place" from
        // "VS Code updated underneath us" — in the latter case the pristine backup
        // belongs to the old version and must never be written back.
        patchedChecksum: checksum(await readFile(targets.htmlPath)),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    );
    const p = this.statePath;
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, payload, 'utf8');
  }
}
