/**
 * Wallpaper Engine project enumeration — ported from `dsh-wallpaper-engine`
 * (MIT, elysia395) `lib/index.js`.
 *
 * Kept from upstream: the `project.json` shape, the `KINDS` whitelist with its
 * `scene` fallback, extension-based type inference, the scene main-file
 * resolution order (declared → scene.pkg → scene.json → single *.pkg), the
 * `schemecolor` → CSS conversion and the 24-project scan chunking that bounds
 * in-flight I/O.
 *
 * Not ported in this PoC step: playlist import from WE `config.json`, preview
 * thumbnails for uploads, ffmpeg transcoding. Those are step 3.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { WE_APPID, isDirectory, pathExists } from './locate';

export const KINDS = ['scene', 'video', 'web', 'application'] as const;
export type WallpaperKind = (typeof KINDS)[number];

export interface WallpaperProject {
  /** Workshop id or project folder name. */
  id: string;
  title: string;
  type: WallpaperKind;
  /** `file` as declared in project.json (relative to the project dir). */
  file: string;
  /** Resolved absolute main file (scene: real container). */
  fileAbs: string;
  /**
   * The project directory itself (the one holding project.json).
   *
   * Needed because a Web wallpaper's entry HTML loads its own css/js/audio through
   * RELATIVE paths, so the whole directory has to be addressable — not just the
   * entry's own folder (an entry declared as `sub/index.html` would otherwise lose
   * every sibling above it).
   */
  dirAbs: string;
  preview: string | null;
  previewAbs: string | null;
  /** WE content rating verbatim: "Everyone" | "PG13" | "Mature" | null. */
  contentrating: string | null;
  /**
   * WE `tags` verbatim (e.g. Anime / Girls / Landscape / Music).
   *
   * This is what the picker's 分类 chips are built from. WE also stores internal
   * pseudo-tags prefixed with `_` (`_approved`, `_contentrating`…) which are not
   * categories and are dropped by readProject.
   */
  tags: string[];
  /** WE `schemecolor` as `rgb(r, g, b)`, for load-time placeholder colour. */
  schemeColor: string | null;
  /** Root this project came from: workshop | defaultprojects | myprojects. */
  source: string;
}

/** Container suffix, lower-case, no dot; empty when there is none. */
export function extOf(p: string | null | undefined): string {
  const s = String(p || '');
  const dot = s.lastIndexOf('.');
  const sepAt = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return dot > sepAt + 1 ? s.slice(dot + 1).toLowerCase() : '';
}

export function inferType(file: string): WallpaperKind {
  if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file)) return 'video';
  if (/\.(html?|js)$/i.test(file)) return 'web';
  return 'scene';
}

/** WE stores schemecolor as three space-separated 0–1 floats. */
export function schemeToCss(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((x) => !Number.isFinite(x))) return null;
  const c = parts.slice(0, 3).map((x) => Math.max(0, Math.min(255, Math.round(x * 255))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/**
 * Read one project directory. Returns null when project.json is missing,
 * unparseable, or has no `file` — upstream behaves the same, which is why
 * `audiophile`-style projects with a custom json are skipped.
 */
export async function readProject(dir: string): Promise<Omit<WallpaperProject, 'fileAbs' | 'dirAbs' | 'previewAbs' | 'source'> | null> {
  const pj = join(dir, 'project.json');
  if (!(await pathExists(pj))) return null;
  try {
    const o = JSON.parse(await readFile(pj, 'utf8')) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || !o.file) return null;
    const declaredFile = String(o.file);
    let type: WallpaperKind = typeof o.type === 'string' ? (o.type.toLowerCase() as WallpaperKind) : inferType(declaredFile);
    if (!KINDS.includes(type)) type = 'scene';
    const general = (o.general ?? null) as { properties?: { schemecolor?: { value?: unknown } } } | null;
    return {
      id: basename(dir),
      title: typeof o.title === 'string' ? o.title : basename(dir),
      type,
      file: declaredFile,
      preview: typeof o.preview === 'string' ? o.preview : null,
      contentrating: typeof o.contentrating === 'string' ? o.contentrating : null,
      // `tags` is a plain string array in WE's project.json; the `_`-prefixed entries are
      // WE internals and never a category a user would filter by.
      tags: Array.isArray(o.tags)
        ? [...new Set(o.tags.filter((t): t is string => typeof t === 'string' && t.length > 0 && !t.startsWith('_')))]
        : [],
      schemeColor: schemeToCss(general?.properties?.schemecolor?.value),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a scene project's real main container. Workshop items frequently
 * declare `scene.json` while shipping only the packed `scene.pkg`, and loose
 * projects ship the reverse — probe the declared file, then scene.pkg, then
 * scene.json, then a single *.pkg in the directory.
 */
export async function resolveSceneMainFile(dir: string, declared: string | null): Promise<string | null> {
  for (const candidate of [declared, 'scene.pkg', 'scene.json']) {
    if (!candidate) continue;
    const abs = resolve(dir, candidate);
    try {
      if ((await stat(abs)).isFile()) return candidate;
    } catch {
      /* keep probing */
    }
  }
  let pkgs: string[] = [];
  try {
    pkgs = (await readdir(dir)).filter((name) => name.toLowerCase().endsWith('.pkg'));
  } catch {
    return null;
  }
  return pkgs.length === 1 ? pkgs[0] : null;
}

/** Project-directory batch size for the async scan (bounds in-flight I/O). */
const SCAN_CHUNK = 24;

/**
 * Enumerate every project under `<install>/projects/{defaultprojects,myprojects}`
 * and `<library>/steamapps/workshop/content/431960`. Application wallpapers are
 * listed but never rendered (upstream ADR-0001 D4 — they are .exe payloads).
 */
export async function enumerateWallpapers(installDir: string | null, libraryDirs: readonly string[]): Promise<WallpaperProject[]> {
  const roots: Array<{ dir: string; source: string }> = [];
  if (installDir) {
    for (const sub of ['defaultprojects', 'myprojects']) {
      const p = join(installDir, 'projects', sub);
      if (await pathExists(p)) roots.push({ dir: p, source: sub });
    }
  }
  for (const lib of libraryDirs) {
    const ws = join(lib, 'steamapps', 'workshop', 'content', WE_APPID);
    if (await pathExists(ws)) roots.push({ dir: ws, source: 'workshop' });
  }

  const candidates: Array<{ dir: string; source: string }> = [];
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root.dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = join(root.dir, entry);
      if (await isDirectory(dir)) candidates.push({ dir, source: root.source });
    }
  }

  const found = new Map<string, WallpaperProject>();
  for (let i = 0; i < candidates.length; i += SCAN_CHUNK) {
    const chunk = candidates.slice(i, i + SCAN_CHUNK);
    const results = await Promise.all(
      chunk.map(async ({ dir, source }) => {
        const p = await readProject(dir);
        return p ? { dir, source, p } : null;
      }),
    );
    for (const hit of results) {
      if (!hit || found.has(hit.p.id)) continue;
      const { dir, source, p } = hit;
      const mainFile = p.type === 'scene' ? (await resolveSceneMainFile(dir, p.file)) || p.file : p.file;
      found.set(p.id, {
        ...p,
        fileAbs: resolve(dir, mainFile),
        dirAbs: resolve(dir),
        previewAbs: p.preview ? resolve(dir, p.preview) : null,
        source,
      });
    }
  }
  return [...found.values()].sort((a, b) => (a.title || '').localeCompare(b.title || ''));
}

export interface WeLibrary {
  installDir: string | null;
  libraryDirs: string[];
  wallpapers: WallpaperProject[];
}

export { WE_APPID };
