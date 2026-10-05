/**
 * Wallpaper inventory service: locate → enumerate → mint media URLs.
 *
 * The DSH original rebuilt the inventory on every `/inventory` request. Here the
 * scan is cached and only redone on demand (command / first panel open), because
 * an extension host should not stat a workshop library on a UI event.
 */

import { dirname, relative, sep } from 'node:path';

import { MediaServer } from './media/server';
import { extOf, enumerateWallpapers, WallpaperProject } from './we/inventory';
import { locateWallpaperEngine, owningLibraries, resetProbeCache } from './we/locate';

/**
 * Minimal logging surface. Declared structurally (not as the VS Code `Logger`
 * class) so this whole module — and everything it imports — stays free of the
 * `vscode` module and can therefore be exercised end-to-end by `node --test`
 * against the real Wallpaper Engine library.
 */
export interface LogSink {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** What the webview can actually do with an entry in this PoC step. */
export type RenderMode = 'video' | 'scene' | 'web' | 'poster' | 'none';

export interface WallpaperItem {
  id: string;
  title: string;
  type: string;
  contentrating: string | null;
  /** Loopback URL of the main media file, or null when unavailable. */
  media: string | null;
  /**
   * Scene payload base: a path-addressable URL for the project directory, so the
   * renderer can resolve `scene.pkg`'s sibling textures/materials. Null for videos.
   */
  sceneBase: string | null;
  /** Loopback URL of a still image to show (preview), or null. */
  preview: string | null;
  schemeColor: string | null;
  source: string;
  mediaExt: string;
  renderMode: RenderMode;
  /** Human-readable reason when renderMode is not `video` (surfaced in the UI). */
  note: string;
}

export interface InventorySnapshot {
  installDir: string | null;
  libraryDirs: string[];
  items: WallpaperItem[];
  counts: Record<string, number>;
  /** Wallpapers the PoC can actually play. */
  playableCount: number;
}

function renderModeFor(p: WallpaperProject): { mode: RenderMode; note: string } {
  switch (p.type) {
    case 'video':
      return { mode: 'video', note: '' };
    case 'scene': {
      // Engine ≥2.1.0 mounts BOTH scene forms:
      //   pkg form — the container is a packed `.pkg`. The engine fetches the
      //     project-declared pkg path first, then the fixed scene.pkg names (the
      //     media server aliases a directory's single *.pkg onto the fixed names);
      //   loose source-form — the container is the entry `.json` (scene.json and
      //     friends). The engine fetches scene.json / materials/ / models/ /
      //     shaders/ BY NAME from the directory token, so nothing has to be packed.
      // Anything else (a declared main that is neither) has nothing the engine can
      // load — stay poster instead of failing after a string of 404s.
      const main = p.fileAbs.toLowerCase();
      if (main.endsWith('.pkg') || main.endsWith('.json')) {
        return { mode: 'scene', note: '' };
      }
      return {
        mode: 'poster',
        note: '这个 Scene 的主文件既不是打包的 scene.pkg 也不是源码工程 json，实时渲染不支持，显示预览图',
      };
    }
    case 'web':
      if (!/\.html?$/i.test(p.fileAbs)) {
        return { mode: 'poster', note: 'Web 壁纸的入口不是 HTML（有些项目声明 .js），显示预览图' };
      }
      return { mode: 'web', note: '' };
    default:
      // Application wallpapers are .exe payloads — upstream lists but never runs them.
      return { mode: 'none', note: 'Application 类型永不渲染（上游 ADR-0001 D4）' };
  }
}

export class WallpaperService {
  private snapshot: InventorySnapshot | null = null;

  constructor(
    private readonly log: LogSink,
    private readonly media: MediaServer,
    private readonly steamRoots: () => string[],
  ) {}

  get current(): InventorySnapshot | null {
    return this.snapshot;
  }

  /** Rescan the local library. `force` also drops the 60s Steam probe cache. */
  async scan(force = false): Promise<InventorySnapshot> {
    if (force) resetProbeCache();
    const extra = this.steamRoots();
    const installDir = await locateWallpaperEngine(extra);
    const libraryDirs = await owningLibraries(extra);
    this.log.info(`Wallpaper Engine 安装目录：${installDir ?? '<未找到>'}`);
    this.log.info(`Steam 库（含 431960）：${libraryDirs.join(' | ') || '<无>'}`);

    // Allow-list first: register() refuses anything outside these roots.
    if (installDir) this.media.allowRoot(installDir);
    for (const lib of libraryDirs) this.media.allowRoot(lib);

    const projects = await enumerateWallpapers(installDir, libraryDirs);
    const items: WallpaperItem[] = projects.map((p) => {
      const { mode, note } = renderModeFor(p);
      // Scene: register the whole PROJECT directory, not the pkg alone. Not because
      // the renderer fetches sibling files by path (it does not — it parses the pkg
      // in memory), but because it appends the FIXED name `scene.pkg` to the base it
      // is given, so the directory has to be addressable as a directory.
      let sceneBase: string | null = null;
      let media: string | null = null;
      if (mode === 'video') {
        media = this.media.register(p.fileAbs);
      } else if (mode === 'scene') {
        sceneBase = this.media.registerDir(dirname(p.fileAbs));
        // The canonical payload URL for the state machine and diagnostics. Engine
        // ≥2.1.0 fetches the project-declared pkg path FIRST (falling back to the
        // fixed scene.pkg names, which the media server aliases onto a directory's
        // single *.pkg), so the actual main file is the accurate URL — and for the
        // loose source-form it is the entry json the engine reads first.
        const rel = relative(dirname(p.fileAbs), p.fileAbs).split(sep).map(encodeURIComponent).join('/');
        media = sceneBase ? `${sceneBase}/${rel}` : null;
      } else if (mode === 'web') {
        // The whole PROJECT directory, not the entry's folder: author HTML loads its
        // css/js/audio through relative paths, and the entry may live in a subfolder.
        // The engine reads `project.json` from this base to see type:"web", then
        // loads `{base}/{project.file}` — no per-entry URL minting needed, and no
        // shim injection here either (the engine carries its own).
        sceneBase = this.media.registerDir(p.dirAbs);
        const rel = relative(p.dirAbs, p.fileAbs).split(sep).map(encodeURIComponent).join('/');
        media = sceneBase ? `${sceneBase}/${rel}` : null;
      }
      return {
        id: p.id,
        title: p.title,
        type: p.type,
        contentrating: p.contentrating,
        media,
        sceneBase,
        preview: p.previewAbs ? this.media.register(p.previewAbs) : null,
        schemeColor: p.schemeColor,
        source: p.source,
        mediaExt: extOf(p.fileAbs),
        renderMode: mode,
        note,
      };
    });

    const counts: Record<string, number> = {};
    for (const it of items) counts[it.type] = (counts[it.type] ?? 0) + 1;

    this.snapshot = {
      installDir,
      libraryDirs,
      items,
      counts,
      playableCount: items.filter((i) => i.renderMode !== 'poster' && i.renderMode !== 'none').length,
    };
    this.log.info(
      `扫描完成：${items.length} 张（${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')}），可播放 ${this.snapshot.playableCount}`,
    );
    return this.snapshot;
  }

  /** Items the panel can render live, in inventory (title) order. */
  playableItems(): WallpaperItem[] {
    return (this.snapshot?.items ?? []).filter(
      (i) => i.renderMode === 'video' || i.renderMode === 'scene' || i.renderMode === 'web',
    );
  }

  find(id: string | undefined): WallpaperItem | undefined {
    if (!id) return undefined;
    return (this.snapshot?.items ?? []).find((i) => i.id === id);
  }

  /** Next playable item after `id`, wrapping — used by the rotation timer. */
  nextAfter(id: string | undefined): WallpaperItem | undefined {
    const playable = this.playableItems();
    if (!playable.length) return undefined;
    const idx = playable.findIndex((i) => i.id === id);
    return playable[(idx + 1 + playable.length) % playable.length];
  }

  /**
   * What the **workbench background** layer can use for this item.
   *
   * The layer is one element behind the whole UI: `video` plays the media file,
   * `image` shows a still (Scene previews, poster-only items), and the two live kinds
   * hand the work to the vendored engine. A Scene's `scene.pkg` renders nothing in a
   * `<video>`, and a JPEG preview renders nothing either, which is why the layer is
   * told WHAT it is getting: selecting a Scene wallpaper used to turn the workbench
   * background black — the bug behind "scene 壁纸不正常显示".
   *
   * `scene` and `web` are the opt-in live kinds (weWallpaper.workbenchLiveScene):
   * both mount the engine, and both fall back to `still` when the engine cannot come
   * up. They differ in where the engine runs — a Scene is imported into the workbench
   * document from a blob URL, while a Web wallpaper's author app may only be framed by
   * the stub page dropped next to workbench.html (see patch.ts buildWebStubHtml), so
   * `url` carries the project-directory base either way.
   *
   * `surface` is the user's live-surface preference (weWallpaper.liveSurface): with
   * `'panel'` this layer degrades to the still, because rendering the same wallpaper
   * twice costs a second engine instance with nothing to show for it. `'workbench'`
   * and `'both'` behave identically here — the difference is on the panel's side.
   */
  workbenchTargetFor(
    item: WallpaperItem | undefined,
    liveScene = false,
    surface: 'both' | 'workbench' | 'panel' = 'both',
  ): { url: string; kind: 'video' | 'image' | 'scene' | 'web'; still?: string | null } | null {
    if (!item) return null;
    if (item.renderMode === 'video' && item.media) return { url: item.media, kind: 'video' };
    // Opt-in: a live wallpaper in the whole-window layer. A Scene needs no
    // workbench.html rewrite (its CSP allows blob: scripts, and the engine is imported
    // from one), and a Web wallpaper needs none either (the author app is framed by
    // the stub page, which is same-origin). Both put a full-screen animated surface
    // behind the entire UI — the arrangement that produced the stale-layer artifacts
    // in the first place — hence default off, still as fallback.
    if (liveScene && surface !== 'panel' && item.renderMode === 'scene' && item.sceneBase) {
      return { url: item.sceneBase, kind: 'scene', still: item.preview };
    }
    if (liveScene && surface !== 'panel' && item.renderMode === 'web' && item.sceneBase) {
      return { url: item.sceneBase, kind: 'web', still: item.preview };
    }
    if (item.preview) return { url: item.preview, kind: 'image' };
    return null;
  }
}
