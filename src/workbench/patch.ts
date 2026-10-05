/**
 * Workbench patch — the 方案 B experiment, kept as pure string/JSON transforms.
 *
 * Nothing here touches the disk or the `vscode` module, so the whole patch can be
 * exercised against a *copy* of the real `workbench.html` + `product.json`
 * (`test/workbench-patch.test.mjs`), including the round-trip invariant
 * `stripPatch(injectPatch(x)) === x`.
 *
 * Why the checksum rewrite matters: this VS Code install's `product.json`
 * contains a SHA-256 (base64url, unpadded) checksum for
 * `vs/code/electron-browser/workbench/workbench.html`. Editing that file without
 * updating the checksum makes the integrity service show "安装似乎已损坏。请重新安装。"
 * — which is exactly why vscode-background ships CSS to hide that toast in 15
 * languages. `product.json` is not covered by its own checksum table, so writing
 * the new hash back keeps the integrity check green and no toast ever appears.
 */

import { createHash } from 'node:crypto';

export const MARKER_START = '<!-- WE-WORKBENCH-WALLPAPER:START (managed by we-for-vscode; do not edit) -->';
export const MARKER_END = '<!-- WE-WORKBENCH-WALLPAPER:END -->';
/**
 * The pre-patch CSP text travels *inside* the marker block, not next to the meta
 * tag: the block is removed as an exact byte range, so keeping the payload there
 * is what makes `stripPatch(injectPatch(x)) === x` hold instead of losing a
 * newline to a whitespace heuristic.
 */
const CSP_PAYLOAD_PREFIX = '<!-- WE-CSP-ORIGINAL:';
const CSP_PAYLOAD_RE = /<!-- WE-CSP-ORIGINAL:([A-Za-z0-9+/=]+) -->/;
const CSP_META_RE = /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([\s\S]*?)("\s*\/?>)/i;

/**
 * Files we drop next to workbench.html (new files, not covered by checksums).
 *
 * Only BOOT_FILE is referenced by the patched HTML, WITHOUT a version query: that is
 * what keeps workbench.html byte-stable across extension updates, and a stable
 * workbench.html is the whole reason the "installation appears to be corrupt" toast
 * cannot come back. It is the frozen loader; everything that may change ships as
 * CORE_FILE / CSS_FILE, which the loader pulls in at runtime with the content hash it
 * reads from ASSETS_FILE.
 */
export const CSS_FILE = 'we-workbench-wallpaper.css';
/**
 * The frozen loader, loaded by workbench.html. Its bytes are part of the contract:
 * if it ever has to change, the FILE NAME must be bumped (a cached copy of a
 * version-less URL would otherwise keep running forever) and the digest pinned in
 * the tests updated. That is exactly what happened when the loader learned to
 * re-check the asset version 1.5 s after boot.
 */
export const BOOT_FILE = 'we-workbench-boot.js';
/** Loader names from earlier versions: written by nobody, cleaned up by everybody. */
export const LEGACY_FILES: readonly string[] = ['we-workbench-wallpaper.js'];
/** The real logic, version-busted at runtime by the loader. */
export const CORE_FILE = 'we-workbench-core.js';
/** `{"version":"…"}` — the loader's runtime cache-busting version. */
export const ASSETS_FILE = 'we-workbench-assets.json';
/**
 * The Web-wallpaper stub page, framed by the injected script for a live Web
 * wallpaper (see buildWebStubHtml).
 *
 * Why a SECOND document: a Web wallpaper is an author HTML app, and the engine
 * mounts it as a **sandboxed `blob:` iframe**. The patched workbench's CSP is
 * `frame-src 'self' vscode-webview:` with no `blob:`, and widening it would mean
 * rewriting the checksummed `workbench.html` — the one file this whole design keeps
 * byte-frozen. A same-origin page dropped next to `workbench.html` *is* allowed by
 * `frame-src 'self'`, and a document loaded from a real URL does not inherit the
 * parent's policy — so the stub can import the engine from the loopback and let it
 * build the author iframe. Nothing outside the stub needs a wider CSP.
 */
export const WEB_STUB_FILE = 'we-workbench-web.html';
/**
 * The stub's logic, as an **external file next to it**.
 *
 * This is not a style choice: an inline `<script>` in the stub is refused, which is how
 * the first version failed in the live workbench ("the frame loads, nothing happens").
 * Chromium hands a frame the parent's policy container, and a page fetched through
 * Electron's privileged `vscode-file` scheme does not escape that — so the stub runs
 * under the workbench policy after all, where `script-src 'self' 'unsafe-eval' blob:`
 * allows no inline script. A same-origin `src` does run, and everything the stub needs
 * afterwards (loopback `fetch`, blob-URL module import, the engine's own sandboxed
 * frame) is expressible inside that policy. See buildWebStubJs.
 */
export const WEB_STUB_JS_FILE = 'we-workbench-web.js';

export interface WorkbenchPatchSettings {
  /** Origin of the extension's media server, reported to the page at runtime. */
  origin: string;
}

/**
 * Content hash of the generated css + core js: the cache-busting version the page
 * appends to `we-workbench-wallpaper.css` / `we-workbench-core.js`.
 *
 * It deliberately does NOT appear in workbench.html. Those two files are served by
 * VS Code's own protocol handler, which we cannot set Cache-Control on, so a stale
 * copy would otherwise survive reloads — but putting the hash in the URL of the
 * *HTML* meant every extension update rewrote a checksummed file, and rewriting
 * workbench.html while VS Code runs is exactly what raises the integrity toast
 * (the main process compares it against the checksum table it read at startup).
 * The loader asks /current for this value instead, so the HTML never moves.
 */
export function assetVersionFor(origin: string): string {
  // The stub files are part of the version on purpose: the stub is fetched through the
  // parent's iframe URL with this value appended, so an update that changes the stub
  // also changes the URL the page asks for (see buildJs).
  return checksum(`${buildCss()}\n${buildJs(origin)}\n${buildWebStubHtml()}\n${buildWebStubJs()}`).slice(0, 12);
}

/**
 * SHA-256 as VS Code stores it in `product.json.checksums`: **standard base64,
 * padding stripped** (43 chars).
 *
 * Not base64url. This cost a real debugging round: the pristine workbench.html
 * hash happens to contain neither `+` nor `/`, where the two encodings coincide —
 * so an earlier "the checksum matches the vendor value" check passed by luck,
 * and afterwards it compared our own value against itself. Worse, writing a
 * base64url digest made the integrity service report "installation appears to be
 * corrupt", because it computes standard base64. The live-installation test now
 * verifies all ten entries against the vendor's own table, which is what pins
 * this encoding down.
 */
export function checksum(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('base64').replace(/=+$/, '');
}

/** The `product.json` checksums key for a workbench html path. */
export function checksumKeyFor(htmlPath: string, appRoot: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, '/');
  const rel = norm(htmlPath).replace(norm(appRoot).replace(/\/+$/, '') + '/out/', '');
  return rel === norm(htmlPath) ? null : rel;
}

export function isPatched(html: string): boolean {
  return html.includes(MARKER_START) && html.includes(MARKER_END);
}

/**
 * Widen the workbench CSP by exactly the loopback origin.
 *
 * The video is served over `http://127.0.0.1:<port>`: the workbench renderer is
 * sandboxed and `vscode-file://vscode-app` is fenced to the app root, so pointing
 * the <video> at a wallpaper outside the install is not an option. Only the three
 * directives a media element needs are touched; script/style keep their original
 * sources (our own files are same-origin `./` references).
 */
export function widenCsp(csp: string): string {
  const origin = 'http://127.0.0.1:*';
  let out = csp;
  const add = (directive: string): void => {
    const re = new RegExp(`(${directive}\\s)([^;]*)(;)`, 'i');
    if (!re.test(out)) return;
    out = out.replace(re, (_m, head: string, body: string, tail: string) =>
      body.includes('127.0.0.1') ? `${head}${body}${tail}` : `${head}${body.trimEnd()} ${origin}${tail}`,
    );
  };
  add('media-src');
  add('img-src');
  add('connect-src');
  return out;
}

/**
 * The HTML block appended before `</body>`.
 *
 * Deliberately STATIC, and now for a stronger reason than before: it carries **no
 * version query and no settings**, so its bytes are a pure function of the schema
 * below. Everything that can change — the stylesheet, the logic, the media URL —
 * is either fetched at runtime or referenced through a URL the loader builds.
 *
 * Why that matters: the version query used to live here, so every extension update
 * (new css/js content → new hash) rewrote this file. workbench.html is
 * checksummed, and VS Code's integrity service compares it against the checksum
 * table its **main process read at startup** — so any rewrite during a session
 * raises "安装似乎已损坏。请重新安装。" until VS Code is fully restarted, no matter
 * how correctly we sync `product.json` on disk. Keeping these bytes frozen removes
 * that failure mode entirely.
 */
export function buildBlock(originalCsp?: string): string {
  const lines = [MARKER_START];
  if (originalCsp) lines.push(`${CSP_PAYLOAD_PREFIX}${Buffer.from(originalCsp, 'utf8').toString('base64')} -->`);
  lines.push(
    '<div id="we-workbench-wallpaper" aria-hidden="true">',
    '<video id="we-workbench-video" muted loop autoplay playsinline></video>',
    '<div class="we-wb-scrim"></div>',
    '</div>',
    // No `?v=`: the loader resolves both files' cache-busting version from /current
    // at runtime (see buildBootJs). workbench.js is a deferred module, so injecting
    // the stylesheet a few ms later is still long before the UI paints — the page
    // never shows an unstyled flash.
    `<script src="./${BOOT_FILE}"></script>`,
    MARKER_END,
  );
  return lines.join('\n');
}

/**
 * Insert the patch. Idempotent: re-patching replaces the previous block, so the
 * extension can refresh the media URL on every activation.
 *
 * Both edits are exact inverses of their `stripPatch` counterparts: the CSP is a
 * pure content substitution, and the block is inserted as `block + '\n'`.
 */
export function injectPatch(html: string): string {
  let out = stripPatch(html);
  const cspMeta = CSP_META_RE.exec(out);
  if (!cspMeta) throw new Error('workbench.html 里找不到 Content-Security-Policy meta');
  const originalCsp = cspMeta[2];
  out = out.replace(cspMeta[0], `${cspMeta[1]}${widenCsp(originalCsp)}${cspMeta[3]}`);

  const closeIdx = out.lastIndexOf('</body>');
  if (closeIdx < 0) throw new Error('workbench.html 里找不到 </body>');
  return out.slice(0, closeIdx) + buildBlock(originalCsp) + '\n' + out.slice(closeIdx);
}

/** Remove the patch, restoring the original CSP text exactly. */
export function stripPatch(html: string): string {
  const start = html.indexOf(MARKER_START);
  const endMarker = html.indexOf(MARKER_END);
  if (start < 0 || endMarker <= start) return html;

  const blockEnd = endMarker + MARKER_END.length;
  const payload = CSP_PAYLOAD_RE.exec(html.slice(start, blockEnd));
  // The block was inserted as `BLOCK + '\n'` — take that newline back with it.
  const withNewline = html[blockEnd] === '\n' ? blockEnd + 1 : blockEnd;
  let out = html.slice(0, start) + html.slice(withNewline);

  if (payload) {
    const originalCsp = Buffer.from(payload[1], 'base64').toString('utf8');
    const cspMeta = CSP_META_RE.exec(out);
    if (cspMeta) out = out.replace(cspMeta[0], `${cspMeta[1]}${originalCsp}${cspMeta[3]}`);
  }
  return out;
}

/**
 * The stylesheet dropped next to workbench.html. Constant: user settings arrive at
 * runtime through /current, so this file — and therefore the version in
 * `we-workbench-assets.json` — only changes when the code does.
 */
export function buildCss(): string {
  // Every declaration here is `!important` on purpose: the theme service injects
  // its own --vscode-* values at runtime, after this file is parsed.
  //
  // Everything is scoped to `html:not(.we-wb-fallback)` so the injected script can
  // switch the whole effect off when the wallpaper cannot be loaded (extension not
  // running in this window, wallpaper deleted, …). Without that escape hatch a
  // patched installation would show a black void with a see-through UI.
  const transparentVars = [
    'editor-background',
    'editorGroupHeader-tabsBackground',
    'editorGroupHeader-noTabsBackground',
    'tab-activeBackground',
    'tab-inactiveBackground',
    'tab-unfocusedActiveBackground',
    'tab-unfocusedInactiveBackground',
    'breadcrumb-background',
    'sideBar-background',
    'activityBar-background',
    'statusBar-background',
    'statusBar-noFolderBackground',
    'titleBar-activeBackground',
    'titleBar-inactiveBackground',
    'titleBar-border',
    'menubar-selectionBackground',
    'panel-background',
    'panelSectionHeader-background',
    'terminal-background',
    'editorWidget-background',
    'editorHoverWidget-background',
    'editorSuggestWidget-background',
    'quickInput-background',
    'menu-background',
    'dropdown-background',
    'input-background',
    'list-activeSelectionBackground',
    'list-inactiveSelectionBackground',
    'list-hoverBackground',
    'list-filterWidgetBackground',
    'notifications-background',
    'notificationCenterHeader-background',
    'peekViewResult-background',
    'peekViewEditor-background',
    'minimap-background',
    'editorGutter-background',
    'editorPane-background',
    // Found by auditing workbench.desktop.main.css for the chrome bands that were
    // still painting a fill (title bar centre widget, selected tab, section headers,
    // chat panel, banner). Everything here is a *surface*; hover/selection feedback
    // is deliberately left alone so the UI stays usable.
    'commandCenter-background',
    'commandCenter-activeBackground',
    'commandCenter-border',
    'tab-selectedBackground',
    'sideBarSectionHeader-background',
    'sideBarStickyScroll-background',
    'notificationCenter-background',
    'banner-background',
    'welcomePage-background',
    'chat-editorBackground',
    'chat-requestBubbleBackground',
    'chat-requestBubbleHoverBackground',
    'chat-slashCommandBackground',
    'chat-checkpointSeparator',
    'editorGroupHeader-border',
  ];
  const varRules = transparentVars.map((v) => `\t--vscode-${v}: transparent !important;`).join('\n');
  /**
   * Overlays that must stay VISIBLE, just not opaque.
   *
   * The 2026-dark theme (and several others) uses solid colours for these —
   * `editor.hoverHighlightBackground: #242526` and the same for range/hover — which
   * paints a black bar over the wallpaper. A translucent tint keeps the cue and lets
   * the wallpaper through.
   *
   * NOTE which of these are actually CSS variables. `editor.hoverHighlightBackground`
   * and `editor.rangeHighlightBackground` are consumed straight from variables by
   * workbench.desktop.main.css, so overriding the variable works. The cursor line is
   * NOT: `editor.lineHighlightBackground` / `editor.lineHighlightBorder` appear zero
   * times in that stylesheet — VS Code reads them with `theme.getColor()` and injects
   * a dynamic rule for `.view-overlays .current-line`. Overriding those two variables
   * painted nothing at all, which is exactly why the black band survived. They are
   * replaced by the element rule further down (see "The cursor's line").
   */
  const tintVars: Array<[string, string]> = [
    ['editor-hoverHighlightBackground', 'var(--we-wb-line-tint)'],
    ['editor-rangeHighlightBackground', 'var(--we-wb-line-tint)'],
    // Sticky scroll pins the current scope's first lines at the top while you
    // scroll. It is an OVERLAY: it has to OCCLUDE the lines scrolling under it.
    // A near-transparent wash (the first attempt) let those lines show through, so
    // the pinned text sat on top of the text below it and read as duplicated /
    // leftover glyphs — that is the "code line residue" artifact. It gets a real
    // surface, a hairline to separate it, and no shadow (the shadow read as a dark
    // band underneath). The gutter strip needs the same treatment; its registry
    // default is editor.background, so leaving it alone paints an opaque band.
    ['editorStickyScroll-background', 'var(--we-wb-sticky)'],
    ['editorStickyScrollGutter-background', 'var(--we-wb-sticky)'],
    ['editorStickyScrollHover-background', 'var(--we-wb-sticky-strong)'],
    ['editorStickyScroll-border', 'var(--we-wb-sticky-border)'],
    ['editorStickyScroll-shadow', 'none'],
  ];
  const tintRules = tintVars.map(([v, value]) => `\t--vscode-${v}: ${value} !important;`).join('\n');
  const scope = 'html:not(.we-wb-fallback)';

  return `/*
 * Wallpaper behind the VS Code workbench — generated by the we-for-vscode
 * extension. Regenerated on every activation; safe to delete (the extension also
 * restores workbench.html when you run "禁用壁纸背景").
 *
 * If the wallpaper cannot load, the injected script adds .we-wb-fallback to <html>
 * and every rule below stops applying, so the UI goes back to normal instead of
 * showing a transparent shell over a black void.
 */
:root {
\t--we-wb-opacity: 1;
\t--we-wb-scrim: 0.35;
}

/* Line tint: white over a dark theme, black over a light one. Declared once and
   referenced by the --vscode-* overrides below, so the light override only has to
   change this single value.
 *
 * NOTE the selector list: the theme service declares its own --vscode-* values on
 * .monaco-workbench, and a declaration on a closer ancestor beats an inherited
 * one even when both are !important. Declaring the tints on <html> alone therefore
 * did nothing — the cursor's line kept the theme's solid #242526. They must be set
 * on .monaco-workbench as well, exactly like the transparent variables below. */
${scope},
${scope} .monaco-workbench {
\t--we-wb-line-tint: rgba(255, 255, 255, 0.07);
\t--we-wb-editor-wash: rgba(0, 0, 0, 0.12);
\t--we-wb-editor-wash-strong: rgba(0, 0, 0, 0.22);
\t/* Tone of the frosted chrome and of the editor's backdrop (see the glass rules
\t   below). Dark themes frost toward near-black, light themes toward near-white —
\t   the same two tones the glass panel uses, so the whole window reads as one
\t   material. Only the TONE is declared here: the alpha and the radius are set on
\t   <html> by the host's payload, and a declaration in this block would win over it
\t   (the rules below therefore carry the 0 defaults as var() fallbacks). */
\t--we-wb-glass-rgb: 16, 16, 20;
\t--we-wb-editor-rgb: 16, 16, 20;
\t/* Sticky scroll must OCCLUDE the lines scrolling under it. 0.72 was not enough:
\t   the wallpaper showed through and the pinned line's text still sat on top of the
\t   text below it, which is precisely the "residue/duplicated glyphs" artifact.
\t   It is the one surface that has to be (near) opaque; the tone tracks the glass
\t   default so it still reads as part of the wallpaper rather than a black bar. */
\t--we-wb-sticky: rgba(16, 16, 20, 0.94);
\t--we-wb-sticky-strong: rgba(16, 16, 20, 0.98);
\t--we-wb-sticky-border: rgba(255, 255, 255, 0.1);
${tintRules}
}

${scope} .monaco-workbench.vs,
${scope} .monaco-workbench.vs-light,
${scope} .monaco-workbench.hc-light {
\t--we-wb-line-tint: rgba(0, 0, 0, 0.055);
\t--we-wb-editor-wash: rgba(255, 255, 255, 0.12);
\t--we-wb-editor-wash-strong: rgba(255, 255, 255, 0.22);
\t--we-wb-glass-rgb: 250, 250, 250;
\t--we-wb-editor-rgb: 250, 250, 250;
\t--we-wb-sticky: rgba(250, 250, 250, 0.96);
\t--we-wb-sticky-strong: rgba(250, 250, 250, 0.99);
\t--we-wb-sticky-border: rgba(0, 0, 0, 0.12);
}

#we-workbench-wallpaper {
\tposition: fixed;
\tinset: 0;
\tz-index: -1;          /* behind the workbench, above the (now transparent) body */
\tpointer-events: none;
\toverflow: hidden;
\tbackground: transparent;
\t/* No filter here on purpose. A blurred wallpaper layer softens the code area too —
\t   the editor surface is translucent, so whatever it sits on shows through it. The
\t   blur belongs to the GLASS surfaces (chrome, panel), which is where the frosted
\t   look comes from; the code area stays crisp and gets its readability from the
\t   scrim plus its own surface alpha (see the glass rules below). */
}

html.we-wb-fallback #we-workbench-wallpaper {
\tdisplay: none;
}

/* The video plays media files; the <img> is created by the injected script for
   stills (Scene previews, poster-only wallpapers) because a <video> renders an
   image as nothing at all. Same box, same opacity variable. */
#we-workbench-wallpaper > video,
#we-workbench-wallpaper > img {
\twidth: 100%;
\theight: 100%;
\tobject-fit: cover;
\topacity: var(--we-wb-opacity, 1);
\tbackground: transparent;
}

#we-workbench-wallpaper > img {
\tdisplay: none;
}

/* Live Scene layer (opt-in). Same box as the other layers; the engine appends its
   own canvas, so only the container needs styling. */
#we-workbench-scene {
\tposition: absolute;
\tinset: 0;
\tdisplay: none;
}

#we-workbench-scene > canvas {
\twidth: 100%;
\theight: 100%;
\tdisplay: block;
\tobject-fit: cover;
}

/* Live Web layer (opt-in). A Web wallpaper is an author HTML app: the engine's
   mount puts it in a sandboxed blob: iframe, and a blob: frame is exactly what this
   document's CSP refuses (frame-src 'self' vscode-webview:). workbench.html is
   checksummed and frozen, so instead of widening its CSP the engine runs inside the
   stub page dropped next to it (we-workbench-web.html, 'self' — allowed) and the
   result is framed here. Same box as the other layers.

   display is toggled inline by setMode() — never left to the stylesheet, because an
   empty inline value falls back to none and the layer would never appear. */
#we-workbench-web {
\tposition: absolute;
\tinset: 0;
\twidth: 100%;
\theight: 100%;
\tborder: 0;
\tdisplay: none;
\tbackground: transparent;
}

#we-workbench-wallpaper > .we-wb-scrim {
\tposition: absolute;
\tinset: 0;
\t/* The live layers are APPENDED to the container, so they come after the scrim in
\t   document order and would paint over it (the still <img> is not positioned, which
\t   is why only the canvas and the web frame were affected). An explicit stacking
\t   level puts the scrim back on top of every wallpaper layer, so the dimming slider
\t   applies to a live Scene and a live Web wallpaper too. */
\tz-index: 1;
\t/* Colour is a variable because a light theme needs a white wash, not a dark
\t   scrim: see wbContrast in the script. */
\tbackground: rgb(var(--we-wb-scrim-rgb, 0, 0, 0));
\topacity: var(--we-wb-scrim, 0.35);
}

/* The root element keeps a flat colour — deliberately, and it is the *only* thing
   that gets one.
 *
 * The compositor fills the root background without needing a raster, so it is what
 * shows through whenever a layer is dropped or a region is not repainted. With it
 * transparent, those pixels exposed VS Code's own window plate, which is opaque
 * (the BrowserWindow is created with the theme background colour, not transparent)
 * — that is the "black band / leftover" family of artifacts. The injected script
 * samples the decoded video and writes its dominant tone to --we-wb-underlay, so a
 * dropped frame degrades to the wallpaper's own colour instead of black. It starts
 * out transparent (i.e. today's behaviour) and is set only once a frame has been
 * sampled. This does NOT hide the wallpaper layer: the root background is the canvas
 * background, painted below every element. */
${scope} {
\tbackground-color: var(--we-wb-underlay, transparent) !important;
}

${scope} body {
\tbackground: transparent !important;
}

/* Make the workbench surfaces see-through. Both the element itself and
   .monaco-workbench are targeted because the theme service picks one or the other
   depending on version. */
${scope},
${scope} .monaco-workbench {
${varRules}
}

${scope} .monaco-workbench,
${scope} .monaco-workbench .part,
${scope} .monaco-workbench .part > .content,
${scope} .monaco-workbench .part > .title,
${scope} .monaco-workbench .split-view-view,
${scope} .monaco-workbench .editor-group-container,
${scope} .monaco-workbench .editor-container,
${scope} .monaco-workbench .monaco-editor,
${scope} .monaco-workbench .monaco-editor .margin,
${scope} .monaco-workbench .monaco-editor-background,
${scope} .monaco-workbench .monaco-editor .overflow-guard,
${scope} .monaco-workbench .scrollbar .slider {
\tbackground: transparent !important;
}

/* The tab strip and title bar need explicit structural rules, not just variable
   overrides: with window.titleBarStyle set to "custom" the frame is DOM-painted
   (.part.titlebar / .menubar), and the editor group title paints its own strip.
   (With the default NATIVE title bar the top frame is drawn by the OS and no CSS
   can reach it — set window.titleBarStyle to "custom" for a see-through top bar.) */
${scope} .monaco-workbench .part.titlebar,
${scope} .monaco-workbench .part.titlebar > .titlebar-container,
${scope} .monaco-workbench .part.titlebar .titlebar-left,
${scope} .monaco-workbench .part.titlebar .titlebar-center,
${scope} .monaco-workbench .part.titlebar .titlebar-right,
${scope} .monaco-workbench .part.titlebar .command-center,
${scope} .monaco-workbench .part.titlebar .actions-container,
${scope} .monaco-workbench .part.titlebar .monaco-action-bar,
${scope} .monaco-workbench .window-controls-container,
${scope} .monaco-workbench .menubar,
${scope} .monaco-workbench .part.editor > .content .editor-group-container > .title,
${scope} .monaco-workbench .part.editor > .content .editor-group-container > .title .tabs,
${scope} .monaco-workbench .part.editor > .content .editor-group-container > .title .tab,
${scope} .monaco-workbench .part.editor .tabs,
${scope} .monaco-workbench .part.editor .tab {
\tbackground: transparent !important;
}

/* The three window buttons — minimize / maximize-restore / close.
 *
 * These rules only bite when window.controlsStyle is "custom": that is what makes
 * VS Code draw them as DOM nodes inside .window-controls-container. Left at the
 * default "native" they are an Electron window-controls overlay
 * (setTitleBarOverlay) painted OUTSIDE the DOM, and VS Code forces its colour opaque
 * on the way there — titlebarPart.updateStyles() runs the theme colour through
 * isOpaque() ? c : c.makeOpaque(#252526) (see src/titlebar.ts), so
 * titleBar.activeBackground: "#00000000" reaches Electron as a solid #252526.
 * Nothing in a stylesheet can change either the string JS reads or that layer, which
 * is why the settings toggle — not this file — is what removes the black rectangle.
 *
 * With the DOM buttons the rest state is ours to set. VS Code's own rules already
 * leave them unpainted and add only a hover wash, but our !important rules would
 * win against that hover, so the feedback is re-stated here with the same values as
 * workbench.desktop.main.css (#ffffff1a on dark, #0000001a on light, #e81123e6 for
 * close). */
${scope} .monaco-workbench .window-controls-container > .window-icon {
\tbackground-color: transparent !important;
}
/* The buttons now sit directly on the wallpaper, so the glyphs get a faint halo:
   over a 4K video wallpaper the theme's titleBar.activeForeground is otherwise easy
   to lose. Dark themes only — on a light theme a dark shadow behind dark glyphs
   only muddies them. */
${scope} .monaco-workbench.vs .window-controls-container > .window-icon,
${scope} .monaco-workbench.vs-dark .window-controls-container > .window-icon,
${scope} .monaco-workbench.hc-black .window-controls-container > .window-icon {
\ttext-shadow: 0 0 4px rgba(0, 0, 0, 0.45);
}
${scope} .monaco-workbench .window-controls-container > .window-icon:hover {
\tbackground-color: rgba(255, 255, 255, 0.1) !important;
}
${scope} .monaco-workbench .part.titlebar.light .window-controls-container > .window-icon:hover,
${scope} .monaco-workbench.vs .window-controls-container > .window-icon:hover,
${scope} .monaco-workbench.vs-light .window-controls-container > .window-icon:hover,
${scope} .monaco-workbench.hc-light .window-controls-container > .window-icon:hover {
\tbackground-color: rgba(0, 0, 0, 0.1) !important;
}
${scope} .monaco-workbench .window-controls-container > .window-icon.window-close:hover {
\tbackground-color: rgba(232, 17, 35, 0.9) !important;
\tcolor: #fff !important;
}

/* The editor's opaque block. vscode-background needed this exact chain to remove
   it, so it is spelled out rather than approximated. */
${scope} .monaco-workbench .part.editor .editor-container .overflow-guard > .monaco-scrollable-element {
\tbackground: transparent !important;
}

/* ── frosted chrome ─────────────────────────────────────────────────────────
 *
 * The sidebar, activity bar, title bar, status bar and the panel get a frosted
 * backdrop instead of raw wallpaper behind their text: a translucent theme-toned
 * layer plus a real Gaussian blur of whatever is behind it (backdrop-filter blurs
 * everything painted below the element in the same stacking context, which is the
 * wallpaper layer at z-index -1).
 *
 * The alpha is the host's chromeGlassAlpha, raised to the theme's readability floor
 * before it is pushed, and 0 means "off" — in which case these rules paint nothing
 * at all and the window is exactly the fully transparent one it was before.
 *
 * Cost note: a blur over an ANIMATED wallpaper is recomputed every frame for the
 * area it covers. That is why the radius is shared with the panel's glass slider
 * (default 16px) rather than something larger, and why 0 is a supported value.
 *
 * Why a ::before and not the part itself: backdrop-filter (like filter) creates a
 * STACKING CONTEXT, and the chrome parts host popups — the menubar's dropdowns, hover
 * widgets, the panel's menus. Trapped in the part's context, a popup's own z-index stops
 * mattering and later-painted siblings (the sidebar, the editor surface) cover it: the
 * File menu rendered under the wallpaper with no background at all. A pseudo-element
 * keeps the frosted look (it blurs what is behind the part, exactly as before) while
 * leaving the part itself free of any stacking context.
 */
${scope} .monaco-workbench .part.activitybar::before,
${scope} .monaco-workbench .part.sidebar::before,
${scope} .monaco-workbench .part.auxiliarybar::before,
${scope} .monaco-workbench .part.titlebar::before,
${scope} .monaco-workbench .part.statusbar::before,
${scope} .monaco-workbench .part.panel::before {
\tcontent: '';
\tposition: absolute;
\tinset: 0;
\tz-index: -1;
\tpointer-events: none;
\tbackground-color: rgba(var(--we-wb-glass-rgb), var(--we-wb-glass-alpha, 0));
\tbackdrop-filter: blur(var(--we-wb-glass-blur, 0px)) saturate(var(--we-wb-glass-saturate, 1.25));
\t-webkit-backdrop-filter: blur(var(--we-wb-glass-blur, 0px)) saturate(var(--we-wb-glass-saturate, 1.25));
}

/* The code surface: translucent, but NEVER blurred.
 *
 * Glyphs need a stable backdrop, not the wallpaper's pixels between them, and the
 * answer here is opacity alone — the auto-contrast solver raises this value until the
 * text reaches WCAG 4.5:1 (see wbEditorAlpha). A backdrop blur would also do it, but
 * it smears the area the user reads: the wallpaper behind the editor is supposed to
 * look like a picture, not like frosted glass. The blur lives on the chrome rule
 * above, where the frosted look is the point. */
${scope} .monaco-workbench .part.editor > .content {
\tbackground-color: rgba(var(--we-wb-editor-rgb), var(--we-wb-editor-alpha, 0)) !important;
}

/* Editors keep a faint wash so long sessions stay readable over a busy
   wallpaper; the scrim slider above is the coarse control. The sticky-scroll band
   reuses the same wash so its pinned lines read as part of the editor instead of
   floating over the wallpaper like leftovers. */
${scope} .monaco-workbench .monaco-editor-background {
\tbackground: var(--we-wb-editor-wash) !important;
}

/* The cursor's line.
 *
 * NOT a CSS variable in this VS Code: editor.lineHighlightBackground is read in
 * JS (theme.getColor) and injected as a dynamic rule on
 * .view-overlays .current-line / .margin-view-overlays .current-line-margin,
 * and editor.lineHighlightBorder (dark default #282828!) becomes a
 * border: 2px solid on the .current-line-exact* variants. Overriding
 * --vscode-editor-lineHighlightBackground therefore painted nothing at all — the
 * "black band on the cursor line" was VS Code's own injected rule. Both the fill
 * and the 2px border have to be beaten on the element, with !important (the
 * focused rule is .monaco-editor.focused .view-overlays .current-line, the same
 * specificity as the selector below, and it is injected after this file). */
${scope} .monaco-workbench .monaco-editor .view-overlays .current-line,
${scope} .monaco-workbench .monaco-editor .view-overlays .current-line-exact,
${scope} .monaco-workbench .monaco-editor .margin-view-overlays .current-line-margin,
${scope} .monaco-workbench .monaco-editor .margin-view-overlays .current-line-exact-margin {
\tbackground-color: var(--we-wb-line-tint, rgba(255, 255, 255, 0.07)) !important;
\tborder: none !important;
}

/* Compositing policy, learned the hard way (and identical to what upstream
 * dsh-wallpaper-engine ended up shipping): an always-on transform / will-change on
 * the full-screen video makes it own a compositing layer for the whole session,
 * which is a known driver of stale frames and flash artifacts. The layer is
 * promoted for exactly two frames instead, and only when the window becomes visible
 * again — see nudge() in the injected script. */
#we-workbench-wallpaper.we-wb-nudge {
\twill-change: transform;
\ttransform: translateZ(0);
}
`;
}

/**
 * The FROZEN loader, shipped as `we-workbench-wallpaper.js`.
 *
 * Its bytes are part of the contract with workbench.html, which may reference this
 * file and only ever without a version query (see buildBlock). Everything that can
 * change — the stylesheet text, the logic, the media origin baked into the core —
 * is loaded from here at runtime, so extension updates never touch the checksummed
 * HTML again. A hash of this function's output is pinned in the tests: if the loader
 * ever has to change, that test fails on purpose and the file name must be bumped
 * (which rewrites workbench.html exactly once, by design).
 *
 * Trusted Types note: the workbench CSP has `require-trusted-types-for 'script'`,
 * so the stylesheet is injected as a `<style>` element's textContent (not a <link>,
 * not a string handed to eval) and the logic is pulled in with a dynamic `import()`
 * — neither is a Trusted Types sink. The `<video src>` it ends up driving is set by
 * the core through setAttribute, which is what already works today.
 */
export function buildBootJs(): string {
  return `/* Generated by the we-for-vscode extension. FROZEN — see buildBootJs(). */
(function () {
  'use strict';
  var ASSETS = './we-workbench-assets.json';
  var CSS_FILE = './we-workbench-wallpaper.css';
  var CORE_FILE = './we-workbench-core.js';
  var MAX_TRIES = 30;
  // The page loads BEFORE the extension host rewrites these assets on activation, so
  // the very first read can still describe the previous build — which is how an
  // update would appear to do nothing until the next reload. One re-check shortly
  // after boot closes that window; it costs nothing when the version is stable.
  var RECHECK_MS = 1500;
  var tries = 0;
  var applied = null;

  function readAssets() {
    // The JSON itself cannot be cache-busted by URL (vscode-file:// serves it
    // without Cache-Control), so the nonce does that job.
    return fetch(ASSETS + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('assets ' + r.status); return r.json(); });
  }

  function apply(version) {
    if (version === applied) return;
    applied = version;
    var q = version ? '?v=' + encodeURIComponent(version) : '';
    // Stylesheet first: it is what makes the workbench transparent. Fetching the text
    // and assigning it to a <style> avoids both the protocol cache and the page's
    // require-trusted-types-for 'script' policy (a <link>/script src assignment is a
    // Trusted Types sink; textContent is not). Waiting for a local round trip here is
    // invisible because workbench.js is a deferred module — the UI paints long after.
    fetch(CSS_FILE + q, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('css ' + r.status); return r.text(); })
      .then(function (css) {
        var el = document.getElementById('we-wb-style');
        if (!el) {
          el = document.createElement('style');
          el.id = 'we-wb-style';
          document.head.appendChild(el);
        }
        el.textContent = css;
      })
      ['catch'](function () { /* cosmetic: without it the UI just stays opaque */ });
    // Dynamic import (not a Trusted Types sink, allowed by script-src 'self'). A
    // second import after an update is harmless: the injected script binds itself to
    // the video element once (dataset.weBound) and ignores later calls.
    import(CORE_FILE + q)['catch'](function () { schedule(); });
  }

  function run() {
    readAssets()
      .then(function (cfg) {
        var version = cfg && cfg.version;
        var first = applied === null;
        apply(version);
        if (first) window.setTimeout(recheck, RECHECK_MS);
      })
      ['catch'](function () { schedule(); });
  }

  function recheck() {
    readAssets()
      .then(function (cfg) { apply(cfg && cfg.version); })
      ['catch'](function () { /* the host may be restarting; the current assets stand */ });
  }

  function schedule() {
    if (tries >= MAX_TRIES) return;   // give up: the UI simply stays normal
    tries += 1;
    window.setTimeout(run, Math.min(400 * tries, 5000));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
`;
}

/**
 * The script dropped next to workbench.html, served as `we-workbench-core.js` and
 * imported by the frozen loader with a content-hash query.
 *
 * `origin` is baked in on purpose: the file is version-addressed at runtime, so a
 * change of port changes this file's hash, which changes the URL the loader asks
 * for — the staleness that used to require rewriting workbench.html.
 *
 * Three jobs only:
 *  1. retry the media load — on startup the window loads this HTML *before* the
 *     extension host has bound its port, so the first request can be refused;
 *  2. switch the whole effect off (`.we-wb-fallback`) when the media never
 *     arrives, so a patched install degrades to the normal UI;
 *  3. release the decoder while the window is hidden.
 * Deliberately dependency-free and idempotent.
 */
export function buildJs(origin: string): string {
  return `/* Generated by the we-for-vscode extension. */
(function () {
  'use strict';
  var ORIGIN = ${JSON.stringify(origin)};
  var MAX_TRIES = 20;
  var BASE_DELAY = 500;
  var POLL_MS = 15000;
  var FALLBACK_CLASS = 'we-wb-fallback';
  // Video wallpapers often fade in from black, so the first frame is a bad sample.
  var UNDERLAY_DELAY_MS = 6000;
  var DOC_ID = (window.crypto && window.crypto.randomUUID)
    ? window.crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  var failures = 0;
  var probeSent = false;
  var underlaySampled = false;
  /** Element currently showing the wallpaper (video or still). */
  var active = null;
  /** Open /events stream, so view pushes do not have to wait for a poll. */
  var viewStream = null;
  /** Last /current payload, replayed when the active element changes. */
  var lastPayload = null;
  /** Still URL currently in the <img>, so a scene's poster is set only once. */
  var lastStill = null;
  /** Bookkeeping for the readability floor (see wbContrast). */
  var contrastKey = null;
  var contrastStats = null;
  var contrastTimer = 0;
  /** Preview URL already tried as a fallback source, so it is not retried forever. */
  var contrastStillTried = null;
  /** The user's own dimming value, kept apart from the measured floor. */
  var userScrim = null;
  /** The user's own code-surface opacity; the measurement may raise it. */
  var userEditorAlpha = null;

  /* WB-CONTRAST:START — the same math as media/contrast.mjs, which the panel
     imports. It cannot be imported here: this document's CSP allows scripts from
     'self' only, and the workbench page is a vscode-file:// document that must not
     fetch a script from the loopback origin. test/contrast.test.mjs extracts this
     block and pins it to the module's answers, so the two cannot drift. */
  function wbLuma(r, g, b) { return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }

  function wbStats(data, width, height) {
    var lumas = [], sum = 0, bright = 0, dark = 0, edges = 0, edgeSamples = 0, i, x, y;
    if (!data || !data.length) return null;
    function at(px, py) {
      var j = (py * width + px) * 4;
      return wbLuma(data[j], data[j + 1], data[j + 2]);
    }
    for (y = 0; y < height; y += 1) {
      for (x = 0; x < width; x += 1) {
        i = (y * width + x) * 4;
        if (data[i + 3] !== undefined && data[i + 3] < 200) continue;
        var v = wbLuma(data[i], data[i + 1], data[i + 2]);
        lumas.push(v); sum += v;
        if (v > 0.6) bright += 1;
        if (v < 0.25) dark += 1;
        if (x + 1 < width) { edgeSamples += 1; if (Math.abs(v - at(x + 1, y)) > 0.25) edges += 1; }
        if (y + 1 < height) { edgeSamples += 1; if (Math.abs(v - at(x, y + 1)) > 0.25) edges += 1; }
      }
    }
    if (!lumas.length) return null;
    lumas.sort(function (a, b) { return a - b; });
    function pick(q) { return lumas[Math.min(lumas.length - 1, Math.max(0, Math.round(q * (lumas.length - 1))))]; }
    function r3(n) { return Math.round(n * 1000) / 1000; }
    return {
      samples: lumas.length,
      mean: r3(sum / lumas.length),
      p05: r3(pick(0.05)), p50: r3(pick(0.5)), p95: r3(pick(0.95)),
      bright: r3(bright / lumas.length), dark: r3(dark / lumas.length),
      busy: edgeSamples ? r3(edges / edgeSamples) : 0
    };
  }

  var WB_TARGET = { dark: { balanced: 0.26, strong: 0.16 }, light: { balanced: 0.58, strong: 0.7 } };
  var WB_CAP = { balanced: 0.75, strong: 0.88 };
  var WB_BLUR = { balanced: 7, strong: 13 };
  var WB_BUSY = { balanced: 0.34, strong: 0.24 };
  /** WCAG targets for the code text: AA, and AAA-ish for the strong mode. */
  var WB_RATIO = { balanced: 4.5, strong: 7 };

  function wbContrastRatio(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Luminance the code backdrop has to stay under (dark theme) / over (light). */
  function wbTextBackdropBound(fg, target) {
    return fg > 0.5 ? (fg + 0.05) / target - 0.05 : target * (fg + 0.05) - 0.05;
  }

  /** The wallpaper's luma after the dimming (or the wash) is composited over it. */
  function wbDimmedLuma(stats, scrim, themeKind) {
    var s = Math.min(1, Math.max(0, Number(scrim) || 0));
    if (themeKind === 'light') return stats.p05 * (1 - s) + s;
    return stats.p95 * (1 - s);
  }

  /**
   * How opaque the code surface has to be — solved, not guessed:
   * bg(a) = a*surface + (1-a)*wallpaper, inverted for the readable bound. 0 when the
   * dimming alone is enough, which is the common case for a dark wallpaper.
   */
  function wbEditorAlpha(wallpaperLuma, surfaceLuma, fgLuma, target) {
    var bound = wbTextBackdropBound(fgLuma, target);
    var dark = fgLuma > 0.5;
    if (dark ? wallpaperLuma <= bound : wallpaperLuma >= bound) return 0;
    if (dark ? wallpaperLuma <= surfaceLuma : wallpaperLuma >= surfaceLuma) return 0;
    var needed = dark
      ? (wallpaperLuma - bound) / (wallpaperLuma - surfaceLuma)
      : (bound - wallpaperLuma) / (surfaceLuma - wallpaperLuma);
    return Math.min(0.95, Math.max(0, Math.round(needed * 100) / 100));
  }

  function wbThemeKind() {
    var cls = (document.body && document.body.className) || '';
    return /vscode-(light|high-contrast-light)/.test(cls) ? 'light' : 'dark';
  }

  function wbContrast(stats, themeKind, mode) {
    if (mode !== 'balanced' && mode !== 'strong') return { scrim: 0, fill: '0,0,0', blur: 0 };
    if (!stats || !stats.samples) return { scrim: 0, fill: '0,0,0', blur: 0 };
    var dark = themeKind !== 'light';
    var target = WB_TARGET[dark ? 'dark' : 'light'][mode];
    var worst = dark ? stats.p95 : stats.p05;
    var needed = dark
      ? 1 - target / Math.max(worst, 0.04)
      : 1 - (1 - target) / Math.max(1 - worst, 0.04);
    var scrim = Math.min(WB_CAP[mode], Math.max(0, needed));
    var blur = stats.busy >= WB_BUSY[mode] ? WB_BLUR[mode] : 0;
    return { scrim: Math.round(scrim * 100) / 100, fill: dark ? '0,0,0' : '255,255,255', blur: blur };
  }
  /* WB-CONTRAST:END */

  /**
   * Measure what is actually on screen and raise the dimming to what the text needs.
   *
   * The wallpaper is an arbitrary photograph behind every glyph in the window, so
   * this is the only place that can answer "is the UI readable right now?". The
   * user's slider stays a floor of its own: the effective value is the max of the
   * two, so a slider can always dim more and never less (weWallpaper.autoContrast
   * turns the whole mechanism off).
   */
  function sampleContrast(source, el) {
    var size = 64;
    window.clearTimeout(contrastTimer);
    contrastTimer = window.setTimeout(function () {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx || !source) return;
        var w = source.videoWidth || source.naturalWidth || source.width;
        var h = source.videoHeight || source.naturalHeight || source.height;
        if (!w || !h) { contrastKey = null; return; }
        ctx.drawImage(source, 0, 0, size, size);
        var stats = wbStats(ctx.getImageData(0, 0, size, size).data, size, size);
        if (!stats) { contrastKey = null; return; }
        contrastStats = stats;
        // applyView() re-solves the editor opacity from these stats and reports the
        // resulting numbers, so there is no separate report call here.
        applyView(lastPayload || {}, el);
      } catch (e) {
        // The live layer may be unreadable (an engine canvas whose textures came from
        // another origin without CORS) or may not have painted yet. Fall back to the
        // wallpaper's own preview — the same picture the library shows — and only give
        // up (leaving the user's slider in charge) if that is unreadable too.
        sampleStillContrast(el);
      }
    }, 2500);
  }

  /** Measure the preview image instead of the live layer (see sampleContrast). */
  function sampleStillContrast(el) {
    var url = lastPayload && lastPayload.still;
    if (!url || contrastStillTried === url) { contrastKey = null; return; }
    contrastStillTried = url;
    var image = new Image();
    try { image.crossOrigin = 'anonymous'; } catch (e) { /* older engines */ }
    image.onload = function () { sampleContrast(image, el); };
    image.onerror = function () { contrastKey = null; };
    image.src = url;
  }

  function contrastMode() {
    var m = lastPayload && lastPayload.contrast;
    return (m === 'off' || m === 'strong' || m === 'balanced') ? m : 'balanced';
  }

  /** Luma of a CSS colour string (hex or rgb()/rgba()), or null when unreadable. */
  function wbColorLuma(value) {
    var s = String(value || '').trim();
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (m) {
      var hex = m[1].length === 3 ? m[1].split('').map(function (c) { return c + c; }).join('') : m[1];
      return wbLuma(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(s);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(function (x) { return x !== ''; });
      if (p.length >= 3) return wbLuma(parseFloat(p[0]), parseFloat(p[1]), parseFloat(p[2]));
    }
    return null;
  }

  /** Read a VS Code theme variable off the workbench root. */
  function wbThemeVar(name) {
    try {
      var root = document.querySelector('.monaco-workbench');
      return root ? getComputedStyle(root).getPropertyValue(name) : '';
    } catch (e) { return ''; }
  }

  function wbEditorSurfaceLuma() {
    var v = wbColorLuma(wbThemeVar('--vscode-editor-background'));
    return v === null ? 0.1 : v;
  }

  function wbEditorTextLuma() {
    return wbColorLuma(wbThemeVar('--vscode-editor-foreground'));
  }

  /** The opacity the code surface needs for the current wallpaper and dimming. */
  function solveEditorAlpha() {
    if (!contrastStats) return 0;
    var mode = contrastMode();
    if (mode === 'off') return 0;
    var fg = wbEditorTextLuma();
    if (fg === null) return 0;
    var floor = wbContrast(contrastStats, wbThemeKind(), mode);
    var scrim = Math.max(userScrim === null ? 0 : userScrim, floor.scrim);
    var wp = wbDimmedLuma(contrastStats, scrim, wbThemeKind());
    return wbEditorAlpha(wp, wbEditorSurfaceLuma(), fg, WB_RATIO[mode]);
  }

  /**
   * What the code text's contrast actually ends up as.
   *
   * The compositor owns the glyphs, so the renderer cannot sample its own output —
   * but it can do the arithmetic: the editor surface alpha blends the theme tone over
   * the (already dimmed) wallpaper, and the theme hands us the text colour. Reported
   * to /probe, because "is the code readable?" is otherwise a question only a
   * screenshot can answer, and screenshots cannot be taken on a locked session.
   */
  function wbTextContrast(stats, floor, scrim) {
    var editorAlpha = Math.max(userEditorAlpha === null ? 0 : userEditorAlpha, solveEditorAlpha());
    var wpLuma = wbDimmedLuma(stats, scrim, wbThemeKind());
    var surface = wbEditorSurfaceLuma();
    var bg = editorAlpha * surface + (1 - editorAlpha) * wpLuma;
    var fg = wbEditorTextLuma();
    if (fg === null) return null;
    return { fg: fg, bg: bg, alpha: editorAlpha, ratio: wbContrastRatio(fg, bg) };
  }

  function setFallback(on) {
    document.documentElement.classList.toggle(FALLBACK_CLASS, !!on);
  }

  // Promote the wallpaper layer for exactly two frames, then let it go.
  //
  // Measured lesson (upstream dsh-wallpaper-engine shipped the same change): an
  // always-on transform/will-change keeps the full-screen video on its own
  // compositing layer for the whole session, which is a known driver of stale
  // frames and flash artifacts — it does not prevent them. A short promotion right
  // after the window becomes visible (the case where the compositor holds a stale
  // layer) is what actually helps. Mirrors VS Code's own fix shape for stale
  // terminal rendering on visibilitychange (microsoft/vscode#328542).
  function nudge() {
    var layer = document.getElementById('we-workbench-wallpaper');
    if (!layer || !layer.classList) return;
    layer.classList.add('we-wb-nudge');
    var drop = function () {
      try { layer.classList.remove('we-wb-nudge'); } catch (e) { /* ignore */ }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { requestAnimationFrame(drop); });
    } else {
      window.setTimeout(drop, 32);
    }
  }

  // Give the root element a wallpaper-representative colour, so that whenever the
  // compositor drops a layer or skips a region, what shows through is the
  // wallpaper's own tone instead of VS Code's opaque window plate (which reads as a
  // black band). 64x64 is plenty for "which colour dominates"; the 6 s delay exists
  // because video wallpapers often fade in from black, so the first frame would
  // sample black.
  function sampleUnderlay(el) {
    var size = 64;
    var delay = UNDERLAY_DELAY_MS;
    window.setTimeout(function () {
      try {
        var canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        // Works for both elements: <video> exposes videoWidth, <img> naturalWidth.
        if (!ctx || !(el.videoWidth || el.naturalWidth)) return;
        ctx.drawImage(el, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var buckets = {};
        var best = null;
        for (var i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 200) continue;
          // 5 bits per channel: enough to group a gradient, fine enough to stay
          // close to the actual tone.
          var key = (data[i] >> 3) + ',' + (data[i + 1] >> 3) + ',' + (data[i + 2] >> 3);
          var b = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, bl: 0 });
          b.n += 1; b.r += data[i]; b.g += data[i + 1]; b.bl += data[i + 2];
          if (!best || b.n > best.n) best = b;
        }
        if (!best) return;
        var rgb = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.bl / best.n)];
        // "Darker" is not the point: the tone only has to be close to the picture.
        document.documentElement.style.setProperty('--we-wb-underlay', 'rgb(' + rgb.join(',') + ')');
      } catch (e) { /* tainted canvas or no frame yet: keep the transparent default */ }
    }, delay);
  }

  // ── the still-image layer ─────────────────────────────────────────────────
  //
  // The frozen HTML block only ships a <video>, and a video element can only play
  // media files: a Scene wallpaper's preview (JPEG/PNG/GIF) renders nothing in it.
  // So the still gets its own <img>, created here (the HTML must never change) and
  // styled by the versioned css.
  function layerRoot() {
    return document.getElementById('we-workbench-wallpaper');
  }

  function imageEl() {
    var img = document.getElementById('we-workbench-image');
    if (!img) {
      var root = layerRoot();
      if (!root) return null;
      img = document.createElement('img');
      img.id = 'we-workbench-image';
      img.alt = '';
      img.decoding = 'async';
      img.addEventListener('load', function () {
        failures = 0;
        setFallback(false);
        beacon();
        if (!underlaySampled) { underlaySampled = true; sampleUnderlay(img); }
        active = img;
        applyView(lastPayload || {}, img);
      });
      img.addEventListener('error', function () { schedule(null, 0); });
      root.appendChild(img);
    }
    return img;
  }

  // ── the live Scene layer (opt-in) ─────────────────────────────────────────
  //
  // A Scene wallpaper behind the whole UI needs the engine IN this document. The
  // workbench CSP allows script-src 'self' 'unsafe-eval' blob: — importing from the
  // loopback origin is not allowed, and widening the CSP would mean rewriting the
  // checksummed workbench.html (the one thing this patch exists to avoid). blob: is
  // allowed, so the engine is fetched as text and imported from a blob URL. It is a
  // single self-contained ESM file, so nothing has to resolve relative to it.
  var sceneState = { key: null, instance: null, host: null };

  // Lifecycle report from either live layer into the host's /probe. This runs inside
  // the workbench document (Trusted Types + workbench CSP), where a swallowed failure
  // reads as "the wallpaper just doesn't work" — the report is the only trace visible
  // from outside the renderer. The scene slot is shared by design: only one live layer
  // exists at a time, and the style probe lives in its own key (see reportStyles).
  function reportLayer(stage, key, extra) {
    try {
      var tt = 'absent';
      try { tt = (typeof trustedTypes !== 'undefined') ? ('present,default=' + (trustedTypes.defaultPolicy ? 'yes' : 'no')) : 'absent'; } catch (e2) {}
      var body = JSON.stringify({ scene: { stage: stage, key: key, err: extra ? String(extra) : null, tt: tt } });
      fetch(ORIGIN + '/probe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body })['catch'](function () {});
    } catch (e) { /* diagnostics must never break playback */ }
  }

  /**
   * The readability measurement, in its own /probe slot: the scene report is rewritten
   * on every poll (already-mounted) and would swallow this line, and this is the number
   * that answers "is the code readable?" without a screenshot.
   *
   * Called both after a fresh pixel sample AND whenever a slider/mode changes: the
   * pixels do not need re-reading for that, but the NUMBER the user reads does have to
   * follow the settings, otherwise /probe describes a configuration that is no longer
   * in force.
   */
  function reportMeasurement() {
    if (!contrastStats) return;
    var floor = wbContrast(contrastStats, wbThemeKind(), contrastMode());
    var scrim = Math.max(userScrim === null ? 0 : userScrim, floor.scrim);
    var text = wbTextContrast(contrastStats, floor, scrim);
    reportContrast(contrastKey, 'p95=' + contrastStats.p95 + ' busy=' + contrastStats.busy + ' scrim=' + scrim
      + ' chromeAlpha=' + (typeof (lastPayload && lastPayload.chromeGlassAlpha) === 'number' ? lastPayload.chromeGlassAlpha : '?')
      + ' editorAlpha=' + (text ? text.alpha : '?')
      + (text ? ' 代码文字对比度=' + text.ratio.toFixed(2) + ':1（bg=' + text.bg.toFixed(3) + ' fg=' + text.fg.toFixed(3) + '）' : ''));
  }

  function reportContrast(key, extra) {
    try {
      var tt = 'absent';
      try { tt = (typeof trustedTypes !== 'undefined') ? ('present,default=' + (trustedTypes.defaultPolicy ? 'yes' : 'no')) : 'absent'; } catch (e2) {}
      var body = JSON.stringify({ contrast: { stage: 'measured', key: key, err: extra ? String(extra) : null, tt: tt } });
      fetch(ORIGIN + '/probe', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: body })['catch'](function () {});
    } catch (e) { /* diagnostics must never break playback */ }
  }

  function sceneHost() {    var host = document.getElementById('we-workbench-scene');
    if (!host) {
      var root = layerRoot();
      if (!root) return null;
      host = document.createElement('div');
      host.id = 'we-workbench-scene';
      root.appendChild(host);
    }
    return host;
  }

  function detachScene() {
    if (sceneState.instance) {
      try { sceneState.instance.pause(); } catch (e) { /* already gone */ }
      sceneState.instance = null;
    }
    if (sceneState.host) {
      try { sceneState.host.replaceChildren(); } catch (e) { /* ignore */ }
      sceneState.host.style.visibility = 'hidden';
    }
    sceneState.key = null;
  }

  // ── the live Web layer (opt-in) ───────────────────────────────────────────
  //
  // A Web wallpaper is an author HTML app, and the engine mounts it as a SANDBOXED
  // blob: iframe. This document's CSP refuses blob: frames (frame-src 'self'
  // vscode-webview:) and the loopback origin as a script source, so the engine cannot
  // run here the way it does for a Scene. workbench.html is checksummed and its bytes
  // are frozen — widening its CSP is not an option either.
  //
  // The way out is a second document: we-workbench-web.html is dropped next to
  // workbench.html and framed HERE (same origin, so frame-src 'self' allows it).
  //
  // It is framed WITHOUT a sandbox attribute, which is a measured constraint, not a
  // preference: a sandboxed vscode-file frame never becomes a document (the load event
  // fires, nothing renders, no script runs). That leaves the stub same-origin with this
  // page, so the ISOLATION moved one level down — the stub re-sandboxes the engine's
  // author frame, which is where untrusted wallpaper code actually runs.
  var webState = { key: null, frame: null, report: '' };

  function detachWeb() {
    var f = document.getElementById('we-workbench-web');
    if (f) {
      // Removing the element is not enough: a running author page keeps its rAF loop
      // until its document is torn down. about:blank is allowed by frame-src 'self'.
      try { f.setAttribute('src', 'about:blank'); } catch (e) { /* ignore */ }
      try { f.remove(); } catch (e) { /* ignore */ }
    }
    webState.key = null;
    webState.frame = null;
    webState.report = '';
  }

  function webFrame() {
    var f = document.getElementById('we-workbench-web');
    if (f) return f;
    var root = layerRoot();
    if (!root) return null;
    f = document.createElement('iframe');
    f.id = 'we-workbench-web';
    // NO sandbox attribute. Measured in the live workbench: a sandboxed frame pointed
    // at a vscode-file sibling never becomes a document — the load event fires, but the
    // frame renders nothing and runs no script at all (verified with a red-background
    // probe page and with a postMessage handshake). Unsandboxed, the same file loads
    // and runs. The author page is isolated instead where it is created: the engine's
    // own frame is re-sandboxed by the stub (see buildWebStubJs).
    f.setAttribute('aria-hidden', 'true');
    root.appendChild(f);
    return f;
  }

  function mountWeb(payload) {
    var key = String(payload.url || '');
    if (webState.key === key && document.getElementById('we-workbench-web')) {
      // The stub is sandboxed (opaque origin), so this document cannot read its DOM —
      // the stub relays its own trail here by postMessage and we repeat it, or a stub
      // failure would be invisible from the outside.
      reportLayer('web-mounted', key, webState.report ? ('stub says ' + webState.report) : 'stub framed, no report yet');
      return;
    }
    var frame = webFrame();
    if (!frame) { reportLayer('web-no-host', key); return; }
    webState.key = key;
    webState.frame = frame;
    // Mode FIRST, so the frame has layout before it loads; the still stays underneath
    // (the stub document is transparent until the author page paints) and remains the
    // fallback when the web wallpaper never comes up.
    setMode('web');
    // The loader's cache-busting version rides on this module's own URL, so an update
    // can never reuse a stub left behind by the previous build.
    var version = '';
    try {
      var m = /[?&]v=([^&]+)/.exec(import.meta.url);
      version = m ? '&v=' + m[1] : '';
    } catch (e) { /* no import.meta: still fine, the nonce below busts the cache */ }
    var url = './${WEB_STUB_FILE}?o=' + encodeURIComponent(ORIGIN) + '&key=' + encodeURIComponent(key) + version + '&t=' + Date.now();
    frame.addEventListener('load', function () { reportLayer('web-stub-loaded', key); }, { once: true });
    frame.setAttribute('src', url);
    reportLayer('web-stub', key, url.slice(0, 160));
  }

  function mountScene(payload) {
    var key = String(payload.url || '');
    if (sceneState.key === key) {
      // Same payload as the running instance — still report geometry on the poll
      // cadence, so the host always has a fresh picture of the layer state.
      var hostNow = document.getElementById('we-workbench-scene');
      var canvasNow = hostNow ? hostNow.querySelector('canvas') : null;
      reportLayer('already-mounted', key, canvasNow ? (canvasNow.width + 'x' + canvasNow.height + ' css ' + canvasNow.clientWidth + 'x' + canvasNow.clientHeight) : 'no-canvas');
      return;
    }
    if (!payload.engine) { setMode('image'); return; }
    detachWeb();
    detachScene();
    sceneState.key = key;
    var host = sceneHost();
    if (!host) { reportLayer('no-host', key); return; }
    sceneState.host = host;
    // Show the still while the engine loads: the canvas is opaque, and an empty one is
    // a black rectangle over the wallpaper.
    setMode('image');
    // The engine measures the container AT MOUNT TIME — a container left at the
    // stylesheet's display:none measures 0x0 and the canvas stays invisible
    // forever (backing store allocated, css 0x0, nothing on screen). Take layout
    // space WITHOUT showing it: visibility:hidden keeps the canvas measurable
    // while the still keeps covering the screen; revealed on success below.
    host.style.display = 'block';
    host.style.visibility = 'hidden';
    fetch(payload.engine, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('engine http ' + r.status); return r.text(); })
      .then(function (code) {
        reportLayer('engine-fetched', key, code.length + 'B');
        var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
        return import(url).then(function (lib) { return { lib: lib, url: url }; });
      })
      .then(function (loaded) {
        reportLayer('engine-imported', key);
        var lib = loaded.lib;
        if (!lib || typeof lib.mount !== 'function' || typeof lib.httpSource !== 'function') {
          throw new Error('engine 缺少 mount/httpSource');
        }
        return lib.mount(host, {
          source: lib.httpSource(key),
          fit: 'cover',
          // Whole-window layer tuning. This surface lives behind a translucent UI, so
          // it does not need the panel's sharpness or frame rate:
          //   renderDpr  — sets the canvas backing store (measured: 0.5 gives a
          //                613x413 canvas for a 1226x826 CSS box, and "auto" gives the
          //                device ratio, 1839x1239 here). 1 means exactly one canvas
          //                pixel per CSS pixel: 2.25x fewer pixels than native-DPR
          //                rendering, and on a 150% display the 1.5x upscale is not
          //                visible behind the UI — while 0.5 measured as a 9x cut that
          //                is visibly soft for wallpapers with crisp detail (Web
          //                wallpapers with text/UI). It also picks the engine's texture
          //                bucket (>=1.5 -> 1.0, >=0.9 -> 0.8, else 0.6), so 1 lands on
          //                0.8 — slightly SHARPER textures than "auto" (0.75).
          //   fps 24     — the background is static chrome plus one animated surface;
          //                24 is indistinguishable there and saves a fifth of the work.
          //   particles  — 'medium' scales the emitter budget (engine: low .4 / med .7
          //                / high 1); heavy scenes spend real main-thread time here.
          renderDpr: 1,
          fps: 24,
          particles: 'medium',
          autoplay: true,
          volume: 0,
        });
      })
      .then(function (instance) {
        sceneState.instance = instance;
        setMode('scene');
        host.style.visibility = 'visible';
        // The canvas exists from here on: measure it for the readability floor (a
        // Scene's preview and its render can differ a lot in brightness).
        scheduleContrast('scene');
        failures = 0;
        setFallback(false);
        var c = host.querySelector('canvas');
        reportLayer('mounted', key, (c ? (c.width + 'x' + c.height + ' css ' + c.clientWidth + 'x' + c.clientHeight) : 'no-canvas') + '; tuned renderDpr=1 fps=24 particles=medium');
        // One captured frame ~5s in: if the canvas renders black in this environment
        // (GPU/compositing), the pixels say so when the error messages cannot.
        window.setTimeout(function () {
          try {
            var c2 = host.querySelector('canvas');
            if (!c2) { reportLayer('frame', key, 'no-canvas'); return; }
            reportLayer('frame', key, c2.toDataURL('image/jpeg', 0.75));
          } catch (e) { reportLayer('frame-failed', key, e && e.message ? e.message : e); }
        }, 5000);
        beacon();
      })
      ['catch'](function (err) {
        reportLayer('failed', key, err && err.message ? err.message : err);
        sceneState.key = null;
        setMode('image');
        host.style.visibility = 'hidden';
        try { console.warn('[we-wallpaper] 场景渲染失败，退回静图：' + (err && err.message ? err.message : err)); } catch (e) {}
      });
  }

  function setMode(mode) {
    // One visible layer at a time: the video keeps its element, the image is only
    // shown when the host says the target is a still. The display values must be
    // EXPLICIT ('block'), never '' — the stylesheet hides <img> and the scene host
    // with display:none, so an empty inline value falls back to the stylesheet
    // and the layer stays invisible forever (the canvas measured 0x0 css and the
    // whole-window wallpaper read as "black").
    //
    // The web frame is torn down whenever it is not the active layer: a running
    // author page keeps animating in a hidden iframe otherwise.
    if (mode !== 'web') detachWeb();
    var video = document.getElementById('we-workbench-video');
    var img = document.getElementById('we-workbench-image');
    var scene = document.getElementById('we-workbench-scene');
    var web = document.getElementById('we-workbench-web');
    if (video) {
      video.style.display = mode === 'video' ? 'block' : 'none';
      if (mode !== 'video') {
        try { video.pause(); } catch (e) { /* ignore */ }
      }
    }
    if (img) img.style.display = mode === 'image' ? 'block' : 'none';
    if (scene) scene.style.display = mode === 'scene' ? 'block' : 'none';
    if (web) web.style.display = mode === 'web' ? 'block' : 'none';
    scheduleContrast(mode);
  }

  /**
   * Sample the layer that is actually on screen, once per wallpaper.
   *
   * A live Scene is measured from its own canvas (same-origin, and the engine's
   * textures come from the loopback server with CORS, so reading it back works). A
   * live Web wallpaper cannot be read at all — the author page is sandboxed into an
   * opaque origin — so its PREVIEW stands in: it is the same picture the library
   * shows, and it is what the fallback would display anyway.
   */
  function scheduleContrast(mode) {
    var root = document.getElementById('we-workbench-wallpaper');
    var source = mode === 'scene' ? (root && root.querySelector('canvas'))
      : mode === 'video' ? document.getElementById('we-workbench-video')
        : document.getElementById('we-workbench-image');
    if (!source) return;
    var key = mode + ':' + (lastPayload && lastPayload.url ? lastPayload.url : '?');
    if (key === contrastKey && contrastStats) return; // same wallpaper, already measured
    contrastKey = key;
    contrastStats = null;
    contrastStillTried = null;
    sampleContrast(source, active);
  }

  // Write the view values straight onto the elements as well as the variables.
  // A z-index:-1 layer is not always repainted promptly when only an inherited
  // variable changes; one forced reflow per *change* (never per frame, and never
  // while a slider is being dragged) makes it immediate.
  /**
   * The panel's default colour (#101014) means "follow the theme tone", so a light
   * theme keeps its pale glass instead of getting a dark tone the picker cannot express
   * as "unset". Any other value overrides the tone for every glass surface.
   */
  function wbGlassRgb(color) {
    if (typeof color !== 'string') return null;
    var m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
    if (!m) return null;
    var hex = m[1];
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var rgb = [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)].join(',');
    return rgb === '16,16,20' ? null : rgb;
  }

  function applyView(payload, el) {
    var opacity = typeof payload.opacity === 'number' ? payload.opacity : null;
    var scrim = typeof payload.scrim === 'number' ? payload.scrim : null;
    var blur = typeof payload.blur === 'number' ? payload.blur : null;
    var chromeAlpha = typeof payload.chromeGlassAlpha === 'number' ? payload.chromeGlassAlpha : null;
    var editorAlpha = typeof payload.editorGlassAlpha === 'number' ? payload.editorGlassAlpha : null;
    var saturate = typeof payload.saturate === 'number' ? payload.saturate : null;
    var glassRgb = wbGlassRgb(payload.glassColor);
    if (opacity === null && scrim === null && blur === null && chromeAlpha === null && editorAlpha === null
      && saturate === null && !glassRgb && !contrastStats) return;
    var changed = false;
    try {
      if (opacity !== null) {
        if (el && el.style.opacity !== String(opacity)) { el.style.opacity = String(opacity); changed = true; }
        document.documentElement.style.setProperty('--we-wb-opacity', String(opacity));
      }
      if (blur !== null) document.documentElement.style.setProperty('--we-wb-glass-blur', blur + 'px');
      if (chromeAlpha !== null) document.documentElement.style.setProperty('--we-wb-glass-alpha', String(chromeAlpha));
      // One saturation and one glass colour for every glass surface: these used to be
      // panel-only, so moving them changed nothing in the window.
      if (saturate !== null) document.documentElement.style.setProperty('--we-wb-glass-saturate', String(saturate));
      if (glassRgb) document.documentElement.style.setProperty('--we-wb-glass-rgb', glassRgb);
      // The code surface: the user's slider is the value, and the measurement only
      // raises it when the readability mode is on (autoContrast = off by default, so a
      // slider that says 0.3 really is 0.3 — "调了参数没有用" was this floor).
      if (editorAlpha !== null) userEditorAlpha = editorAlpha;
      var solved = solveEditorAlpha();
      var effectiveEditor = Math.max(userEditorAlpha === null ? 0 : userEditorAlpha, solved);
      document.documentElement.style.setProperty('--we-wb-editor-alpha', String(Math.round(effectiveEditor * 1000) / 1000));
      // The numbers a slider changes have to follow it in /probe too (no re-sampling).
      reportMeasurement();
      if (scrim !== null) userScrim = scrim;
      // Same rule for the dimming layer: with the readability mode off, 0 means a
      // fully transparent layer, exactly as the slider says.
      var floor = wbContrast(contrastStats, wbThemeKind(), contrastMode());
      var effective = Math.max(userScrim === null ? 0 : userScrim, floor.scrim);
      effective = Math.round(effective * 1000) / 1000;
      var fill = contrastMode() === 'off' ? '0,0,0' : floor.fill;
      var scrimEl = document.querySelector('#we-workbench-wallpaper > .we-wb-scrim');
      if (scrimEl) {
        var css = 'rgba(' + fill + ',' + effective + ')';
        if (scrimEl.style.background !== css) { scrimEl.style.background = css; changed = true; }
      }
      document.documentElement.style.setProperty('--we-wb-scrim', String(effective));
      document.documentElement.style.setProperty('--we-wb-scrim-rgb', fill);
      // The wallpaper layer itself is never filtered: the code area has to stay crisp,
      // and a busy wallpaper is handled by the scrim plus the editor's own opacity.
      if (changed) void document.body.offsetHeight;
    } catch (e) { /* cosmetic only */ }
  }

  // Tell the extension that THIS window loaded the patch, so "which windows have
  // it?" can be answered without asking the user to inspect every window.
  function beacon() {
    try {
      var p = fetch(ORIGIN + '/beacon?doc=' + encodeURIComponent(DOC_ID), { cache: 'no-store' });
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* best effort */ }
  }

  // Ask the extension which wallpaper to play. The URL is NOT baked into the HTML:
  // rewriting workbench.html would change its checksum, and VS Code compares the
  // file against the checksum table its main process cached at startup — that is
  // what raises the "安装似乎已损坏。请重新安装。" toast.
  function refresh(video) {
    fetch(ORIGIN + '/current', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (payload) { applyPayload(payload, video); })
      ['catch'](function () { schedule(video, 0); });
  }

  /**
   * Apply one view payload — from the poll, or from the /events push.
   *
   * Split out of refresh() so the server-sent stream can drive exactly the same code:
   * a slider moved in the panel arrives here in milliseconds instead of waiting for the
   * next poll, and while the window is occluded that poll is throttled to about once a
   * minute, which is what made settings look like they did nothing.
   */
  function applyPayload(payload, video) {
    {
      {
        var url = payload && payload.url;
        if (!url) { schedule(video, 2000); return; }
        failures = 0;
        lastPayload = payload || {};
        // Opacity / scrim come from the host's settings, applied here so that
        // changing a slider never has to rewrite workbench.html (which is a
        // checksummed file) or the cached css.
        if (payload.kind === 'scene' && payload.url) {
          // Opt-in live scene behind the whole UI: still first, engine on top once it
          // is mounted (see mountScene). The still field carries the preview.
          if (payload.still && payload.still !== lastStill) {
            lastStill = payload.still;
            var stillImg = imageEl();
            if (stillImg) stillImg.setAttribute('src', payload.still);
          }
          mountScene(payload);
          // Live kinds do not call applyView on their own, so a slider moved while a
          // Scene is mounted used to reach /current and stop there — the page kept the
          // values it booted with (measured: the readability readout froze at 4.51:1
          // while the settings said "off"). Re-apply on every poll; applyView() only
          // writes when a value actually changed.
          applyView(payload, active);
        } else if (payload.kind === 'web' && payload.url) {
          // Opt-in live Web wallpaper: the still preview is the backdrop AND the
          // fallback, the author app renders in the sandboxed stub frame on top of it
          // (see mountWeb).
          if (payload.still && payload.still !== lastStill) {
            lastStill = payload.still;
            var webStill = imageEl();
            if (webStill) webStill.setAttribute('src', payload.still);
          }
          mountWeb(payload);
          applyView(payload, active); // same reason as the Scene branch above
        } else if (payload.kind === 'image') {
          // Still (Scene preview, poster-only wallpapers). A <video> would render
          // nothing at all here, which is why those wallpapers looked broken.
          var img = imageEl();
          if (!img) { schedule(video, 2000); return; }
          setMode('image');
          if (img.getAttribute('src') !== url) {
            img.setAttribute('src', url);
            underlaySampled = false;
          }
          active = img;
          applyView(lastPayload, img);
        } else {
          setMode('video');
          applyView(lastPayload, video);
          if (video.getAttribute('src') !== url) {
            video.setAttribute('src', url);
            underlaySampled = false;
          }
          active = video;
          var p = video.play();
          if (p && p.catch) p.catch(function () {});
        }
        // Report the style probe only once we know the host is reachable. The page
        // loads BEFORE the extension host binds its port, so the probe that used to
        // fire on a blind 1.5 s timer always hit a dead port and was dropped — the
        // read-back stayed empty forever. Piggy-backing on the first successful
        // /current is the moment the answer is guaranteed to arrive.
        if (!probeSent) {
          probeSent = true;
          reportStyles();
          // Again once the workbench has mounted: the first report fires seconds
          // after boot, when .monaco-workbench exists but the editor (and therefore
          // the cursor's line, the sticky widget, …) does not. Without this second
          // report the answer to "is the cursor line still black?" is always MISSING.
          window.setTimeout(reportStyles, 9000);
        }
      }
    }
  }

  function schedule(video, delay) {
    if (failures >= MAX_TRIES) { setFallback(true); return; }
    failures += 1;
    window.setTimeout(function () { refresh(video); }, delay || Math.min(BASE_DELAY * failures, 5000));
  }

  function attach(video) {
    if (video.dataset.weBound === '1') return;
    video.dataset.weBound = '1';

    // Needs to be set before any src is assigned: the media server answers with
    // Access-Control-Allow-Origin: *, and asking for CORS is what keeps the frame
    // sampling canvas readable (a tainted canvas would throw on getImageData).
    try { video.crossOrigin = 'anonymous'; } catch (e) { /* ignore */ }

    video.addEventListener('error', function () { schedule(video, 0); });

    video.addEventListener('playing', function () {
      failures = 0;
      setFallback(false);
      beacon();
      if (!underlaySampled) {
        underlaySampled = true;
        sampleUnderlay(video);
      }
      // A first frame exists now, so this is the moment the readability floor can be
      // measured from real pixels (video wallpapers often start on black).
      scheduleContrast('video');
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) video.pause();
      else {
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
        // Coming back from hidden is the moment the compositor may still hold a
        // stale layer — one short promotion, then release it.
        nudge();
      }
    });
    window.addEventListener('pageshow', nudge);

    refresh(video);
    // Instant updates: the host pushes every view change over /events, so a slider (or
    // the panel's 「立即生效」 button) lands in the window immediately. The poll below
    // stays as the fallback — it is also what recovers if the stream never opens, and
    // EventSource reconnects on its own with the retry hint the server sends.
    openViewStream(video);
    // Follow wallpaper switches (and a sibling window taking over the port)
    // without needing a reload.
    window.setInterval(function () { refresh(video); }, POLL_MS);
  }

  /** Subscribe to the server's view pushes (see applyPayload). */
  function openViewStream(video) {
    if (viewStream || typeof EventSource !== 'function') return;
    try {
      viewStream = new EventSource(ORIGIN + '/events');
      viewStream.addEventListener('view', function (ev) {
        try {
          applyPayload(JSON.parse(ev.data), video);
        } catch (e) { /* a malformed frame must not break the poll */ }
      });
      viewStream.addEventListener('error', function () {
        // EventSource retries by itself; if the port is gone for good, the poll and its
        // backoff take over (and the sibling-window takeover path resets the page).
      });
    } catch (e) {
      viewStream = null;
    }
  }

  function boot() {
    var video = document.getElementById('we-workbench-video');
    if (video) attach(video);
    window.setTimeout(reportStyles, 1500);
  }

  // The Web stub is framed without allow-same-origin, so it cannot be read — it relays
  // its lifecycle trail by postMessage instead, and mountWeb repeats it in every
  // /probe report (see reportLayer). Only the stub frame's messages are accepted.
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.op !== 'we-web-report') return;
    var frame = document.getElementById('we-workbench-web');
    if (frame && e.source && e.source !== frame.contentWindow) return;
    webState.report = String(d.trail || d.stage || '?').slice(0, 300);
  });

  // Report the computed styles of the chrome bands. "Which band is still opaque?"
  // is a question only the renderer can answer, so it answers it — the host reads
  // the reply from /probe instead of guessing from screenshots.
  function reportStyles() {
    var sels = [
      '.monaco-workbench',
      '.monaco-workbench .part.titlebar',
      '.monaco-workbench .part.titlebar > .titlebar-container',
      '.monaco-workbench .titlebar-left',
      '.monaco-workbench .titlebar-center',
      '.monaco-workbench .titlebar-right',
      '.monaco-workbench .command-center',
      '.monaco-workbench .menubar',
      '.monaco-workbench .window-controls-container',
      // The three buttons. MISSING / count 0 means they are Electron's native
      // overlay instead of DOM nodes (window.controlsStyle is not "custom") — the
      // one case no stylesheet can make transparent.
      '.monaco-workbench .window-controls-container > .window-icon',
      '.monaco-workbench .part.activitybar',
      '.monaco-workbench .part.sidebar',
      '.monaco-workbench .part.auxiliarybar',
      '.monaco-workbench .part.panel',
      '.monaco-workbench .part.editor > .content',
    '.monaco-workbench .part.editor > .content .editor-group-container > .title',
      '.monaco-workbench .part.editor > .content .editor-group-container > .title .tabs',
      '.monaco-workbench .part.editor > .content .editor-group-container > .title .tab.active',
      '.monaco-workbench .part.statusbar',
      '.monaco-workbench .monaco-editor-background',
      '.monaco-workbench .monaco-editor .view-overlays',
      // The cursor's line. A solid fill here is the "black band on the current
      // line" complaint: Monaco paints it from editor.lineHighlightBackground.
      '.monaco-workbench .monaco-editor .current-line',
      '.monaco-workbench .sticky-widget'
    ];
    var out = {};
    for (var i = 0; i < sels.length; i++) {
      var el = document.querySelector(sels[i]);
      if (!el) { out[sels[i]] = 'MISSING'; continue; }
      var cs = getComputedStyle(el);
      out[sels[i]] = {
        bg: cs.backgroundColor,
        img: cs.backgroundImage === 'none' ? '' : cs.backgroundImage.slice(0, 48),
        title: cs.getPropertyValue('--vscode-titleBar-activeBackground').trim(),
        tabs: cs.getPropertyValue('--vscode-editorGroupHeader-tabsBackground').trim(),
        cc: cs.getPropertyValue('--vscode-commandCenter-background').trim(),
        // The *inline* background is what VS Code reads back and forwards to
        // Electron's setTitleBarOverlay; CSS !important does not change it.
        inlineBg: el.style && el.style.backgroundColor ? el.style.backgroundColor : '',
        // A backdrop-filter on the element itself would create a stacking context and
        // trap the menubar's dropdowns under the later-painted parts (measured: the File
        // menu rendered with no background). The frosting therefore lives on ::before,
        // and these two fields are how that is verified without opening a menu: the
        // element must report "none", the pseudo-element the blur.
        backdrop: cs.backdropFilter || cs.webkitBackdropFilter || '',
        backdropBefore: (function () {
          try {
            var ps = window.getComputedStyle(el, '::before');
            return ps.backdropFilter || ps.webkitBackdropFilter || '';
          } catch (e) { return ''; }
        })(),
        box: Math.round(el.getBoundingClientRect().width) + 'x' + Math.round(el.getBoundingClientRect().height)
      };
    }
    // The direct answer to "is Electron still drawing a native overlay?" — the
    // API only reports visible while Chromium owns that strip.
    var wco = null;
    try { wco = navigator.windowControlsOverlay ? !!navigator.windowControlsOverlay.visible : null; } catch (e) { wco = null; }
    var icons = 0;
    try { icons = document.querySelectorAll('.window-controls-container > .window-icon').length; } catch (e) { icons = -1; }
    // The colours the cursor's line is painted from, straight off the workbench
    // element (the theme service declares them there, so this is where an override
    // has to land).
    var vars = {};
    try {
      var wcs = getComputedStyle(document.querySelector('.monaco-workbench'));
      var names = ['--vscode-editor-lineHighlightBackground', '--vscode-editor-lineHighlightBorder',
                   '--vscode-editor-hoverHighlightBackground', '--vscode-editorStickyScroll-background',
                   '--vscode-editorStickyScrollGutter-background',
                   '--we-wb-line-tint', '--we-wb-editor-wash', '--we-wb-sticky',
                   '--we-wb-underlay', '--we-wb-opacity', '--we-wb-scrim'];
      for (var k = 0; k < names.length; k++) vars[names[k]] = wcs.getPropertyValue(names[k]).trim();
    } catch (e) { /* diagnostics only */ }
    var payload = JSON.stringify({
      doc: DOC_ID,
      at: new Date().toISOString(),
      fallback: document.documentElement.classList.contains(FALLBACK_CLASS),
      htmlClass: document.documentElement.className,
      wbClass: (document.querySelector('.monaco-workbench') || {}).className || '',
      wcoVisible: wco,
      iconCount: icons,
      vars: vars,
      styles: out
    });
    try {
      // text/plain, not application/json: a JSON content type turns this into a
      // CORS preflighted request, and a server that answers OPTIONS with a bare 200
      // makes the browser drop the probe on the floor (that is exactly what
      // happened before: /probe stayed null forever). A "simple" request needs no
      // preflight, and the host JSON.parses the body regardless of content type.
      var p = fetch(ORIGIN + '/probe', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: payload });
      if (p && p.catch) p.catch(function () {});
    } catch (e) { /* diagnostics only */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
`;
}

/**
 * The Web-wallpaper stub shell, dropped next to workbench.html as
 * `we-workbench-web.html`.
 *
 * The injected script frames this page (`frame-src 'self'` allows a sibling file of the
 * workbench document) whenever `/current` says `kind: "web"`, passing the media origin
 * and the wallpaper's directory token in the query string. The stub is what makes a Web
 * wallpaper possible behind the whole UI without touching the checksummed
 * workbench.html: a Web wallpaper's author app is an HTML document, and the only way to
 * run one is a frame — either the engine's sandboxed `blob:` frame or this page.
 *
 * A sandbox attribute is NOT used on this frame: measured, a sandboxed frame of a
 * vscode-file document never becomes a document (load fires, nothing renders, no script
 * runs), so the page could not work at all. Isolation therefore sits where untrusted
 * code actually runs — the stub re-sandboxes the engine's author frame, whose origin
 * would otherwise be this page's (and therefore the VS Code workbench's). Nothing here
 * is user-supplied either way.
 *
 * The script is EXTERNAL on purpose — see WEB_STUB_JS_FILE for why an inline one does
 * not survive in the real workbench.
 *
 * Deliberately static: the host and the wallpaper travel in the query string, so this
 * file (and therefore the frozen workbench.html) only changes when the code does.
 */
export function buildWebStubHtml(): string {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>we-workbench-web</title>
<style>
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; }
#we-web-host { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>
</head>
<body>
<div id="we-web-host"></div>
<script src="./${WEB_STUB_JS_FILE}"></script>
</body>
</html>
`;
}

/**
 * The stub's logic. Runs under whatever policy the real workbench hands the frame —
 * which, measured, is the workbench's own: `script-src 'self' 'unsafe-eval' blob:`,
 * `connect-src ... http://127.0.0.1:*`, `frame-src 'self' vscode-webview:`. Every step
 * below is legal under exactly that:
 *
 *  1. this file itself: a same-origin `src` ('self');
 *  2. the engine: fetched as TEXT over the loopback (connect-src) and imported from a
 *     blob: URL (script-src) — the same trick the injected script uses for a Scene,
 *     because a module import straight from the loopback origin is not allowed;
 *  3. the author app: mounted by that engine into its own sandboxed frame.
 *
 * It reports every step to the host's /probe with a `web-` prefix, because the parent
 * workbench cannot see into a sandboxed frame: without these reports a failure here is
 * indistinguishable from "the wallpaper just does not work".
 */
export function buildWebStubJs(): string {
  return `/* Generated by the we-for-vscode extension. See buildWebStubJs(). */
(function () {
  'use strict';
  var q = new URLSearchParams(location.search);
  var ORIGIN = q.get('o') || '';
  var KEY = q.get('key') || '';
  var host = document.getElementById('we-web-host');
  var frames = 0;
  var trail = [];

  function report(stage, extra) {
    var line = stage + (extra == null ? '' : ' | ' + String(extra).slice(0, 140));
    trail.push(line);
    if (trail.length > 8) trail.shift();
    // This document is framed WITHOUT allow-same-origin, so the workbench cannot read
    // it — the trail travels by postMessage and is repeated in the parent's own /probe
    // report. Without that, a failure here looks exactly like "the wallpaper does not
    // work" (and /probe's scene slot is shared, so a single last-value report can be
    // overwritten before anyone reads it).
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ op: 'we-web-report', stage: stage, err: extra == null ? null : String(extra), trail: trail.join(' ; ') }, '*');
      }
    } catch (e) { /* postMessage is best effort */ }
    try {
      fetch(ORIGIN + '/probe', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ scene: { stage: 'web-' + stage, key: KEY, err: trail.join(' ; '), tt: 'stub' } })
      })['catch'](function () {});
    } catch (e) { /* a wallpaper failure must never break the host */ }
  }

  if (!ORIGIN || !KEY) { report('no-args', 'o=' + ORIGIN + ' key=' + KEY); return; }

  // Which policy did this frame actually get? An inline script is the discriminator:
  // the workbench policy has no 'unsafe-inline', a page without a policy has no rule.
  // Reported because the difference decides how the engine may be loaded, and getting
  // it wrong is invisible from the outside.
  var inlineOk = false;
  try {
    var probe = document.createElement('script');
    probe.textContent = 'window.__weInline = 1;';
    document.head.appendChild(probe);
    probe.remove();
    inlineOk = window.__weInline === 1;
  } catch (e) { /* blocked == the strict policy applies */ }
  report('boot', 'origin=' + location.origin + ' inline=' + (inlineOk ? 'allowed' : 'blocked'));

  fetch(ORIGIN + '/status')
    .then(function (r) { return r.text(); })
    .then(function () { report('loopback-reachable'); })
    ['catch'](function (e) { report('loopback-blocked', e && e.message ? e.message : e); });

  // The author page's own shim posts a frame heartbeat to its parent — this document.
  // Relaying the first one is the only proof from the outside that the wallpaper is
  // actually painting (the parent workbench cannot see into a sandboxed frame).
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (!d || d.op !== 'we-frame') return;
    frames += 1;
    if (frames === 1) report('author-first-frame', 't=' + d.t);
  });

  // The parent workbench frames this page WITHOUT a sandbox, because a sandboxed frame
  // of a vscode-file document never becomes a document at all (measured: load fires,
  // nothing renders, no script runs). That leaves this document same-origin with the
  // VS Code workbench — and the engine creates the author's frame as a blob: URL
  // inheriting that origin, i.e. wallpaper code could reach the workbench DOM. So the
  // author's frame is re-sandboxed here, as early as it can be caught: an explicit
  // sandbox attribute makes its origin opaque, which cuts it off from this document,
  // from the stub's parents and from the workbench's storage, without affecting the
  // render (the engine's own shim talks over postMessage, not through contentWindow).
  var hardened = 0;
  function hardenAuthorFrame() {
    var f = document.querySelector('#we-web-host iframe');
    if (!f || f.getAttribute('sandbox') === 'allow-scripts') return;
    f.setAttribute('sandbox', 'allow-scripts');
    hardened += 1;
    report('hardened', 'author iframe sandboxed (#we-web-host iframe)');
  }

  try {
    new MutationObserver(hardenAuthorFrame).observe(host, { childList: true, subtree: true });
  } catch (e) {
    window.setInterval(hardenAuthorFrame, 250);
  }

  // Two steps, both required by the workbench policy: the loopback is allowed as a
  // connection but not as a script source, so the engine arrives as text and is
  // imported from a blob URL (script-src 'blob:').
  fetch(ORIGIN + '/engine/webwallgl.mjs', { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('engine http ' + r.status); return r.text(); })
    .then(function (code) {
      report('engine-fetched', code.length + 'B');
      var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      return import(url)['catch'](function (e) {
        throw new Error('blob import 失败：' + (e && e.message ? e.message : e));
      });
    })
    .then(function (lib) {
      report('engine-imported');
      if (!lib || typeof lib.mount !== 'function' || typeof lib.httpSource !== 'function') {
        throw new Error('engine 缺少 mount/httpSource');
      }
      return lib.mount(host, {
        source: lib.httpSource(KEY),
        fit: 'cover',
        // Same tuning policy as the Scene path: this layer is not the one the user
        // reads text through, and a Web wallpaper's frame clock is only a heartbeat.
        fps: 24,
        autoplay: true,
        volume: 0,
        onDiagnostic: function (msg, level) {
          report('engine', (level || 'info') + ' ' + String(msg).slice(0, 120));
        }
      });
    })
    .then(function (instance) {
      hardenAuthorFrame();
      report('mounted', 'iframe=' + !!document.querySelector('#we-web-host iframe') + ' instance=' + !!instance + ' hardened=' + hardened);
    })
    ['catch'](function (err) {
      report('failed', (err && err.name ? err.name + ': ' : '') + (err && err.message ? err.message : err));
    });
})();
`;
}

