/**
 * Title-bar colour merge tests.
 *
 * These guard the "don't clobber the user's theme" rules.
 *
 * The values are not cosmetic, but the colour keys alone are NOT what makes the
 * three window buttons transparent — that was the earlier, wrong reading. VS Code
 * forces the native overlay colour opaque before handing it to Electron
 * (`isOpaque() ? c : c.makeOpaque(#252526)`), so the buttons can only be transparent
 * when they are DOM nodes, i.e. when `window.controlsStyle` is `custom`. These tests
 * therefore cover both: the colour merge, and the `window.*` plan that switches the
 * buttons over to DOM.
 */

'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONTROLS_STYLE_DOM,
  EDITOR_OVERLAY_COLORS,
  TITLEBAR_COLORS,
  WALLPAPER_EDITOR_SETTINGS,
  hasDomWindowControls,
  isCustomTitleBar,
  mergeColors,
  mergeEditorOverlayColors,
  mergeSettings,
  mergeTitleBarColors,
  planWindowStyles,
  supportsControlsStyle,
} = require('../out/titlebar.js');

const VALUES = Object.values(TITLEBAR_COLORS);

test('enabling writes exactly our two keys', () => {
  const { next, changed } = mergeTitleBarColors(undefined, true);
  assert.equal(changed, true);
  assert.deepEqual(next, { 'titleBar.activeBackground': '#00000000', 'titleBar.inactiveBackground': '#00000000' });
  assert.equal(VALUES.every((v) => v === '#00000000'), true, '必须是全透明（alpha=00）');
});

test('other customisations survive', () => {
  const { next } = mergeTitleBarColors({ 'editor.background': '#123456', 'statusBar.background': '#000000' }, true);
  assert.equal(next['editor.background'], '#123456');
  assert.equal(next['statusBar.background'], '#000000');
});

test('the user’s own title bar colours are stashed and restored', () => {
  const user = { 'titleBar.activeBackground': '#ff0000' };
  const on = mergeTitleBarColors(user, true);
  assert.equal(on.next['titleBar.activeBackground'], '#00000000');
  assert.deepEqual(on.stash, { 'titleBar.activeBackground': '#ff0000' }, '原值必须被记住');

  const off = mergeTitleBarColors(on.next, false, on.stash);
  assert.equal(off.next['titleBar.activeBackground'], '#ff0000', '关闭时必须还原用户原值');
  assert.deepEqual(off.stash, {}, '还原后 stash 清空');
});

test('disabling removes only our keys, and drops an empty object', () => {
  const off = mergeTitleBarColors({ ...TITLEBAR_COLORS }, false);
  assert.equal(off.next, undefined, '只剩我们的键时整个对象应被移除');

  const mixed = mergeTitleBarColors({ ...TITLEBAR_COLORS, 'editor.background': '#123456' }, false);
  assert.deepEqual(mixed.next, { 'editor.background': '#123456' });
});

test('a value the user changed by hand is left alone', () => {
  const off = mergeTitleBarColors({ 'titleBar.activeBackground': '#00ff00' }, false);
  assert.equal(off.changed, false, '不是我们写的值就不该动它');
  assert.equal(off.next['titleBar.activeBackground'], '#00ff00');
});

test('applying twice is idempotent', () => {
  const first = mergeTitleBarColors(undefined, true);
  const second = mergeTitleBarColors(first.next, true, first.stash);
  assert.equal(second.changed, false);
  assert.deepEqual(second.next, first.next);
});

test('isCustomTitleBar only accepts the DOM-rendered mode', () => {
  assert.equal(isCustomTitleBar('custom'), true);
  assert.equal(isCustomTitleBar('native'), false);
  assert.equal(isCustomTitleBar(undefined), false);
});

// ── window.controlsStyle: who draws the three buttons ────────────────────────

test('enabling switches both window keys, and only what differs', () => {
  assert.deepEqual(planWindowStyles(true, {}, {}, 'win32'), [
    { key: 'titleBarStyle', value: 'custom' },
    { key: 'controlsStyle', value: 'custom' },
  ]);
  // Already custom → nothing to write (idempotent, no checksum/config churn).
  assert.deepEqual(planWindowStyles(true, { titleBarStyle: 'custom', controlsStyle: 'custom' }, {}, 'win32'), []);
  // Only the missing one is written.
  assert.deepEqual(planWindowStyles(true, { titleBarStyle: 'custom', controlsStyle: 'native' }, {}, 'win32'), [
    { key: 'controlsStyle', value: 'custom' },
  ]);
});

test('macOS has no window.controlsStyle to write', () => {
  assert.equal(supportsControlsStyle('darwin'), false);
  assert.equal(supportsControlsStyle('win32'), true);
  assert.equal(supportsControlsStyle('linux'), true);
  assert.deepEqual(planWindowStyles(true, {}, {}, 'darwin'), [{ key: 'titleBarStyle', value: 'custom' }]);
});

test('disabling restores the user’s own controlsStyle, or removes the key', () => {
  const custom = { titleBarStyle: 'custom', controlsStyle: 'custom' };
  // The user had set "hidden" before we touched it → that exact value comes back.
  assert.deepEqual(planWindowStyles(false, custom, { controlsStyle: 'hidden' }, 'win32'), [
    { key: 'titleBarStyle', value: 'native' },
    { key: 'controlsStyle', value: 'hidden' },
  ]);
  // The user never had the key → remove it instead of leaving our own value behind.
  assert.deepEqual(planWindowStyles(false, custom, {}, 'win32'), [
    { key: 'titleBarStyle', value: 'native' },
    { key: 'controlsStyle', value: undefined },
  ]);
});

test('a value the user took over is left alone on the way out', () => {
  // Not our value in controlsStyle → don't touch it (same rule as the colour merge).
  assert.deepEqual(planWindowStyles(false, { titleBarStyle: 'native', controlsStyle: 'native' }, {}, 'win32'), []);
});

test('hasDomWindowControls answers "can CSS reach the three buttons?"', () => {
  assert.equal(hasDomWindowControls(CONTROLS_STYLE_DOM, 'win32'), true);
  assert.equal(hasDomWindowControls('native', 'win32'), false);
  assert.equal(hasDomWindowControls('hidden', 'win32'), false);
  assert.equal(hasDomWindowControls(CONTROLS_STYLE_DOM, 'darwin'), false);
});

// ── editor overlays VS Code paints from a JS-read colour ─────────────────────

test('the cursor-line colours are written where theme.getColor() reads them', () => {
  // Not a CSS variable in this VS Code: the value is read with theme.getColor() and
  // injected as a dynamic rule, so `workbench.colorCustomizations` is the only lever.
  const { next, changed } = mergeEditorOverlayColors(undefined, true);
  assert.equal(changed, true);
  assert.deepEqual(next, {
    'editor.lineHighlightBackground': '#80808014',
    'editor.inactiveLineHighlightBackground': '#8080800a',
    'editor.lineHighlightBorder': '#00000000',
  });
  // A 2px dark border (dark default #282828) reads as a black bar on the cursor line.
  assert.equal(next['editor.lineHighlightBorder'], '#00000000');
  // Mid-grey works on both light and dark themes; a white tint would vanish on light.
  assert.match(next['editor.lineHighlightBackground'], /^#808080[0-9a-f]{2}$/);
});

test('a user’s own line-highlight colour is stashed and restored', () => {
  const user = { 'editor.lineHighlightBackground': '#ff0000' };
  const on = mergeEditorOverlayColors(user, true);
  assert.equal(on.stash['editor.lineHighlightBackground'], '#ff0000');
  const off = mergeEditorOverlayColors(on.next, false, on.stash);
  assert.equal(off.next['editor.lineHighlightBackground'], '#ff0000', '关闭时必须还原');
  assert.deepEqual(off.stash, {});
});

test('a line-highlight value the user changed by hand is left alone', () => {
  const off = mergeEditorOverlayColors({ 'editor.lineHighlightBackground': '#123456' }, false);
  assert.equal(off.changed, false);
  assert.equal(off.next['editor.lineHighlightBackground'], '#123456');
});

test('one merge covers both groups with a single stash', () => {
  const merged = mergeColors(undefined, { ...TITLEBAR_COLORS, ...EDITOR_OVERLAY_COLORS }, true);
  assert.equal(Object.keys(merged.next).length, 5, '标题栏 2 个键 + 光标行 3 个键');
  const reverted = mergeColors(merged.next, { ...TITLEBAR_COLORS, ...EDITOR_OVERLAY_COLORS }, false, merged.stash);
  assert.equal(reverted.next, undefined, '全部还原后整个对象应被移除');
});

// ── editor settings that cannot coexist with a transparent editor ────────────

test('wallpaper mode turns sticky scroll off (the feature is an overlay by design)', () => {
  // 透明 → 钉住的行和下面的正文重叠（"代码行残留"）；不透明 → 一条盖住首行的暗带
  // （"顶上还是有粘滞区"）。CSS 造不出第三种，所以只能在壁纸模式下关掉它。
  assert.equal(WALLPAPER_EDITOR_SETTINGS['editor.stickyScroll.enabled'], false);
});

test('mergeSettings restores "the user never set it" as absent, not as false', () => {
  // `undefined` 是一个真实状态：用户从没设过。还原时必须是"删掉我们的覆盖"，
  // 而不是写回一个 false 冒充用户的选择（那会永久改变他的编辑器行为）。
  const on = mergeSettings({}, WALLPAPER_EDITOR_SETTINGS, true);
  assert.equal(on.changed, true);
  assert.equal(on.next['editor.stickyScroll.enabled'], false);
  assert.ok('editor.stickyScroll.enabled' in on.stash, '必须记住"原本没有"');
  assert.equal(on.stash['editor.stickyScroll.enabled'], undefined);

  const off = mergeSettings(on.next, WALLPAPER_EDITOR_SETTINGS, false, on.stash);
  assert.equal(off.changed, true);
  assert.equal('editor.stickyScroll.enabled' in off.next, false, '还原后这个键必须消失');
  assert.deepEqual(off.stash, {});
});

test('mergeSettings gives the user’s own value back, and never fights a manual change', () => {
  const on = mergeSettings({ 'editor.stickyScroll.enabled': true }, WALLPAPER_EDITOR_SETTINGS, true);
  assert.equal(on.stash['editor.stickyScroll.enabled'], true);
  const off = mergeSettings(on.next, WALLPAPER_EDITOR_SETTINGS, false, on.stash);
  assert.equal(off.next['editor.stickyScroll.enabled'], true, '用户原本开着，就要还他开着');

  // 用户手动把它改回 true（不是我们写的值）→ 还原时不许动它
  const manual = mergeSettings({ 'editor.stickyScroll.enabled': true }, WALLPAPER_EDITOR_SETTINGS, false, {});
  assert.equal(manual.changed, false);
  assert.equal(manual.next['editor.stickyScroll.enabled'], true);
});
