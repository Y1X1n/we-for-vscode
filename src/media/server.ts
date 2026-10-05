/**
 * Token-gated loopback media server.
 *
 * Why this exists instead of `webview.asWebviewUri()`: 4K wallpaper videos are
 * 500 MB+ files and need HTTP Range so the `<video>` element can seek and start
 * without buffering the whole file. `asWebviewUri` is the remote-friendly path
 * (see README "下一步"), but it does not give us Range control.
 *
 * Security model (same idea as upstream's `mediaMap` + directory fence):
 *  - binds 127.0.0.1 only, on an OS-assigned random port;
 *  - every file is addressed by an unguessable token, never by path — there is
 *    no traversal surface because the request cannot express a path;
 *  - a file is only registered when it lives under an explicitly allowed root.
 *
 * Note for reviewers: `http://127.0.0.1` is a "potentially trustworthy" origin,
 * so a webview (vscode-webview://, a secure context) is not blocked by mixed
 * content rules. CSP still has to allow the origin — see panel.ts.
 */

import { createHash, randomBytes } from 'node:crypto';

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path';

export type RangeSpec = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Parse a single-range `Range` header (RFC 7233). Returns null when the header
 * should be ignored (absent, multi-range, malformed unit) — the caller then
 * answers 200 with the whole entity, which is what browsers expect.
 */
export function parseRange(header: string | undefined, size: number): RangeSpec {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (size === 0) return 'unsatisfiable';
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(end, size - 1) };
}

/** MIME table ported from upstream: web-wallpaper subresources must map too,
 *  because a stylesheet served as octet-stream is rejected by strict MIME checks. */
export function mimeFor(absPath: string): string {
  const ext = absPath.slice(absPath.lastIndexOf('.') + 1).toLowerCase();
  return (
    {
      mp4: 'video/mp4',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      avi: 'video/x-msvideo',
      mov: 'video/quicktime',
      html: 'text/html',
      htm: 'text/html',
      js: 'text/javascript',
      mjs: 'text/javascript',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      png: 'image/png',
      webp: 'image/webp',
      apng: 'image/apng',
      bmp: 'image/bmp',
      css: 'text/css',
      json: 'application/json',
      svg: 'image/svg+xml',
      txt: 'text/plain',
      xml: 'application/xml',
      wasm: 'application/wasm',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      oga: 'audio/ogg',
      wav: 'audio/wav',
      m4a: 'audio/mp4',
      flac: 'audio/flac',
      aac: 'audio/aac',
    }[ext] || 'application/octet-stream'
  );
}

function normalizeKey(p: string): string {
  const n = normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** True when `child` is inside `root` (boundary-aware: C:\foo does not contain C:\foobar). */
export function isInside(root: string, child: string): boolean {
  const r = normalizeKey(root).replace(/[\\/]+$/, '');
  const c = normalizeKey(child);
  return c === r || c.startsWith(r + sep) || c.startsWith(r + '/');
}

export type LogFn = (level: 'info' | 'warn' | 'error', message: string) => void;

/** What the workbench background layer has to create for the current wallpaper. */
export type WorkbenchKind = 'video' | 'image' | 'scene' | 'web';

export interface MediaServerOptions {
  /**
   * Token secret. Pass a persisted value to make tokens stable across sessions:
   * the workbench patch bakes the media URL into `workbench.html`, which is read
   * before the extension activates, so a per-session secret would 404 on every
   * start until the user reloaded the window.
   */
  secret?: string;
  /**
   * Preferred TCP port. Also baked into the patched HTML, so a random port would
   * invalidate the patch every session. Falls back to an OS-assigned port when
   * the preferred one is taken.
   */
  preferredPort?: number;
}

export class MediaServer {
  private server: http.Server | null = null;
  private boundPort = 0;
  private readonly secret: string;
  private readonly preferredPort: number;
  private readonly tokens = new Map<string, string>();
  private readonly byToken = new Map<string, string>();
  private readonly roots: string[] = [];
  /** Media requests currently streaming (one per playing renderer). */
  private active = 0;
  /**
   * Documents that loaded the workbench patch, keyed by the id the injected
   * script reports to `/beacon`. This is how "did this window pick the patch up?"
   * gets answered without asking the user to eyeball every window.
   */
  private readonly seenDocs = new Map<string, number>();
  /**
   * URL of the wallpaper the patched workbench should play.
   *
   * The patched HTML is deliberately static: it asks `/current` for the URL at
   * runtime instead of having one baked in. Rewriting workbench.html on every
   * wallpaper switch would change its hash, and VS Code's integrity service
   * compares against the checksum table its main process cached at startup — so a
   * rewritten file means the "installation appears to be corrupt" toast returns
   * after every reload until the next full restart.
   */
  private currentUrl: string | null = null;
  /** Poster shown until a live scene produces its first frame (kind === 'scene'). */
  private currentStill: string | null = null;
  /** What kind of element that URL needs: a video file, a still image, or a live scene. */
  private currentKind: WorkbenchKind = 'video';
  /**
   * Last style report from a patched window (see the injected probe). This exists
   * because "which chrome band is still opaque?" cannot be answered from outside
   * the renderer: the answer is a computed style, so the page reports it.
   */
  private lastProbe: unknown = null;
  /**
   * Last live-scene lifecycle report from a patched window (mount stages, canvas
   * geometry, a captured frame). Kept in its OWN slot: the style probe fires on a
   * timer and would otherwise overwrite the scene report before anyone reads it.
   */
  private lastScene: unknown = null;
  /**
   * Last readability measurement from a patched window (wallpaper luminance stats,
   * the dimming it forced, and the resulting code-text contrast). Own slot for the
   * same reason as the scene report: it is the only answer to "is the code readable
   * right now?" that does not need a screenshot.
   */
  private lastContrast: unknown = null;
  private viewOpacity = 1;
  private viewScrim = 0.35;
  /** Readability policy: the page measures its own pixels, this is the user's mode. */
  private viewContrast: 'off' | 'balanced' | 'strong' = 'balanced';
  /** Frosted chrome / editor surface: shared blur radius and the two alphas. */
  private viewBlur = 16;
  private viewChromeAlpha = 0;
  private viewEditorAlpha = 0;
  /**
   * Windows listening on `/events` (server-sent events).
   *
   * The 15 s poll stays as the fallback, but it is not enough on its own: Chromium
   * throttles timers to roughly once a minute while the window is occluded, so a
   * slider moved in the panel could take a minute to appear — which reads as "the
   * setting does nothing". A push is immune to that.
   */
  private readonly viewClients = new Set<http.ServerResponse>();

  /**
   * The payload `/current` returns and `/events` pushes — one builder, so the poll and
   * the push can never disagree about what the view is.
   */
  private currentPayload(): Record<string, unknown> {
    return {
      url: this.currentUrl,
      kind: this.currentKind,
      still: this.currentStill,
      engine: this.currentKind === 'scene' || this.currentKind === 'web' ? this.engineUrl : null,
      port: this.boundPort,
      opacity: this.viewOpacity,
      scrim: this.viewScrim,
      contrast: this.viewContrast,
      blur: this.viewBlur,
      chromeGlassAlpha: this.viewChromeAlpha,
      editorGlassAlpha: this.viewEditorAlpha,
    };
  }

  /**
   * Push the current payload to every window listening on `/events`.
   *
   * Why a stream and not just the 15 s poll: Chromium throttles timers to roughly once
   * a minute while the window is occluded, so a slider moved in the panel could take a
   * minute to show up in the window — which reads as "the setting does nothing". A push
   * is immune to that, and it is what makes the panel's 「立即生效」 button instant.
   */
  private broadcastView(): void {
    if (!this.viewClients.size) return;
    const frame = `event: view\ndata: ${JSON.stringify(this.currentPayload())}\n\n`;
    for (const client of this.viewClients) {
      try {
        client.write(frame);
      } catch {
        this.viewClients.delete(client);
      }
    }
  }
  /** Directory tokens for scene payloads (see registerDir). */
  private readonly dirTokens = new Map<string, string>();
  private readonly dirByToken = new Map<string, string>();
  /** Engine file served to the patched workbench for blob-import (see setEngineFile). */
  private engineFile: string | null = null;
  /** Set by the host so diagnostics land in the extension's own output channel. */
  private readonly log: LogFn;

  constructor(log: LogFn, options: MediaServerOptions = {}) {
    this.log = log;
    this.secret = options.secret ?? randomBytes(16).toString('hex');
    this.preferredPort = options.preferredPort ?? 0;
  }

  /** Allow every file under `dir` to be registered. */
  allowRoot(dir: string): void {
    if (!dir) return;
    this.roots.push(normalize(dir));
  }

  /**
   * Register a **directory** and return the base URL the scene renderer can walk.
   *
   * Scene wallpapers are not one file: the packed `scene.pkg` sits next to loose
   * textures/materials, and the renderer resolves those as *relative paths*. The
   * opaque per-file token scheme (`/m/<token>`) cannot express that — a sibling of
   * the pkg would have a different, unrelated token. So a directory gets its own
   * token and a path-addressable route:
   *
   *     <origin>/wallpaper-engine/scene-files/<token>/<relative path>
   *
   * The fence is the same as for files: the directory must live under an allowed
   * root, and every request is resolved and re-checked inside it.
   */
  registerDir(absDir: string): string | null {
    if (!absDir || !isAbsolute(absDir)) return null;
    if (!this.boundPort) {
      this.log('warn', '媒体服务尚未启动，无法注册目录');
      return null;
    }
    const dir = normalize(absDir);
    if (!this.roots.some((root) => isInside(root, dir) || normalizeKey(root) === normalizeKey(dir))) {
      this.log('warn', `拒绝注册壁纸目录之外的目录：${dir}`);
      return null;
    }
    const key = normalizeKey(dir);
    const existing = this.dirTokens.get(key);
    if (existing) return this.sceneFilesUrl(existing);
    const token = createHash('sha256').update(`${this.secret}\0dir\0${key}`).digest('base64url').slice(0, 24);
    this.dirTokens.set(key, token);
    this.dirByToken.set(token, dir);
    return this.sceneFilesUrl(token);
  }

  private sceneFilesUrl(token: string): string {
    return `http://127.0.0.1:${this.boundPort}/wallpaper-engine/scene-files/${token}`;
  }

  /**
   * The engine file the **workbench page** imports.
   *
   * The patched workbench cannot `import()` from the loopback origin: its CSP allows
   * `script-src 'self' 'unsafe-eval' blob:`, and widening that would mean rewriting the
   * checksummed workbench.html — the one thing ① exists to prevent. `blob:` IS allowed,
   * so the injected script fetches this file and imports it from a blob URL. The engine
   * is a single self-contained ESM file, so nothing resolves relative to it.
   */
  setEngineFile(absPath: string | null): void {
    this.engineFile = absPath && isAbsolute(absPath) ? normalize(absPath) : null;
  }

  get engineUrl(): string | null {
    return this.engineFile && this.boundPort ? `http://127.0.0.1:${this.boundPort}/engine/webwallgl.mjs` : null;
  }

  /** Resolve a request path inside `baseDir`, or null when it escapes the fence. */
  private resolveInside(baseDir: string, relPath: string): string | null {
    let rel = relPath;
    try {
      rel = decodeURIComponent(relPath);
    } catch {
      return null;
    }
    if (!rel || rel.includes('\0')) return null;
    const target = resolve(baseDir, rel);
    return isInside(baseDir, target) ? target : null;
  }

  /**
   * Serve the directory's only `*.pkg` under the fixed name the renderer asks for.
   *
   * Only when the request is one of the three names the renderer knows AND the
   * directory holds exactly one pkg — otherwise a directory with several containers
   * would silently pick one, which is worse than a 404 the user can see.
   */
  private async aliasSinglePkg(baseDir: string, requested: string): Promise<string | null> {
    const sub = requested.includes('/') ? dirname(requested) : '';
    // `resolveInside` rejects an empty path (nowhere else does it mean "the root
    // itself"), so the no-subdirectory case uses the registered directory directly.
    const scanDir = sub ? this.resolveInside(baseDir, sub) : baseDir;
    if (!scanDir) return null;
    try {
      const pkgs = (await readdir(scanDir)).filter((name) => name.toLowerCase().endsWith('.pkg'));
      if (pkgs.length !== 1) return null;
      const target = this.resolveInside(baseDir, sub ? `${sub}/${pkgs[0]}` : pkgs[0]);
      if (target) this.log('info', `scene.pkg 别名：${requested} → ${pkgs[0]}`);
      return target;
    } catch {
      return null;
    }
  }

  /**
   * Register a file, returning its media URL, or null when it is out of scope
   * or the server has not been started yet (a URL minted before `start()` would
   * carry the placeholder port — fail loudly instead of handing out a dead link).
   */
  register(absPath: string): string | null {
    if (!absPath || !isAbsolute(absPath)) return null;
    if (!this.boundPort) {
      this.log('warn', '媒体服务尚未启动，无法注册文件');
      return null;
    }
    if (!this.roots.some((root) => isInside(root, absPath))) {
      this.log('warn', `拒绝注册壁纸目录之外的文件：${absPath}`);
      return null;
    }
    const key = normalizeKey(absPath);
    const existing = this.tokens.get(key);
    if (existing) return this.urlFor(existing);
    const token = createHash('sha256').update(`${this.secret}\0${key}`).digest('base64url').slice(0, 24);
    this.tokens.set(key, token);
    this.byToken.set(token, absPath);
    return this.urlFor(token);
  }

  private urlFor(token: string): string {
    return `http://127.0.0.1:${this.boundPort}/m/${token}`;
  }

  get origin(): string | null {
    return this.boundPort ? `http://127.0.0.1:${this.boundPort}` : null;
  }

  get registeredCount(): number {
    return this.byToken.size;
  }

  /** Point the patched workbench at a wallpaper (already-registered URL + kind). */
  setCurrent(target: { url: string; kind: WorkbenchKind; still?: string | null } | null): void {
    this.currentUrl = target ? target.url : null;
    if (target) {
      this.currentKind = target.kind;
      this.currentStill = target.still ?? null;
    }
    // A wallpaper switch is a view change too: the windows should not wait for a poll.
    this.broadcastView();
  }

  /** Wallpaper-layer opacity / scrim / contrast / glass, pushed to the page at runtime. */
  setView(view: {
    opacity?: number;
    scrim?: number;
    contrast?: 'off' | 'balanced' | 'strong';
    blur?: number;
    chromeGlassAlpha?: number;
    editorGlassAlpha?: number;
  }): void {
    if (typeof view.opacity === 'number') this.viewOpacity = view.opacity;
    if (typeof view.scrim === 'number') this.viewScrim = view.scrim;
    if (view.contrast === 'off' || view.contrast === 'balanced' || view.contrast === 'strong') {
      this.viewContrast = view.contrast;
    }
    if (typeof view.blur === 'number') this.viewBlur = view.blur;
    if (typeof view.chromeGlassAlpha === 'number') this.viewChromeAlpha = view.chromeGlassAlpha;
    if (typeof view.editorGlassAlpha === 'number') this.viewEditorAlpha = view.editorGlassAlpha;
    // Every listener applies it now, not on its next poll.
    this.broadcastView();
  }

  get current(): string | null {
    return this.currentUrl;
  }

  /** Streams in flight right now. */
  get activeStreams(): number {
    return this.active;
  }

  /** Distinct patched windows that reported in during the last 5 minutes. */
  get patchedWindows(): number {
    const cutoff = Date.now() - 5 * 60_000;
    let count = 0;
    for (const seenAt of this.seenDocs.values()) if (seenAt >= cutoff) count += 1;
    return count;
  }

  async start(): Promise<string> {
    if (this.server) return this.origin as string;
    const server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server = server;

    const listen = (port: number): Promise<void> =>
      new Promise<void>((resolvePromise, reject) => {
        const onError = (err: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });

    try {
      await listen(this.preferredPort);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!this.preferredPort || (code !== 'EADDRINUSE' && code !== 'EACCES')) {
        this.server = null;
        throw err;
      }
      this.log('warn', `端口 ${this.preferredPort} 不可用（${String(code)}），改用随机端口`);
      await listen(0);
    }

    const addr = server.address() as AddressInfo;
    this.boundPort = addr.port;
    this.log('info', `壁纸媒体服务已启动：${this.origin}`);
    return this.origin as string;
  }

  /**
   * Try to move onto the preferred port after having fallen back to a random one.
   *
   * Every VS Code window runs its own extension host, so with several windows open
   * exactly one can own the port the workbench patch bakes into its media URL.
   * When that window closes, another one claims the port here — the URL does not
   * change (same port, same token), so already-loaded windows keep playing without
   * a reload.
   *
   * @returns true when this instance took the port over.
   */
  async claimPreferredPort(): Promise<boolean> {
    if (!this.preferredPort || !this.server || this.boundPort === this.preferredPort) return false;
    const extra = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    const claimed = await new Promise<boolean>((resolvePromise) => {
      const onError = (): void => {
        extra.removeListener('listening', onListening);
        resolvePromise(false);
      };
      const onListening = (): void => {
        extra.removeListener('error', onError);
        resolvePromise(true);
      };
      extra.once('error', onError);
      extra.once('listening', onListening);
      extra.listen(this.preferredPort, '127.0.0.1');
    });
    if (!claimed) {
      extra.close();
      return false;
    }
    const previous = this.server;
    this.server = extra;
    this.boundPort = this.preferredPort;
    await new Promise<void>((resolvePromise) => previous.close(() => resolvePromise()));
    this.log('info', `已接管壁纸媒体端口 ${this.preferredPort}`);
    return true;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method || 'GET';

    // CORS preflight. The injected page posts its style report as text/plain (so no
    // preflight is needed), but anything that posts JSON would otherwise be dropped
    // by the browser: answering OPTIONS with a bare 200 silently kills the request,
    // which is exactly how /probe stayed empty before. Answer it properly.
    if (method === 'OPTIONS') {
      res
        .writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        })
        .end();
      return;
    }

    // Style probe from the patched page (POST) and its read-back (GET).
    const probePath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
    if (probePath === '/probe') {
    if (method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
        if (body.length > 256 * 1024) req.destroy();
      });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && 'contrast' in parsed) {
            // Readability measurement. Its own slot: the scene report fires on every
            // poll and would overwrite it, and this is the number that answers "is the
            // code readable?" when a screenshot cannot be taken.
            this.lastContrast = parsed.contrast;
          } else if (parsed && typeof parsed === 'object' && 'scene' in parsed) {
            this.lastScene = parsed.scene;
          } else {
            this.lastProbe = parsed;
          }
        } catch {
          this.lastProbe = { error: 'bad json' };
        }
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...(typeof this.lastProbe === 'object' && this.lastProbe ? this.lastProbe : {}), scene: this.lastScene, contrast: this.lastContrast }));
    return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');

    // Beacon from the injected workbench script: "this window loaded the patch".
    if (url.pathname === '/beacon') {
      const doc = url.searchParams.get('doc');
      if (doc) {
        this.seenDocs.set(doc.slice(0, 64), Date.now());
        if (this.seenDocs.size > 64) {
          const oldest = [...this.seenDocs.entries()].sort((a, b) => a[1] - b[1])[0];
          this.seenDocs.delete(oldest[0]);
        }
      }
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }).end();
      return;
    }

    // What the patched workbench should play right now, plus the view settings —
    // sending them here is what keeps workbench.html and its cached css constant.
    if (url.pathname === '/current') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(this.currentPayload()));
      return;
    }

    // Server-sent events: the same payload, pushed the moment anything changes.
    // `connect-src http://127.0.0.1:*` already allows it from the patched document,
    // and EventSource reconnects on its own (retry: below) if the server restarts.
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: view\ndata: ${JSON.stringify(this.currentPayload())}\n\n`);
      this.viewClients.add(res);
      // A comment frame every 25 s keeps proxies/idle timeouts from closing it; the
      // page ignores anything that is not a `view` event.
      const heartbeat = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* the close handler below cleans up */
        }
      }, 25_000);
      const drop = (): void => {
        clearInterval(heartbeat);
        this.viewClients.delete(res);
      };
      res.on('close', drop);
      res.on('error', drop);
      return;
    }

    // Status is answered by whichever window owns the port, so the diagnostic
    // command reports the truth even when run in a window that does not own it.
    if (url.pathname === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          port: this.boundPort,
          activeStreams: this.active,
          patchedWindows: this.patchedWindows,
          registeredFiles: this.byToken.size,
        }),
      );
      return;
    }

    // Scene payloads are PATH-addressable, unlike the opaque /m/<token> files: the
    // renderer resolves a scene's textures/materials relative to the pkg URL, so the
    // directory has to keep its shape. The fence is the registered directory.
    const scene = /^\/wallpaper-engine\/scene-files\/([A-Za-z0-9_-]{16,64})\/(.*)$/.exec(url.pathname);
    if (scene) {
      const baseDir = this.dirByToken.get(scene[1]);
      let target = baseDir ? this.resolveInside(baseDir, scene[2]) : null;
      // `resolveInside` only resolves — it does not prove the file exists, so the
      // alias has to test existence itself. The renderer only ever asks for
      // `scene.pkg` / `scenes/scene.pkg` / `gifscene.pkg` (fixed names baked into its
      // HTTP source), while our resolver accepts ANY single *.pkg in the directory:
      // without the alias such a wallpaper 404s three times and renders nothing.
      if (baseDir && (!target || !existsSync(target)) && /^(scenes\/)?(gif)?scene\.pkg$/i.test(scene[2])) {
        target = (await this.aliasSinglePkg(baseDir, scene[2])) ?? target;
      }
      // NOTE: no HTML rewriting here. The vendored engine injects its own WE web-API
      // shim into the author document when it builds the sandbox iframe (and it
      // detects a second injection), so anything we added to the served HTML was a
      // redundant — and here even broken — second shim.
      await this.servePath(target, req, res, method, undefined, 'revalidate');
      return;
    }

    // The engine, for the patched workbench's blob-import (see setEngineFile): served
    // as JavaScript from the extension's own media/ directory, nothing user-supplied.
    if (url.pathname === '/engine/webwallgl.mjs') {
      await this.servePath(this.engineFile, req, res, method, undefined, 'revalidate');
      return;
    }

    const m = /^\/m\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
    await this.servePath(m ? this.byToken.get(m[1]) ?? null : null, req, res, method);
  }

  /**
   * Stream one resolved file with Range support. `null` (unknown token, escaped
   * fence, missing engine) is a uniform 404 on purpose: a malformed path and an
   * unknown token must be indistinguishable from outside.
   *
   * `transform` is applied to text files only (the engine's index.html, where one
   * small script is injected). Range requests bypass it — a partial body of a
   * rewritten document would be worse than the un-rewritten one.
   *
   * `cache` is `no-store` for the opaque wallpaper tokens (a token says nothing about
   * content, so a stale hit would be silent) and `revalidate` for scene payloads:
   * a `scene.pkg` is measured in tens to hundreds of MB, the renderer downloads it
   * whole before the first frame, and the panel is destroyed/rebuilt on every tab
   * switch (retainContextWhenHidden is false). Re-downloading that each time is the
   * difference between "tab switch is instant" and "tab switch re-parses 300 MB".
   */
  private async servePath(
    file: string | null,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    transform?: (text: string) => string,
    cache: 'no-store' | 'revalidate' = 'no-store',
  ): Promise<void> {
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    let size: number;
    let etag: string | null = null;
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      size = st.size;
      if (cache === 'revalidate') etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('gone');
      return;
    }

    if (etag && req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-cache', ETag: etag, 'Access-Control-Allow-Origin': '*' }).end();
      return;
    }

    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': mimeFor(file),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache === 'revalidate' ? 'no-cache' : 'no-store',
      ...(etag ? { ETag: etag } : {}),
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    };

    if (transform && size < 4 * 1024 * 1024) {
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('gone');
        return;
      }
      const body = Buffer.from(transform(text), 'utf8');
      res.writeHead(200, { ...headers, 'Content-Length': body.length });
      res.end(method === 'HEAD' ? undefined : body);
      return;
    }

    const range = parseRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    if (range) {
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
        'Content-Length': range.end - range.start + 1,
      });
      if (method === 'HEAD') {
        res.end();
        return;
      }
      this.stream(createReadStream(file, { start: range.start, end: range.end }), res, file);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': size });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    this.stream(createReadStream(file), res, file);
  }

  /** Count a stream while it lasts, so the status command can report live playback. */
  private stream(source: NodeJS.ReadableStream, res: http.ServerResponse, file: string): void {
    this.active += 1;
    const done = (): void => {
      this.active = Math.max(0, this.active - 1);
    };
    res.once('close', done);
    source.on('error', (err) => {
      this.log('warn', `读取失败 ${file}: ${String(err)}`);
      res.destroy();
      done();
    });
    source.pipe(res);
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = 0;
    // Close the event streams first: server.close() waits for open connections, and an
    // SSE response never ends on its own.
    for (const client of this.viewClients) {
      try {
        client.end();
      } catch {
        /* already gone */
      }
    }
    this.viewClients.clear();
    if (!server) return;
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    this.log('info', '壁纸媒体服务已停止');
  }
}
