/**
 * Wallpaper Engine for VS Code.
 *
 * Two surfaces, deliberately separate:
 *   1. 方案 A (supported): the wallpaper view — a webview this extension owns.
 *   2. 方案 B (experiment): the wallpaper behind the whole workbench, which
 *      requires patching the installation (see src/workbench/*). Off by default,
 *      fully reversible, and never enabled without an explicit command.
 */

import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';

import * as vscode from 'vscode';

import { Level, Logger } from './log';
import { MediaServer } from './media/server';
import { WallpaperPanel } from './panel/panel';
import { WallpaperItem, WallpaperService } from './service';
import {
  CONTROLS_STYLE_DOM,
  EDITOR_OVERLAY_COLORS,
  TITLEBAR_COLORS,
  WALLPAPER_EDITOR_SETTINGS,
  isCustomTitleBar,
  mergeColors,
  mergeSettings,
  planWindowStyles,
  supportsControlsStyle,
} from './titlebar';
import { WorkbenchInstaller } from './workbench/installer';

const SELECTED_KEY = 'weWallpaper.selectedId';
const TITLEBAR_STASH_KEY = 'weWallpaper.titleBarColorStash';
/** Stash for the editor settings wallpaper mode overrides (sticky scroll, …). */
const EDITOR_SETTINGS_STASH_KEY = 'weWallpaper.editorSettingsStash';

const CONTROLS_STYLE_STASH_KEY = 'weWallpaper.windowControlsStyleStash';
const NOTICE_SEEN_KEY = 'weWallpaper.patchNoticeSeen';
const SWITCHES_INIT_KEY = 'weWallpaper.switchesInitialised';

/**
 * Derive the media-token secret deterministically instead of storing a random one.
 *
 * Every window runs its own extension host, and the workbench patch bakes ONE
 * media URL into a file all windows share — so all of them must mint the same
 * token for the same wallpaper. A stored random secret loses that race when two
 * windows activate at once (globalState is cached per window), which would 404
 * wherever the loser's token was baked. Deriving it from stable machine facts
 * removes the race, the storage, and the cross-window cache dependency.
 *
 * The server binds 127.0.0.1 only and serves nothing outside the Wallpaper Engine
 * roots, so a derivable secret does not widen the exposure in any practical way.
 */
function deriveMediaSecret(appRoot: string): string {
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    /* some sandboxes refuse this; hostname + appRoot still differ per machine */
  }
  return createHash('sha256').update(['we-for-vscode', appRoot, hostname(), user].join('\0')).digest('hex');
}

function readLevel(): Level {
  const v = vscode.workspace.getConfiguration('weWallpaper').get<string>('logLevel', 'warn');
  return v === 'error' || v === 'info' ? v : 'warn';
}

function readSteamRoots(): string[] {
  const raw = vscode.workspace.getConfiguration('weWallpaper').get<string>('steamRoot', '');
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = new Logger(readLevel());
  const mediaPort = vscode.workspace.getConfiguration('weWallpaper').get<number>('mediaPort', 39127);
  const media = new MediaServer(log.logFn, { secret: deriveMediaSecret(vscode.env.appRoot), preferredPort: mediaPort });
  // Scene/Web live rendering needs no setup: the engine is the MIT npm package
  // `webwallgl`, vendored under media/ and imported by the webview itself.
  const service = new WallpaperService(log, media, readSteamRoots);
  /** Opt-in: a live Scene behind the whole UI (see workbenchTargetFor). */
  const liveSceneEnabled = (): boolean =>
    vscode.workspace.getConfiguration('weWallpaper').get<boolean>('workbenchLiveScene', false);
  /**
   * Which surface renders a Scene/Web wallpaper live when both are available.
   *
   * Rendering the same wallpaper in the panel *and* behind the whole UI means two
   * engine instances, and measured they share one thing: the renderer process's main
   * thread — the same thread the editor UI runs on. `workbench` (the default) puts the
   * live render where the user actually looks at the whole window and leaves the panel
   * on the captured still; `panel` is the reverse; `both` is the old behaviour.
   */
  const liveSurface = (): 'both' | 'workbench' | 'panel' => {
    const value = vscode.workspace.getConfiguration('weWallpaper').get<string>('liveSurface', 'workbench');
    return value === 'panel' || value === 'both' || value === 'workbench' ? value : 'workbench';
  };
  // The patched workbench imports the engine from a blob URL (its CSP allows blob:
  // scripts but not the loopback origin), so the engine file is served from the
  // extension's own media directory — never from the user's disk.
  media.setEngineFile(
    vscode.Uri.joinPath(context.extensionUri, 'media', 'webwallgl', 'webwallgl.min.mjs').fsPath,
  );
  const installer = new WorkbenchInstaller(vscode.env.appRoot, log);
  context.subscriptions.push(log);
  context.subscriptions.push({ dispose: () => void media.dispose() });

  let rotation: NodeJS.Timeout | undefined;
  let selectedId: string | undefined = context.globalState.get<string>(SELECTED_KEY);

  // ── wiring ────────────────────────────────────────────────────────────────
  const panelHooks = {
    onSelectRequest: (id: string): void => void selectById(id),
    onNeedsInventory: (): void => {
      // Restored panel: no snapshot in this session yet. Scan, then push.
      void ensureInventory()
        .then((snapshot) => WallpaperPanel.instance?.pushInventory(snapshot))
        .catch((err) => log.error(`扫描壁纸库失败：${String(err)}`));
    },
    onNextRequest: (): void => void nextWallpaper(),
    onSettingChange: async (key: string, value: unknown): Promise<void> => {
      await vscode.workspace.getConfiguration('weWallpaper').update(key, value, vscode.ConfigurationTarget.Global);
    },
    onWebviewLog: (level: 'info' | 'warn' | 'error', message: string): void => {
      if (level === 'error') log.error(`[webview] ${message}`);
      else if (level === 'warn') log.warn(`[webview] ${message}`);
      else log.info(`[webview] ${message}`);
    },
  };

  const ensureMedia = async (): Promise<string> => media.origin ?? (await media.start());

  const ensureInventory = async (force = false) => {
    const existing = service.current;
    if (existing && !force) return existing;
    await ensureMedia();
    return service.scan(force);
  };

  /**
   * True when the whole-window layer is the live surface for this item: the switch is
   * on, the installation is patched, the layer's live renderer is enabled, and the
   * item is one the engine can mount. Only then may the panel skip its own instance —
   * otherwise the panel would show a still with nothing live anywhere.
   */
  const workbenchRendersLive = (item: WallpaperItem | undefined, patched = installer.status().patched): boolean =>
    Boolean(item) &&
    patched &&
    liveSurface() === 'workbench' &&
    liveSceneEnabled() &&
    vscode.workspace.getConfiguration('weWallpaper').get<boolean>('workbenchBackground', false) &&
    (item?.renderMode === 'scene' || item?.renderMode === 'web') &&
    Boolean(item?.sceneBase);

  /** Tell the panel whether IT should mount the engine for the current item. */
  const syncPanelLivePolicy = (item: WallpaperItem | undefined, patched?: boolean): void => {
    WallpaperPanel.instance?.setLiveSurface(!workbenchRendersLive(item, patched));
  };

  const showSelected = async (item = service.find(selectedId) ?? service.playableItems()[0]) => {
    if (!item) return;
    selectedId = item.id;
    await context.globalState.update(SELECTED_KEY, item.id);
    status.text = `$(file-media) ${item.title}`;
    status.tooltip = `Wallpaper Engine：${item.title}（${item.type}${item.contentrating ? ` · ${item.contentrating}` : ''}）`;
    WallpaperPanel.instance?.showItem(item);
    const patched = installer.status().patched;
    syncPanelLivePolicy(item, patched);
    log.info(`面板项已更新：${item.title}（renderMode=${item.renderMode}，面板${WallpaperPanel.instance ? '已打开' : '未打开'}）`);
    // Mirror the selection into the settings page so it is visible/editable there.
    const cfg = vscode.workspace.getConfiguration('weWallpaper');
    if (cfg.get<string>('wallpaperId', '') !== item.id) await setSetting('wallpaperId', item.id, true);
    // Keep the workbench background in step with the selection.
    if (patched) void refreshWorkbenchPatch(true);
  };

  async function openPanel(): Promise<void> {
    const origin = await ensureMedia();
    const snapshot = await ensureInventory();
    const panel = WallpaperPanel.createOrShow(context.extensionUri, log, origin, panelHooks);
    panel.pushInventory(snapshot);
    panel.pushSettings();
    const item = service.find(selectedId) ?? service.playableItems()[0];
    if (item) {
      selectedId = item.id;
      await context.globalState.update(SELECTED_KEY, item.id);
      // Decide the live surface BEFORE pushing the item: the webview mounts on the
      // first `item` it sees, and a mount that starts first has to be torn down again.
      panel.setLiveSurface(!workbenchRendersLive(item));
      panel.showItem(item);
      status.text = `$(file-media) ${item.title}`;
      status.tooltip = `Wallpaper Engine：${item.title}（${item.type}）`;
    }
    return;
  }

  /**
   * Select a wallpaper by id — the panel's library list calls this on every click.
   *
   * Unlike the old `pickWallpaper`, nothing here is modal: the list stays open, so the
   * user can click through wallpapers and watch each one appear behind the glass.
   */
  async function selectById(id: string): Promise<void> {
    const item = service.find(id);
    if (!item) return;
    await showSelected(item);
  }

  /**
   * The `选择壁纸…` command. It opens the panel and asks IT to show the library: the
   * selection UI lives inside the wallpaper view, not in a QuickPick over the window's
   * top bar (which is what it used to be).
   */
  async function pickWallpaper(): Promise<void> {
    const snapshot = await ensureInventory();
    if (!snapshot.items.length) {
      const choice = await vscode.window.showWarningMessage(
        '没有找到 Wallpaper Engine 壁纸。请确认已安装 Wallpaper Engine，或手动指定 Steam 根目录。',
        '打开设置',
        '输出日志',
      );
      if (choice === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'weWallpaper.steamRoot');
      if (choice === '输出日志') log.show();
      return;
    }
    await openPanel();
    WallpaperPanel.instance?.openLibrary();
  }

  async function rescan(): Promise<void> {
    const snapshot = await ensureInventory(true);
    WallpaperPanel.instance?.pushInventory(snapshot);
    const item = service.find(selectedId) ?? service.playableItems()[0];
    if (item) await showSelected(item);
    void vscode.window.showInformationMessage(
      `扫描完成：${snapshot.items.length} 张壁纸（可播放 ${snapshot.playableCount} 张）${
        snapshot.installDir ? `，安装目录 ${snapshot.installDir}` : '，未找到 Wallpaper Engine 安装目录'
      }`,
    );
  }

  async function nextWallpaper(): Promise<void> {
    await ensureInventory();
    const next = service.nextAfter(selectedId);
    if (next) await showSelected(next);
  }

  // ── 方案 B: wallpaper behind the workbench (experiment, reversible) ────────
  const workbenchPatchSettings = (origin: string) => ({ origin });

  /** Push the view sliders to the patched pages (no re-patch, no reload). */
  const pushWorkbenchView = (): void => {
    media.setView({
      opacity: vscode.workspace.getConfiguration('weWallpaper').get<number>('workbenchOpacity', 1),
      scrim: vscode.workspace.getConfiguration('weWallpaper').get<number>('workbenchScrim', 0.35),
    });
  };

  const promptReload = async (message: string): Promise<void> => {
    const pick = await vscode.window.showInformationMessage(message, '立即重载窗口', '稍后');
    if (pick === '立即重载窗口') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  /**
   * A reload is not enough for the window-controls keys: the main process reads
   * them when the window is CREATED, so a reload would keep the old native overlay
   * and add the new DOM buttons underneath it. Closing the window is the only way
   * to get a fresh one.
   */
  const promptWindowRestart = async (on: boolean): Promise<void> => {
    const pick = await vscode.window.showInformationMessage(
      `透明标题栏已${on ? '启用' : '关闭'}。\n\n` +
        '右上角三个按钮由“系统原生覆盖层”还是 DOM 元素绘制，取决于 window.controlsStyle，' +
        '而这个值只在**创建窗口时**读取：请完全关闭并重新打开 VS Code（Ctrl+R 只重载页面，不够；' +
        '其它已打开的窗口也要各自关掉重开）。',
      '关闭本窗口',
      '稍后',
    );
    if (pick === '关闭本窗口') void vscode.commands.executeCommand('workbench.action.closeWindow');
  };

  /**
   * Transparent title bar: `window.titleBarStyle`, `window.controlsStyle` and the
   * two `titleBar.*Background` theme colours.
   *
   * `window.controlsStyle = "custom"` is the key that actually makes the three
   * buttons transparent: only then does VS Code stop using Electron's native
   * window-controls overlay and render them as DOM
   * (`.window-controls-container > .window-icon`), which the injected stylesheet can
   * see through. The main process reads it when the window is CREATED, so this one
   * needs a full close/reopen — a reload keeps the old native overlay.
   *
   * The colours are the supporting lever (they generate the `--vscode-titleBar-*`
   * variables the DOM title bar and buttons consume). On their own they can never
   * make the native buttons transparent: VS Code runs that overlay colour through
   * `makeOpaque()` first, which turns any transparency into a solid theme colour —
   * see the header comment in titlebar.ts. Both keys are stashed, so turning this
   * off restores exactly what was there before.
   *
   * @returns true when a `window.*` key was written — i.e. when only a freshly
   *          created window can pick the change up (the colours alone would not
   *          need that).
   */
  async function setTransparentTitleBar(on: boolean): Promise<boolean> {
    let windowKeysChanged = false;
    try {
      const windowCfg = vscode.workspace.getConfiguration('window');
      const current = {
        titleBarStyle: windowCfg.get<string>('titleBarStyle'),
        controlsStyle: supportsControlsStyle(process.platform) ? windowCfg.get<string>('controlsStyle') : undefined,
      };
      const stash = { controlsStyle: context.globalState.get<string>(CONTROLS_STYLE_STASH_KEY) };
      // Remember the user's own controlsStyle before we displace it — same rule as
      // the colour stash below.
      if (on && current.controlsStyle && current.controlsStyle !== CONTROLS_STYLE_DOM && stash.controlsStyle === undefined) {
        await context.globalState.update(CONTROLS_STYLE_STASH_KEY, current.controlsStyle);
      }
      for (const { key, value } of planWindowStyles(on, current, stash, process.platform)) {
        await windowCfg.update(key, value, vscode.ConfigurationTarget.Global);
        windowKeysChanged = true;
        log.info(`window.${key} → ${value ?? '(移除，回到默认值)'}`);
      }
      if (!on && current.controlsStyle === CONTROLS_STYLE_DOM) {
        await context.globalState.update(CONTROLS_STYLE_STASH_KEY, undefined);
      }
    } catch (err) {
      log.warn(`写入 window.titleBarStyle / window.controlsStyle 失败：${String(err)}`);
    }

    try {
      const workbenchCfg = vscode.workspace.getConfiguration('workbench');
      const stash = context.globalState.get<Record<string, string>>(TITLEBAR_STASH_KEY, {});
      // One merge for both groups: the title-bar keys (CSS variables the DOM title
      // bar consumes) and the editor overlays VS Code paints from a colour it reads
      // in JS — for those, this setting is the only lever that works at all.
      const merged = mergeColors(
        workbenchCfg.get<Record<string, unknown>>('colorCustomizations'),
        { ...TITLEBAR_COLORS, ...EDITOR_OVERLAY_COLORS },
        on,
        stash,
      );
      if (merged.changed) {
        await workbenchCfg.update('colorCustomizations', merged.next, vscode.ConfigurationTarget.Global);
        await context.globalState.update(TITLEBAR_STASH_KEY, merged.stash);
        log.info(
          `配色已${on ? '写入' : '还原'}：${[...Object.keys(TITLEBAR_COLORS), ...Object.keys(EDITOR_OVERLAY_COLORS)].join(', ')}`,
        );
      }
    } catch (err) {
      log.warn(`写入 workbench.colorCustomizations 失败：${String(err)}`);
    }

    return windowKeysChanged;
  }

  /** Settings-driven apply: the switch is the single source of truth. */
  async function applyWorkbenchSetting(on: boolean, interactive: boolean): Promise<void> {
    const st = installer.status();
    if (!st.supported) {
      if (on) void vscode.window.showErrorMessage(`这个 VS Code 安装不支持打补丁：${st.reason ?? '未知原因'}`);
      return;
    }
    if (on) {
      // Ask for consent the first time only; afterwards the setting is the record
      // of consent, so flipping it should just work.
      if (interactive && !context.globalState.get<boolean>(NOTICE_SEEN_KEY, false)) {
        const ok = await vscode.window.showWarningMessage(
          '实验功能：会修改 VS Code 安装目录下的 workbench.html（已备份，可随时关闭还原），并把校验和同步写回 product.json 以保持完整性校验通过。',
          { modal: true },
          '继续',
        );
        if (ok !== '继续') {
          // Flip the switch back; the handler re-entry is harmless (disable on an
          // unpatched install is a no-op), but suppressing it keeps the log clean.
          await setSetting('workbenchBackground', false, true);
          return;
        }
        await context.globalState.update(NOTICE_SEEN_KEY, true);
      }
      await enableWorkbenchBackground(true);
    } else {
      await disableWorkbenchBackground(true);
    }
  }

  /**
   * Corrective writes we make ourselves must not re-enter the config handler.
   * Only the "put that switch back the way it was" paths use it — a write the user
   * or a command initiated is supposed to run the handler.
   */
  let suppressSettingSync = false;

  async function setSetting(key: string, value: unknown, corrective = false): Promise<void> {
    if (corrective) {
      suppressSettingSync = true;
      setTimeout(() => {
        suppressSettingSync = false;
      }, 1500);
    }
    await vscode.workspace.getConfiguration('weWallpaper').update(key, value, vscode.ConfigurationTarget.Global);
  }

  /** Re-inject the patch with the current wallpaper + settings. */
  async function refreshWorkbenchPatch(prompt: boolean): Promise<boolean> {
    const st = installer.status();
    if (!st.supported || !st.patched) return false;
    const origin = await ensureMedia();
    await ensureInventory();
    const item = service.find(selectedId) ?? service.playableItems()[0];
    if (!item?.media) {
      log.warn('当前壁纸没有可用的媒体 URL，工作台背景保持原样');
      return false;
    }
    // The patched page polls /current, so this alone switches every patched
    // window — no rewrite of workbench.html (and therefore no checksum change).
    media.setCurrent(service.workbenchTargetFor(item, liveSceneEnabled(), liveSurface()));
    pushWorkbenchView();
    const after = await installer.enable(workbenchPatchSettings(origin));
    await applyWallpaperEditorSettings(true);
    log.info(`工作台背景已刷新：${item.title}`);
    // The window this code runs in loaded the css/js BEFORE this rewrite, so it is
    // still showing the previous build. Reloading re-reads workbench.html (which
    // points at the frozen loader) and therefore picks up the new assets — without
    // this prompt an update looks like it did nothing.
    if (after.assetsUpdated) {
      markAssetsStale();
      await promptReload('壁纸资源已更新，需要重载窗口才会生效（其它窗口各按一次 Ctrl+R）。');
      return true;
    }
    if (prompt) await promptReload(`工作台背景已切换到「${item.title}」；已打开的窗口会在 15 秒内自动跟上。`);
    return true;
  }

  async function enableWorkbenchBackground(fromSetting: boolean): Promise<void> {
    const st = installer.status();
    if (!st.supported) {
      void vscode.window.showErrorMessage(`这个 VS Code 安装不支持打补丁：${st.reason ?? '未知原因'}`);
      return;
    }
    await ensureMedia();
    await ensureInventory();
    const item = service.find(selectedId) ?? service.playableItems()[0];
    if (!item?.media) {
      void vscode.window.showWarningMessage(
        '工作台背景目前只支持 Video 壁纸（Scene/Web 的实时渲染是下一步）。请先选一张 Video 壁纸。',
      );
      return;
    }
    const origin = await ensureMedia();
    media.setCurrent(service.workbenchTargetFor(item, liveSceneEnabled(), liveSurface()));
    const after = await installer.enable(workbenchPatchSettings(origin));
    await applyWallpaperEditorSettings(true);
    log.info(`补丁状态：patched=${after.patched} checksumMismatch=${after.checksumMismatch ?? false}`);
    if (after.assetsUpdated) {
      markAssetsStale();
      // Whatever this window is showing now, it is the PREVIOUS build: it loaded the
      // css/js before this write. Reloading is what makes an update actually land.
      await promptReload('壁纸资源已更新，需要重载窗口才会生效（其它已打开的窗口各按一次 Ctrl+R）。');
      return;
    }
    if (fromSetting) {
      // The consent modal was already shown by applyWorkbenchSetting; tell the user
      // what is left to do, including the top bar (which CSS alone cannot reach).
      await promptReload(
        `已为「${item.title}」注入工作台背景。\n\n每个已打开的窗口都要各自重载一次才会加载它（本窗口点“立即重载窗口”，其它窗口各按一次 Ctrl+R，或完全退出再打开）。新开的窗口自动生效。`,
      );
      if (!isCustomTitleBar(vscode.workspace.getConfiguration('window').get<string>('titleBarStyle'))) {
        const pick = await vscode.window.showInformationMessage(
          '顶部标题栏由 Windows 绘制，右上角三个按钮是 Electron 的原生覆盖层（颜色还被 VS Code 强制成不透明），CSS 都碰不到。' +
            '打开「透明标题栏」开关即可：它会把 window.titleBarStyle 与 window.controlsStyle 都切成 custom，' +
            '让标题栏和这三个按钮都变成 DOM 元素，样式表才能让它们透出壁纸（需要重开窗口生效）。',
          '打开该设置',
        );
        if (pick === '打开该设置') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'weWallpaper.transparentTitleBar');
        }
      }
      return;
    }
    await promptReload(
      `已为「${item.title}」注入工作台背景。\n\n注意：补丁是文件级的，但每个**已打开**的窗口都要各自重载一次才会加载它（本窗口点“立即重载窗口”；其它窗口各按一次 Ctrl+R，或完全退出 VS Code 再打开）。新开的窗口自动生效。`,
    );
  }

  async function disableWorkbenchBackground(fromSetting: boolean): Promise<void> {
    const st = installer.status();
    if (!st.supported) {
      void vscode.window.showErrorMessage(`这个 VS Code 安装不支持打补丁：${st.reason ?? '未知原因'}`);
      return;
    }
    if (!st.patched) {
      if (!fromSetting) void vscode.window.showInformationMessage('当前没有启用工作台背景。');
      return;
    }
    await installer.disable();
    await applyWallpaperEditorSettings(false);
    await promptReload('已移除工作台背景并把安装目录还原为原样。');
  }

  /**
   * Wallpaper mode also has to change editor settings whose feature is an overlay by
   * design (see WALLPAPER_EDITOR_SETTINGS). Same stash discipline as the colours: the
   * user's own value — including "never set" — is restored when the wallpaper goes.
   */
  async function applyWallpaperEditorSettings(on: boolean): Promise<void> {
    const stash = context.globalState.get<Record<string, unknown>>(EDITOR_SETTINGS_STASH_KEY, {});
    const current: Record<string, unknown> = {};
    for (const key of Object.keys(WALLPAPER_EDITOR_SETTINGS)) {
      current[key] = vscode.workspace.getConfiguration().get(key);
    }
    const merged = mergeSettings(current, WALLPAPER_EDITOR_SETTINGS, on, stash);
    if (!merged.changed) return;
    try {
      for (const key of Object.keys(WALLPAPER_EDITOR_SETTINGS)) {
        // `undefined` deletes our override instead of writing a value the user never had.
        await vscode.workspace
          .getConfiguration()
          .update(key, merged.next[key], vscode.ConfigurationTarget.Global);
      }
      await context.globalState.update(EDITOR_SETTINGS_STASH_KEY, merged.stash);
      log.info(
        `编辑器设置已${on ? '调整' : '还原'}：${Object.entries(WALLPAPER_EDITOR_SETTINGS)
          .map(([k, v]) => `${k}=${on ? String(v) : '还原'}`)
          .join(', ')}`,
      );
    } catch (err) {
      log.warn(`写入编辑器设置失败：${String(err)}`);
    }
  }

  /**
   * Diagnostics for the workbench patch.
   *
   * The "how many windows have it?" question is answered by the media server the
   * patched pages report to. Only one window owns the media port, so this asks
   * that one over HTTP instead of trusting our own counters.
   */
  async function workbenchStatus(): Promise<void> {
    const st = installer.status();
    const port = vscode.workspace.getConfiguration('weWallpaper').get<number>('mediaPort', 39127);
    let live: { patchedWindows?: number; activeStreams?: number } | null = null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`);
      if (res.ok) live = (await res.json()) as { patchedWindows?: number; activeStreams?: number };
    } catch {
      live = null;
    }
    const ownsPort = media.origin === `http://127.0.0.1:${port}`;
    const lines = [
      `补丁：${st.patched ? '已注入 ✅' : '未注入'}`,
      `校验和：${st.checksumMismatch ? '⚠ 不一致（可能被 VS Code 更新覆盖，请重新启用）' : '一致（不会弹“安装已损坏”）'}`,
      `媒体端口 ${port}：${live ? (ownsPort ? '本窗口持有' : '由其它窗口持有') : '⚠ 无人监听'}`,
      `已加载补丁的窗口数：${live?.patchedWindows ?? 0}（最近 5 分钟内上报）`,
      `正在播放的流：${live?.activeStreams ?? 0}`,
      '',
      st.patched
        ? '每个已打开的窗口都需要各按一次 Ctrl+R（或完全退出 VS Code 再打开）才会加载补丁；新开的窗口自动生效。'
        : '用「启用壁纸背景」注入补丁。',
    ];
    log.info(lines.join('\n'));
    if (st.supported && st.htmlPath) log.info(`目标：${st.htmlPath}`);
    await vscode.window.showInformationMessage(lines.join('\n'), { modal: true }, '好');
  }

  // ── rotation (upstream's 自动轮播; playlists are a later step) ─────────────
  const restartRotation = (): void => {
    if (rotation) {
      clearInterval(rotation);
      rotation = undefined;
    }
    const seconds = vscode.workspace.getConfiguration('weWallpaper').get<number>('autoRotateSeconds', 0);
    if (seconds > 0) {
      rotation = setInterval(() => void nextWallpaper(), seconds * 1000);
      log.info(`自动轮播已启用：每 ${seconds}s`);
    }
  };

  // ── status bar ────────────────────────────────────────────────────────────
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  status.command = 'weWallpaper.open';
  status.text = '$(file-media) Wallpaper Engine';
  status.tooltip = '点击打开壁纸视图';
  context.subscriptions.push(status);
  status.show();

  /**
   * The window this code runs in loaded the injected css/js BEFORE this activation, so
   * after an update it keeps running the previous build until it reloads. That is the
   * single most confusing failure mode of this extension ("I changed it and nothing
   * happened"), and a modal prompt is easy to miss — so it also gets a status-bar item
   * that is impossible to overlook and reloads the window when clicked.
   */
  const markAssetsStale = (): void => {
    status.command = 'workbench.action.reloadWindow';
    status.text = '$(warning) 壁纸资源待重载';
    status.tooltip = '这个窗口仍在运行上一版注入脚本/样式（装新版后必然如此）。点击立即重载窗口。';
    status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    log.info('状态栏提示：壁纸资源待重载（点击重载窗口）');
  };

  // ── commands ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('weWallpaper.open', () => openPanel()),
    vscode.commands.registerCommand('weWallpaper.pickWallpaper', () => pickWallpaper()),
    vscode.commands.registerCommand('weWallpaper.nextWallpaper', () => nextWallpaper()),
    vscode.commands.registerCommand('weWallpaper.rescan', () => rescan()),
    vscode.commands.registerCommand('weWallpaper.enableWorkbenchBackground', () => setSetting('workbenchBackground', true)),
    vscode.commands.registerCommand('weWallpaper.disableWorkbenchBackground', () => setSetting('workbenchBackground', false)),
    vscode.commands.registerCommand('weWallpaper.workbenchStatus', () => workbenchStatus()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('weWallpaper')) return;
      if (e.affectsConfiguration('weWallpaper.logLevel')) log.setLevel(readLevel());
      if (e.affectsConfiguration('weWallpaper.autoRotateSeconds')) restartRotation();
      if (e.affectsConfiguration('weWallpaper.workbenchOpacity') || e.affectsConfiguration('weWallpaper.workbenchScrim')) {
        // Sliders go straight to the patched pages on their next poll: no
        // workbench.html rewrite, no reload prompt.
        pushWorkbenchView();
      }
      // Everything below is a switch in the settings UI doing real work, so the
      // guard matters: our own corrective writes must not loop back in.
      if (suppressSettingSync) return;
      if (e.affectsConfiguration('weWallpaper.workbenchBackground')) {
        void applyWorkbenchSetting(
          vscode.workspace.getConfiguration('weWallpaper').get<boolean>('workbenchBackground', false),
          true,
        );
      }
      if (e.affectsConfiguration('weWallpaper.transparentTitleBar')) {
        const on = vscode.workspace.getConfiguration('weWallpaper').get<boolean>('transparentTitleBar', false);
        void setTransparentTitleBar(on).then((windowKeysChanged) =>
          // window.controlsStyle only lands on a freshly created window, so that
          // half of the toggle cannot be picked up by a reload.
          windowKeysChanged
            ? promptWindowRestart(on)
            : promptReload(`透明标题栏已${on ? '启用' : '关闭'}，重载窗口后生效。`),
        );
      }
      if (e.affectsConfiguration('weWallpaper.wallpaperId')) {
        const id = vscode.workspace.getConfiguration('weWallpaper').get<string>('wallpaperId', '');
        if (id && id !== selectedId) {
          void ensureInventory().then(() => {
            const item = service.find(id);
            if (item) return showSelected(item);
            void vscode.window.showWarningMessage(`没有找到 id 为「${id}」的壁纸。`);
            return undefined;
          });
        }
      }
      // Which surface renders live, and whether it renders live at all: both decide
      // what the panel does AND what /current carries, so re-apply the selection.
      if (
        e.affectsConfiguration('weWallpaper.liveSurface') ||
        e.affectsConfiguration('weWallpaper.workbenchLiveScene')
      ) {
        void ensureInventory().then(() => {
          const item = service.find(selectedId) ?? service.playableItems()[0];
          if (item) return showSelected(item);
          return undefined;
        });
      }
      WallpaperPanel.instance?.pushSettings();
    }),
    vscode.window.onDidChangeWindowState((state) => {
      if (!vscode.workspace.getConfiguration('weWallpaper').get<boolean>('pauseWhenHidden', true)) return;
      WallpaperPanel.instance?.post({ type: 'focus', focused: state.focused });
    }),
  );

  restartRotation();

  // ── startup: converge the switches with reality ────────────────────────────
  const boot = installer.status();
  const cfg = vscode.workspace.getConfiguration('weWallpaper');

  // Selection: the settings page is authoritative when it names a wallpaper.
  const configuredId = cfg.get<string>('wallpaperId', '');
  if (configuredId) selectedId = configuredId;

  // Title bar: reflect what is actually set, without writing the core setting
  // ourselves unless the switch asks for it.
  const titleBarIsCustom = isCustomTitleBar(vscode.workspace.getConfiguration('window').get<string>('titleBarStyle'));
  const toggleWantsTitleBar = cfg.get<boolean>('transparentTitleBar', false);
  if (titleBarIsCustom !== toggleWantsTitleBar) {
    await setSetting('transparentTitleBar', titleBarIsCustom, true);
    log.info(`透明标题栏开关已同步为 ${titleBarIsCustom}（跟随 window.titleBarStyle）`);
  }
  if (titleBarIsCustom || toggleWantsTitleBar) {
    // Converge the rest of the recipe as well (idempotent — each write only happens
    // when the value differs):
    //   * window.controlsStyle = "custom" → the three buttons become DOM nodes,
    //     which is the only way CSS can make them transparent (see titlebar.ts);
    //   * the two titleBar.*Background colours → the --vscode-titleBar-* variables
    //     the DOM title bar and buttons read.
    // If the controls style had to be written just now, THIS window cannot show the
    // effect — it was created with the native overlay still in place — so say so
    // instead of leaving the user staring at the same black rectangle.
    void setTransparentTitleBar(true).then((windowKeysChanged) => {
      if (windowKeysChanged) void promptWindowRestart(true);
    });
  }

  // Workbench background: the switch decides. One-time adoption first, so an
  // installation patched before these switches existed is not torn down.
  const switchesInitialised = context.globalState.get<boolean>(SWITCHES_INIT_KEY, false);
  const wantWorkbench = cfg.get<boolean>('workbenchBackground', false);
  if (boot.supported && !switchesInitialised) {
    await context.globalState.update(SWITCHES_INIT_KEY, true);
    if (boot.patched && !wantWorkbench) {
      await setSetting('workbenchBackground', true, true);
      log.info('已把现有补丁的状态收养到开关 weWallpaper.workbenchBackground=true');
    }
    if (!cfg.get<string>('wallpaperId', '') && selectedId) {
      await setSetting('wallpaperId', selectedId, true);
    }
  }
  if (boot.supported) {
    if (wantWorkbench && !boot.patched) {
      void ensureMedia()
        .then(() => applyWorkbenchSetting(true, false))
        .catch((err) => log.warn(`启用工作台背景失败：${String(err)}`));
    } else if (!wantWorkbench && boot.patched) {
      void applyWorkbenchSetting(false, false).catch((err) => log.warn(`还原工作台背景失败：${String(err)}`));
    } else if (wantWorkbench && boot.patched) {
      // The window already loaded workbench.html and began requesting the media
      // URL, so bind the port first thing and re-inject the current wallpaper.
      void ensureMedia()
        .then(() => refreshWorkbenchPatch(false))
        .catch((err) => log.warn(`刷新工作台背景失败：${String(err)}`));
      // Multi-window: only one window can own the port baked into the patch. If we
      // fell back to a random port, keep trying to take over, so closing the owning
      // window does not kill the wallpaper in the others.
      const takeover = setInterval(() => {
        void media.claimPreferredPort().then((claimed) => {
          if (claimed) {
            clearInterval(takeover);
            void refreshWorkbenchPatch(false);
          }
        });
      }, 5000);
      context.subscriptions.push({ dispose: () => clearInterval(takeover) });
    }
  }
  if (boot.supported && !boot.patched && boot.checksumMismatch) {
    log.warn('workbench.html 与 product.json 的校验和不一致（可能刚被 VS Code 更新覆盖，或被其它工具改过）');
  }

  log.info(`Wallpaper Engine 已激活（appRoot=${vscode.env.appRoot}，patched=${boot.patched}）`);
}

export function deactivate(): void {
  // Nothing to do: every disposable (including the media server) rides the
  // extension context's subscriptions.
}
