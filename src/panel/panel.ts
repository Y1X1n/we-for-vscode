/**
 * The wallpaper webview.
 *
 * Boundary note (see the evaluation report): a VS Code extension cannot style
 * the workbench, so "wallpaper behind the chat" is impossible through the
 * official API. What this panel *can* be is the wallpaper surface itself —
 * a webview the extension fully controls. That is the whole point of方案 A.
 *
 * CSP is strict on purpose. The only non-cspSource origin allowed is the
 * loopback media server, and it is spelled with its concrete port.
 */

import * as vscode from 'vscode';

import { Logger } from '../log';
import { InventorySnapshot, WallpaperItem } from '../service';

export interface PanelHooks {
  /**
   * The user picked a wallpaper in the panel's own library list. The webview sends the
   * item id only — the host owns the inventory and the selection state.
   */
  onSelectRequest(id: string): void;
  /**
   * The webview wants state but the host has none yet (a panel restored by VS Code
   * never went through the open command). The host scans and pushes the snapshot.
   */
  onNeedsInventory(): void;
  onNextRequest(): void;
  onSettingChange(key: string, value: unknown): Promise<void>;
  onWebviewLog(level: 'info' | 'warn' | 'error', message: string): void;
}

/** Settings pushed to the webview, in the shape media/glass.mjs expects. */
export interface GlassSettings {
  blur: number;
  saturate: number;
  wallpaperOpacity: number;
  scrim: number;
  border: number;
  glassAlpha: number;
  glassColor: string;
  panelWidth: number;
  /** Frosted chrome / editor surface alphas (see weWallpaper.chromeGlassAlpha). */
  chromeGlassAlpha: number;
  editorGlassAlpha: number;
  /** Readability policy: the panel measures its own wallpaper and raises the dimming. */
  autoContrast: 'off' | 'balanced' | 'strong';
}

export class WallpaperPanel {
  private static current: WallpaperPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Last pushed state, replayed on the webview's `ready`. Without this the
   * panel's first push races the document load: postMessage to a webview that
   * has not run its script yet is simply lost, and the user opens the view to a
   * black stage with no wallpaper.
   */
  private lastSnapshot: InventorySnapshot | undefined;
  private lastItem: WallpaperItem | null | undefined;
  /**
   * Whether THIS panel should mount the engine for the current item. The host decides
   * (weWallpaper.liveSurface): with `workbench` the identical render already happens
   * behind the whole window, and a second engine instance would cost another full
   * render on the same main thread for no visual gain. Replayed on `ready` like the
   * rest of the state, because the first push races the document load.
   */
  private panelLive = true;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly log: Logger,
    private readonly mediaOrigin: string,
    private readonly hooks: PanelHooks,
  ) {
    this.panel.webview.html = this.loadingHtml();
    void this.applyHtml();
    this.panel.webview.onDidReceiveMessage(
      (msg: { type?: string; key?: string; value?: unknown; level?: string; message?: string; id?: string }) => {
        void this.onMessage(msg);
      },
      null,
      this.disposables,
    );
    // Occlusion pause (upstream's 遮挡暂停): a hidden panel is not worth GPU time.
    this.panel.onDidChangeViewState(
      () => this.post({ type: 'visibility', visible: this.panel.visible }),
      null,
      this.disposables,
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(
    extensionUri: vscode.Uri,
    log: Logger,
    mediaOrigin: string,
    hooks: PanelHooks,
  ): WallpaperPanel {
    const column = vscode.window.activeTextEditor?.viewColumn;
    if (WallpaperPanel.current) {
      WallpaperPanel.current.panel.reveal(column);
      return WallpaperPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('weWallpaper', 'Wallpaper Engine', column ?? vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
    });
    WallpaperPanel.current = new WallpaperPanel(panel, extensionUri, log, mediaOrigin, hooks);
    return WallpaperPanel.current;
  }

  static get instance(): WallpaperPanel | undefined {
    return WallpaperPanel.current;
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  private async onMessage(msg: {
    type?: string;
    key?: string;
    value?: unknown;
    level?: string;
    message?: string;
    id?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.log.info('webview 已就绪');
        this.post({ type: 'init', settings: this.readSettings() });
        // Replay whatever the host already decided, in render order.
        if (this.lastSnapshot) this.post({ type: 'inventory', snapshot: this.lastSnapshot });
        if (this.lastItem !== undefined) this.post({ type: 'item', item: this.lastItem });
        this.post({ type: 'live', panelLive: this.panelLive });
        // A webview that VS Code RESTORED (tab brought back on restart) never went
        // through the open command, so the host has no inventory yet — and without
        // this the panel sits on "正在扫描本地壁纸库…" forever, which reads as "the
        // library cannot be scanned". Ask for one instead of assuming it exists.
        if (!this.lastSnapshot) this.hooks.onNeedsInventory();
        break;
      case 'select':
        if (typeof msg.id === 'string') this.hooks.onSelectRequest(msg.id);
        break;
      case 'next':
        this.hooks.onNextRequest();
        break;
      case 'setting':
        if (typeof msg.key === 'string') await this.hooks.onSettingChange(msg.key, msg.value);
        break;
      case 'log':
        this.hooks.onWebviewLog(
          (msg.level as 'info' | 'warn' | 'error') || 'info',
          String(msg.message ?? ''),
        );
        break;
      default:
        this.log.warn(`未知的 webview 消息：${JSON.stringify(msg)}`);
    }
  }

  private readSettings(): GlassSettings {
    const c = vscode.workspace.getConfiguration('weWallpaper');
    return {
      blur: c.get<number>('blur', 16),
      saturate: c.get<number>('saturate', 1.3),
      wallpaperOpacity: c.get<number>('wallpaperOpacity', 1),
      scrim: c.get<number>('scrim', 0.35),
      border: c.get<number>('border', 1),
      glassAlpha: c.get<number>('glassAlpha', 0.45),
      glassColor: c.get<string>('glassColor', '#101014'),
      panelWidth: c.get<number>('panelWidth', 420),
      chromeGlassAlpha: c.get<number>('chromeGlassAlpha', 0.45),
      editorGlassAlpha: c.get<number>('editorGlassAlpha', 0.72),
      autoContrast: (() => {
        const v = c.get<string>('autoContrast', 'balanced');
        return v === 'off' || v === 'strong' ? v : 'balanced';
      })(),
    };
  }

  post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  pushSettings(): void {
    this.post({ type: 'settings', settings: this.readSettings() });
  }

  /**
   * Whether the panel is the surface that renders the wallpaper live. `false` means
   * the whole-window layer owns it (the panel then shows the still), which is what
   * keeps one wallpaper from being rendered twice on the same main thread.
   */
  setLiveSurface(panelLive: boolean): void {
    this.panelLive = !!panelLive;
    this.post({ type: 'live', panelLive: this.panelLive });
  }

  /**
   * Open the panel's own wallpaper library (host-initiated, e.g. the
   * `weWallpaper.pickWallpaper` command). Selection itself happens entirely inside the
   * panel — the command used to pop a QuickPick over the window's top bar, which is
   * exactly what moving the library in here was meant to remove.
   */
  openLibrary(): void {
    this.post({ type: 'library', open: true });
  }

  pushInventory(snapshot: InventorySnapshot): void {
    this.lastSnapshot = snapshot;
    this.post({ type: 'inventory', snapshot });
  }

  showItem(item: WallpaperItem | undefined): void {
    this.lastItem = item ?? null;
    this.post({ type: 'item', item: this.lastItem });
  }

  /** Placeholder shown for the few ms the template read from disk takes. */
  private loadingHtml(): string {
    return `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:1rem">正在读取壁纸模板…</body></html>`;
  }

  private async applyHtml(): Promise<void> {
    try {
      this.panel.webview.html = await this.buildHtml();
    } catch (err) {
      this.log.error(`渲染 webview 模板失败：${String(err)}`);
      this.panel.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:1rem">模板读取失败：${String(
        err,
      )}</body></html>`;
    }
  }

  private async buildHtml(): Promise<string> {
    const webview = this.panel.webview;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.mjs'));
    const origin = this.mediaOrigin;
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data: blob: ${origin}`,
      `media-src ${origin} blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline' ${origin}`,
      `font-src ${webview.cspSource} ${origin}`,
      // Our own modules load from ${webview.cspSource} only. The other three entries
      // are for the engine and its wallpaper payload:
      //  - 'unsafe-eval': WE scene scripts (text widgets, object property
      //    expressions like Solid.scale) are author expressions the engine compiles
      //    as JS strings. CSP without unsafe-eval fails every one of them
      //    ("Evaluating a string as JavaScript …") and scripted scenes render
      //    broken or not at all. The workbench layer already allowed eval, which
      //    is exactly why scenes worked there but not here.
      //  - 'unsafe-inline' + ${origin}: a Web wallpaper runs in a blob: iframe
      //    that INHERITS this policy (blob documents carry the creator's CSP), and
      //    that document is the engine's rewritten author HTML: inline shim +
      //    author inline scripts + author files from the loopback origin (<base
      //    href> points there). Without them every Web wallpaper mounts and then
      //    silently runs no code.
      `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' ${origin}`,
      `worker-src blob: ${origin}`,
      `connect-src ${origin}`,
      // blob: for the engine's rewritten author document; ${origin} for its fallback
      // bare-iframe path (author HTML carrying its own blocking CSP meta).
      `frame-src blob: ${origin}`,
    ].join('; ');

    const file = vscode.Uri.joinPath(mediaRoot, 'index.html');
    const raw = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
    return raw
      .replace('%CSP%', csp)
      .replace('%STYLE_URI%', styleUri.toString())
      .replace('%SCRIPT_URI%', scriptUri.toString())
      .replace('%MEDIA_ORIGIN%', origin);
  }

  dispose(): void {
    WallpaperPanel.current = undefined;
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this.panel.dispose();
  }
}
