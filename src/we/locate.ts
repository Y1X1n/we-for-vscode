/**
 * Wallpaper Engine / Steam discovery.
 *
 * Ported from `dsh-wallpaper-engine` (MIT, elysia395) `lib/index.js` — the probe
 * chain (registry → env/config → known dirs → WSL mounts), the Valve KeyValues
 * line-scan for `libraryfolders.vdf`, the `wallpaper32.exe` install check and
 * the WSL path translation are kept behaviour-identical on purpose: they are
 * proven against real Steam installs, quirks included.
 *
 * The only adaptation: the DSH plugin read `DSH_WE_STEAM_ROOT` from the
 * environment; here the equivalent comes from the `weWallpaper.steamRoot`
 * setting (passed in by the caller) and an optional `WE_STEAM_ROOT` env var,
 * so tests can drive it.
 */

import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join, normalize } from 'node:path';

/** Steam appid for Wallpaper Engine. */
export const WE_APPID = '431960';

/** Common Steam install locations probed when libraryfolders.vdf is missing. */
const STEAM_PROBE_DIRS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\SteamLibrary',
];

const STEAM_PROBE_TTL_MS = 60 * 1000;

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * On WSL, translate a Windows path (`D:\SteamLibrary`) to its DrvFS mount form
 * (`/mnt/d/SteamLibrary`). `libraryfolders.vdf` entries are always Windows-style
 * even when read from inside WSL — without this the workshop library would
 * silently resolve to nothing. No-op on every other platform.
 */
export function wslPath(p: string): string {
  if (process.platform !== 'linux' || typeof p !== 'string') return p;
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (!m) return p;
  return join('/mnt', m[1].toLowerCase(), m[2].replace(/\\/g, '/'));
}

/** reg.exe: SystemRoot on Windows, /mnt/<letter>/Windows/System32 on WSL; null elsewhere. */
async function resolveRegExe(): Promise<string | null> {
  if (process.platform === 'win32') {
    return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  }
  if (process.platform !== 'linux') return null;
  let letters: string[] = [];
  try {
    letters = (await readdir('/mnt')).filter((n) => /^[a-zA-Z]$/.test(n));
  } catch {
    return null;
  }
  for (const letter of letters) {
    const p = join('/mnt', letter, 'Windows', 'System32', 'reg.exe');
    if (await pathExists(p)) return p;
  }
  return null;
}

/** Steam root from HKCU\Software\Valve\Steam on Windows and WSL; null elsewhere. */
export async function steamPathFromRegistry(): Promise<string | null> {
  const reg = await resolveRegExe();
  if (!reg) return null;
  return new Promise<string | null>((resolvePromise) => {
    try {
      // Async execFile (5s timeout): execFileSync would block the extension host.
      execFile(
        reg,
        ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000 },
        (err, stdout) => {
          if (err) {
            resolvePromise(null);
            return;
          }
          const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || '');
          const p = m ? normalize(m[1].trim()) : null;
          resolvePromise(p ? wslPath(p) : null);
        },
      );
    } catch {
      resolvePromise(null);
    }
  });
}

/** Windows Steam drives appear under /mnt/<letter> when running inside WSL. */
async function wslSteamRoots(): Promise<string[]> {
  if (process.platform !== 'linux') return [];
  let letters: string[] = [];
  try {
    letters = (await readdir('/mnt')).filter((n) => /^[a-zA-Z]$/.test(n));
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const letter of letters) {
    const base = join('/mnt', letter);
    for (const c of [
      join(base, 'Program Files (x86)', 'Steam'),
      join(base, 'Program Files', 'Steam'),
      join(base, 'Steam'),
      join(base, 'SteamLibrary'),
    ]) {
      if (await pathExists(join(c, 'steamapps', 'libraryfolders.vdf'))) roots.push(c);
    }
  }
  return roots;
}

let steamProbeCache: { t: number; dirs: string[] } | null = null;
let steamProbeInflight: Promise<string[]> | null = null;

/** Root directories configured by the user (setting) or by env (tests). */
function configuredRoots(extraRoots: readonly string[]): string[] {
  const raw = [process.env.WE_STEAM_ROOT || '', ...extraRoots].join(';');
  if (!raw.trim()) return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(wslPath);
}

/**
 * Probe list: registry root + configured roots, then known dirs, then WSL /mnt
 * mounts. Cached for 60s including failures — probing costs seconds when Steam
 * is absent, and every rescan would otherwise pay it again. Concurrent callers
 * share the same in-flight promise.
 */
export async function steamProbeDirs(extraRoots: readonly string[] = []): Promise<string[]> {
  const extra = configuredRoots(extraRoots);
  if (steamProbeCache && Date.now() - steamProbeCache.t < STEAM_PROBE_TTL_MS) {
    return [...new Set([...extra, ...steamProbeCache.dirs])];
  }
  if (steamProbeInflight) return [...new Set([...extra, ...(await steamProbeInflight)])];
  steamProbeInflight = (async () => {
    const reg = await steamPathFromRegistry();
    const wsl = await wslSteamRoots();
    return [...(reg ? [reg] : []), ...STEAM_PROBE_DIRS, ...wsl];
  })();
  try {
    const dirs = await steamProbeInflight;
    steamProbeCache = { t: Date.now(), dirs };
    return [...new Set([...extra, ...dirs])];
  } finally {
    steamProbeInflight = null;
  }
}

/** Test hook: drop the 60s probe cache. */
export function resetProbeCache(): void {
  steamProbeCache = null;
  steamProbeInflight = null;
}

/**
 * Valve KeyValues parser for libraryfolders.vdf: the libraries owning WE.
 *
 * Deliberately the same line scan as upstream rather than a full KeyValues
 * parser: a `"path"` line opens a block, and any following line that mentions
 * appid 431960 attributes that path to this library.
 */
export async function librariesFromVdf(vdfPath: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(vdfPath, 'utf8');
  } catch {
    return [];
  }
  const libs: string[] = [];
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*"path"\s+"([^"]+)"\s*$/.exec(line);
    if (m) {
      current = m[1].replace(/\\\\/g, '\\');
      continue;
    }
    if (current && line.includes(WE_APPID)) {
      const t = wslPath(current);
      if (t && !libs.includes(t)) libs.push(t);
    }
  }
  return libs;
}

/** Locate the install directory (the one holding wallpaper32.exe). */
export async function locateWallpaperEngine(extraRoots: readonly string[] = []): Promise<string | null> {
  const candidates: string[] = [];
  const libraries: string[] = [];
  const probes = await steamProbeDirs(extraRoots);
  for (const probe of probes) {
    const vdf = join(probe, 'steamapps', 'libraryfolders.vdf');
    if (await pathExists(vdf)) {
      try {
        libraries.push(...(await librariesFromVdf(vdf)));
      } catch {
        /* skip unreadable vdf */
      }
    }
  }
  const roots = [...probes, ...libraries];
  for (const root of roots) candidates.push(join(root, 'steamapps', 'common', 'wallpaper_engine'));
  candidates.push(wslPath('C:\\Program Files (x86)\\Wallpaper Engine'));

  const seen = new Set<string>();
  for (const raw of candidates) {
    const dir = normalize(raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (await pathExists(join(dir, 'wallpaper32.exe'))) return dir;
  }
  return null;
}

/** Libraries that own Wallpaper Engine (for the workshop content root). */
export async function owningLibraries(extraRoots: readonly string[] = []): Promise<string[]> {
  const libs: string[] = [];
  for (const probe of await steamProbeDirs(extraRoots)) {
    const vdf = join(probe, 'steamapps', 'libraryfolders.vdf');
    if (await pathExists(vdf)) {
      try {
        libs.push(...(await librariesFromVdf(vdf)));
      } catch {
        /* skip */
      }
    }
    // The Steam root a libraryfolders.vdf lives in is itself a library but is
    // never listed as a "path" entry. If Wallpaper Engine sits in the DEFAULT
    // library, its workshop content lives under that same root — omit it and
    // every workshop wallpaper silently disappears.
    if (await pathExists(join(probe, 'steamapps', 'common', 'wallpaper_engine'))) libs.push(probe);
  }
  return [...new Set(libs)];
}

export { isDirectory, pathExists };
