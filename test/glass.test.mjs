/**
 * Glass math tests (ESM, importing the very file the webview loads).
 *
 * The reading worth defending here is the readability floor: upstream measured
 * that a glass alpha below ~0.45 (light) / 0.59 (dark) cannot hold text contrast
 * over an arbitrary wallpaper, so the floor must win over the slider value.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  READABILITY_FLOOR,
  buildGlassVars,
  clamp,
  clampGlassAlpha,
  readabilityFloor,
  renderModeLabel,
  resolveGlassChannels,
  resolveGlassColor,
  themeKindFromClassList,
} from '../media/glass.mjs';

test('clamp keeps values inside range and rejects NaN', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-5, 0, 10), 0);
  assert.equal(clamp(50, 0, 10), 10);
  assert.equal(clamp('abc', 2, 10), 2);
});

test('themeKindFromClassList reads the classes VS Code sets on <body>', () => {
  assert.equal(themeKindFromClassList(['vscode-light']), 'light');
  assert.equal(themeKindFromClassList(['vscode-dark']), 'dark');
  assert.equal(themeKindFromClassList(['vscode-high-contrast']), 'dark');
  assert.equal(themeKindFromClassList(['vscode-high-contrast-light']), 'light');
  assert.equal(themeKindFromClassList([]), 'dark');
});

test('glass alpha is raised to the readability floor, never lowered', () => {
  assert.equal(readabilityFloor('light'), READABILITY_FLOOR.light);
  assert.equal(readabilityFloor('dark'), READABILITY_FLOOR.dark);
  assert.equal(clampGlassAlpha(0.1, 'light'), 0.45);
  assert.equal(clampGlassAlpha(0.1, 'dark'), 0.59);
  assert.equal(clampGlassAlpha(0.9, 'dark'), 0.9, 'a value above the floor is respected');
  assert.equal(clampGlassAlpha(2, 'light'), 1, 'clamped to 1');
});

test('resolveGlassColor only accepts #rgb / #rrggbb', () => {
  assert.equal(resolveGlassColor('#abc'), '#abc');
  assert.equal(resolveGlassColor('#A1B2C3'), '#A1B2C3');
  assert.equal(resolveGlassColor('red'), '#101014');
  assert.equal(resolveGlassColor('javascript:alert(1)'), '#101014');
  assert.equal(resolveGlassColor(undefined), '#101014');
});

test('resolveGlassChannels expands shorthand and falls back safely', () => {
  assert.equal(resolveGlassChannels('#101014'), '16 16 20');
  assert.equal(resolveGlassChannels('#fff'), '255 255 255');
  assert.equal(resolveGlassChannels('#000000'), '0 0 0');
  assert.equal(resolveGlassChannels('nonsense'), '16 16 20');
});

test('buildGlassVars emits every CSS custom property style.css consumes', () => {
  const vars = buildGlassVars(
    { blur: 999, saturate: -1, wallpaperOpacity: 0, scrim: 2, border: 3, glassAlpha: 0.2, glassColor: '#123456', panelWidth: 10 },
    'dark',
  );
  assert.deepEqual(Object.keys(vars).sort(), [
    '--we-blur',
    '--we-border',
    '--we-glass-alpha',
    '--we-glass-rgb',
    '--we-panel-width',
    '--we-saturate',
    '--we-scrim',
    '--we-wallpaper-opacity',
  ]);
  assert.equal(vars['--we-blur'], '60px', 'blur clamped to the slider max');
  assert.equal(vars['--we-saturate'], '0', 'saturate clamped to 0');
  assert.equal(vars['--we-wallpaper-opacity'], '0.05', 'opacity floor keeps some wallpaper visible');
  assert.equal(vars['--we-scrim'], '1');
  assert.equal(vars['--we-glass-alpha'], '0.59', 'dark-theme readability floor applied');
  assert.equal(vars['--we-panel-width'], '240px');
  assert.equal(vars['--we-glass-rgb'], '18 52 86');
});

test('buildGlassVars tolerates a partial settings object', () => {
  const vars = buildGlassVars({}, 'light');
  assert.equal(vars['--we-glass-alpha'], '0.45');
  assert.equal(vars['--we-blur'], '0px');
});

test('renderModeLabel never calls an Application wallpaper playable', () => {
  assert.match(renderModeLabel({ renderMode: 'video', mediaExt: 'mp4' }), /播放中/);
  assert.match(renderModeLabel({ renderMode: 'poster', type: 'scene' }), /仅预览/);
  assert.match(renderModeLabel({ renderMode: 'none', type: 'application' }), /不渲染/);
  assert.equal(renderModeLabel(null), '未选择');
});
