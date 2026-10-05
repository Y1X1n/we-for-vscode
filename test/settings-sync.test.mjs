/**
 * The settings round-trip race, pinned.
 *
 * Reported by the user as: "怎么有的选项选择了以后 点击立即生效会回弹到之前的设置然后也没
 * 生效啊" — the panel wrote a slider value on a 150 ms debounce, the apply button asked the
 * host for the configuration inside that window, and the echo (still the old value)
 * overwrote the slider and was pushed to the windows.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createPendingSettings } from '../media/settings-sync.mjs';

test('a local value survives a host echo that is still the old one', () => {
  const pending = createPendingSettings();
  const local = { chromeGlassAlpha: 0.8, scrim: 0.35 };

  // The user moves a slider: local state is updated synchronously, the write is not.
  pending.set('chromeGlassAlpha', 0.8);

  // The host echoes the configuration it still has — the old value.
  const merged = pending.merge(local, { chromeGlassAlpha: 0.45, scrim: 0.35 });
  assert.equal(merged.chromeGlassAlpha, 0.8, '滑块不得被旧值弹回去');
  assert.equal(merged.scrim, 0.35, '没改过的项照常接受主机的值');
  assert.deepEqual(pending.keys(), ['chromeGlassAlpha'], '还没确认，继续等待');
});

test('the pending value stops winning once the host agrees', () => {
  const pending = createPendingSettings();
  pending.set('chromeGlassAlpha', 0.8);

  // The write landed: the echo now carries the new value.
  const merged = pending.merge({ chromeGlassAlpha: 0.8 }, { chromeGlassAlpha: 0.8 });
  assert.equal(merged.chromeGlassAlpha, 0.8);
  assert.deepEqual(pending.keys(), [], '确认后必须清除，否则用户再也改不回去');

  // ...so a later host-side change (VS Code settings UI, another window) is accepted.
  const after = pending.merge({ chromeGlassAlpha: 0.8 }, { chromeGlassAlpha: 0.2 });
  assert.equal(after.chromeGlassAlpha, 0.2, '确认之后主机说了算');
});

test('several sliders moved in a row each keep their own value', () => {
  const pending = createPendingSettings();
  pending.set('blur', 24);
  pending.set('editorGlassAlpha', 0.9);
  pending.set('chromeGlassAlpha', 0.7);

  // A partial echo: only blur has landed.
  const merged = pending.merge(
    { blur: 24, editorGlassAlpha: 0.9, chromeGlassAlpha: 0.7 },
    { blur: 24, editorGlassAlpha: 0.72, chromeGlassAlpha: 0.45 },
  );
  assert.equal(merged.blur, 24);
  assert.equal(merged.editorGlassAlpha, 0.9, '未落地的项继续用本地值');
  assert.equal(merged.chromeGlassAlpha, 0.7, '未落地的项继续用本地值');
  assert.deepEqual(pending.keys().sort(), ['chromeGlassAlpha', 'editorGlassAlpha']);

  // Full echo: everything confirmed.
  const settled = pending.merge(merged, { blur: 24, editorGlassAlpha: 0.9, chromeGlassAlpha: 0.7 });
  assert.deepEqual(pending.keys(), []);
  assert.equal(settled.editorGlassAlpha, 0.9);
});

test('a missing or empty echo never drops local state', () => {
  const pending = createPendingSettings();
  pending.set('scrim', 0.5);
  assert.equal(pending.merge({ scrim: 0.5 }, undefined).scrim, 0.5);
  assert.equal(pending.merge({ scrim: 0.5 }, {}).scrim, 0.5);
  assert.deepEqual(pending.keys(), ['scrim']);
});
