/**
 * Transparent title bar — the settings half of it.
 *
 * Three keys are involved, and only the middle one decides whether the three
 * buttons CAN be transparent:
 *
 *  1. `window.titleBarStyle = 'custom'` — while it is `native` (the default) the
 *     whole top frame, INCLUDING the menu bar, is drawn by Windows and no
 *     stylesheet can reach it. `custom` makes VS Code render it as DOM
 *     (`.part.titlebar` / `.menubar`), which the injected stylesheet can then make
 *     transparent.
 *
 *  2. `window.controlsStyle = 'custom'` — decides **who draws minimize / maximize
 *     / close**. Left at its default `native` they are an Electron window-controls
 *     overlay (`setTitleBarOverlay`) that lives outside the DOM, and VS Code keeps
 *     its colour OPAQUE before handing it over. VS Code 1.115.0, titlebarPart:
 *
 *         updateStyles() {
 *           const color = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_BACKGROUND
 *                                                       : TITLE_BAR_ACTIVE_BACKGROUND,
 *                                       (c, theme) => c.isOpaque() ? c : c.makeOpaque(defaultBackground(theme)));
 *           this.element.style.backgroundColor = color;
 *           ...
 *           nativeHostService.updateWindowControls({ backgroundColor: this.element.style.backgroundColor, ... });
 *         }
 *
 *     and `makeOpaque(ref)` returns the *reference* colour when the alpha is 0
 *     (`r = ref.r - a * (ref.r - r)`, so `a = 0` ⇒ exactly `ref`, alpha forced to 1).
 *     The reference is a constant per theme kind — `#252526` for dark themes — so
 *     `titleBar.activeBackground: "#00000000"` reaches Electron as **opaque
 *     #252526**: a solid near-black rectangle painted over the wallpaper. No
 *     stylesheet can influence that: `!important` changes what is painted, not the
 *     inline-style string the JS reads, and the overlay is not a DOM node at all.
 *
 *     With `controlsStyle: 'custom'` VS Code drops the overlay completely (main
 *     process `windowControlsOverlayEnabled()` ⇒ false ⇒ no `titleBarOverlay` on
 *     the BrowserWindow) and creates the three buttons as DOM instead —
 *     `.window-controls-container > .window-icon.window-minimize|window-max-restore|window-close`
 *     — which CSS *can* style. That is the lever this extension pulls.
 *
 *     Caveat: the main process reads this key when it CREATES the window, so it
 *     only takes effect after every window is closed and reopened (Ctrl+R reloads
 *     the page but keeps the old native overlay, which would then sit on top of the
 *     new DOM buttons).
 *
 *  3. `workbench.colorCustomizations["titleBar.*Background"]` — the supporting
 *     lever. The DOM title bar and the DOM buttons consume the CSS variables
 *     generated from these keys, so they are still written (merged, stashed, and
 *     restored exactly) — but on their own they can NOT make the native buttons
 *     transparent, which is what the merge below used to be credited with.
 */

export const TITLEBAR_COLORS: Record<string, string> = {
  'titleBar.activeBackground': '#00000000',
  'titleBar.inactiveBackground': '#00000000',
};

/**
 * Editor overlays VS Code paints from a colour it reads in JS.
 *
 * `editor.lineHighlightBackground` / `editor.lineHighlightBorder` are NOT CSS
 * variables in this VS Code: `workbench.desktop.main.js` reads them with
 * `theme.getColor()` and injects a dynamic rule for
 * `.monaco-editor.focused .view-overlays .current-line` (plus a
 * `border: 2px solid` on the `-exact` variants, dark default `#282828`). Overriding
 * `--vscode-editor-lineHighlight*` therefore paints nothing — which is why the black
 * band on the cursor's line survived every stylesheet attempt.
 *
 * `getColor()` resolves through the theme's custom-colour map, so
 * `workbench.colorCustomizations` is the only lever that changes the value the JS
 * interpolates. Mid-grey at low alpha so one value works on light and dark themes;
 * the border colour is transparent because a 2px dark outline reads as a black bar.
 *
 * The injected stylesheet carries the same fix as an element rule with !important,
 * so this is belt and braces: either layer alone is enough.
 */
export const EDITOR_OVERLAY_COLORS: Record<string, string> = {
  'editor.lineHighlightBackground': '#80808014',
  'editor.inactiveLineHighlightBackground': '#8080800a',
  'editor.lineHighlightBorder': '#00000000',
};

/** `window.titleBarStyle` value that puts the top frame in the DOM. */
export const TITLEBAR_STYLE_DOM = 'custom';
/** `window.titleBarStyle` value Windows draws itself. */
export const TITLEBAR_STYLE_NATIVE = 'native';
/** `window.controlsStyle` value that makes the three buttons DOM nodes. */
export const CONTROLS_STYLE_DOM = 'custom';
/** `window.controlsStyle` registry default (native overlay). */
export const CONTROLS_STYLE_NATIVE = 'native';

/**
 * VS Code registers `window.controlsStyle` with `included: !isMacintosh`, so on
 * macOS there is no such key to write (the traffic lights are DOM already).
 */
export function supportsControlsStyle(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin';
}

export interface WindowStyleState {
  titleBarStyle?: string;
  controlsStyle?: string;
}

export interface WindowStyleWrite {
  key: 'titleBarStyle' | 'controlsStyle';
  /** Target value; `undefined` removes the key (back to the registry default). */
  value: string | undefined;
}

/**
 * The `window.*` writes the transparent-title-bar toggle needs, as a pure function
 * so the "don't clobber what we did not set" rules stay testable.
 *
 * Only keys whose current value is NOT already the target are returned, so applying
 * the plan twice writes nothing the second time. On the way out we only touch
 * `controlsStyle` if it still holds the value we put there; the user's own stashed
 * value wins, and when there was none the key is removed rather than left at a
 * value we invented.
 */
export function planWindowStyles(
  on: boolean,
  current: WindowStyleState,
  stash: { controlsStyle?: string } = {},
  platform: NodeJS.Platform = process.platform,
): WindowStyleWrite[] {
  const writes: WindowStyleWrite[] = [];

  if (on) {
    if (current.titleBarStyle !== TITLEBAR_STYLE_DOM) {
      writes.push({ key: 'titleBarStyle', value: TITLEBAR_STYLE_DOM });
    }
    if (supportsControlsStyle(platform) && current.controlsStyle !== CONTROLS_STYLE_DOM) {
      writes.push({ key: 'controlsStyle', value: CONTROLS_STYLE_DOM });
    }
    return writes;
  }

  if (current.titleBarStyle === TITLEBAR_STYLE_DOM) {
    writes.push({ key: 'titleBarStyle', value: TITLEBAR_STYLE_NATIVE });
  }
  if (supportsControlsStyle(platform) && current.controlsStyle === CONTROLS_STYLE_DOM) {
    writes.push({ key: 'controlsStyle', value: stash.controlsStyle });
  }
  return writes;
}

export interface MergeResult {
  /** Value to write to workbench.colorCustomizations (undefined = remove it). */
  next: Record<string, unknown> | undefined;
  /** Values to stash so a later disable can put the user's own colours back. */
  stash: Record<string, string>;
  changed: boolean;
}

/**
 * Merge (or unmerge) a set of our colours into `workbench.colorCustomizations`.
 *
 * @param current the user's existing workbench.colorCustomizations
 * @param colors  the keys we own, with the values we want
 * @param on      true = apply, false = revert
 * @param stash   values we displaced previously (from the caller's storage)
 */
export function mergeColors(
  current: Record<string, unknown> | undefined,
  colors: Record<string, string>,
  on: boolean,
  stash: Record<string, string> = {},
): MergeResult {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  const nextStash: Record<string, string> = { ...stash };
  let changed = false;

  for (const [key, value] of Object.entries(colors)) {
    if (on) {
      if (next[key] === value) continue;
      // Remember the user's own colour the first time we overwrite it.
      if (typeof next[key] === 'string' && !(key in nextStash)) nextStash[key] = next[key] as string;
      next[key] = value;
      changed = true;
    } else {
      // Only touch keys we own: if the value is not ours, the user has taken over.
      if (next[key] !== value) continue;
      if (key in nextStash) {
        next[key] = nextStash[key];
        delete nextStash[key];
      } else {
        delete next[key];
      }
      changed = true;
    }
  }

  return { next: Object.keys(next).length ? next : undefined, stash: nextStash, changed };
}

/** Merge (or unmerge) our transparent title-bar colours. */
export function mergeTitleBarColors(
  current: Record<string, unknown> | undefined,
  on: boolean,
  stash: Record<string, string> = {},
): MergeResult {
  return mergeColors(current, TITLEBAR_COLORS, on, stash);
}

/** Merge (or unmerge) the editor overlays VS Code paints from a JS-read colour. */
export function mergeEditorOverlayColors(
  current: Record<string, unknown> | undefined,
  on: boolean,
  stash: Record<string, string> = {},
): MergeResult {
  return mergeColors(current, EDITOR_OVERLAY_COLORS, on, stash);
}

/**
 * Editor settings wallpaper mode has to change, because the feature cannot coexist
 * with a transparent editor.
 *
 * `editor.stickyScroll.enabled` pins the current scope's first lines **over** the
 * text scrolling underneath. It is an overlay by design, so there are only two
 * outcomes over a wallpaper:
 *   · translucent (the first attempt) → the pinned line and the line below it are
 *     both readable at the same place: the "code line residue" / duplicated glyphs;
 *   · opaque (the second attempt) → a solid bar covering the first lines of the
 *     editor, which is what "顶上还是有粘滞区" describes.
 * Neither is what a wallpaper user wants, and no CSS can produce a third option. So
 * wallpaper mode turns the feature off, and the previous value is stashed so turning
 * the wallpaper back off restores it (including "the user never set it").
 */
export const WALLPAPER_EDITOR_SETTINGS: Record<string, unknown> = {
  'editor.stickyScroll.enabled': false,
};

/** Same stash discipline as mergeColors, for non-colour settings. */
export function mergeSettings(
  current: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
  on: boolean,
  stash: Record<string, unknown> = {},
): { next: Record<string, unknown>; stash: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...(current ?? {}) };
  const nextStash: Record<string, unknown> = { ...stash };
  let changed = false;

  for (const [key, value] of Object.entries(values)) {
    if (on) {
      if (next[key] === value) continue;
      // Remember the user's own value the first time we overwrite it. `undefined` is
      // a real value here: it means "the user never set this", and restoring it must
      // delete our override rather than write `false` back as if it were theirs.
      if (!(key in nextStash)) nextStash[key] = next[key];
      next[key] = value;
      changed = true;
    } else {
      if (next[key] !== value) continue;   // the user has taken over; leave it alone
      if (key in nextStash) {
        const original = nextStash[key];
        if (original === undefined) delete next[key];
        else next[key] = original;
        delete nextStash[key];
      } else {
        delete next[key];
      }
      changed = true;
    }
  }

  return { next, stash: nextStash, changed };
}

/** Whether the top frame is currently code-rendered rather than OS-rendered. */
export function isCustomTitleBar(titleBarStyle: unknown): boolean {
  return titleBarStyle === TITLEBAR_STYLE_DOM;
}

/** Whether the three buttons are DOM nodes (and therefore styleable) right now. */
export function hasDomWindowControls(controlsStyle: unknown, platform: NodeJS.Platform = process.platform): boolean {
  return supportsControlsStyle(platform) && controlsStyle === CONTROLS_STYLE_DOM;
}
