/**
 * Layer-state tests — the regression guard for the "first frame residue" bug.
 *
 * Reported symptom: a Video wallpaper kept showing its first frame while playing.
 * Cause: the preview still was rendered on top of the <video> (DOM order), and for
 * two of the four local Video wallpapers that preview is an *animated GIF*, so the
 * overlay looked like a stuck first frame.
 *
 * The invariant asserted here: once a real frame has painted, the preview is gone.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { computeLayerState, playButtonLabel } from '../media/render-state.mjs';

const videoItem = { id: 'w1', renderMode: 'video', media: 'http://127.0.0.1:1/m/x', preview: 'http://127.0.0.1:1/m/gif' };
const videoNoPreview = { id: 'w2', renderMode: 'video', media: 'http://127.0.0.1:1/m/y', preview: null };
const sceneItem = { id: 's1', renderMode: 'poster', type: 'scene', preview: 'http://127.0.0.1:1/m/p' };
const appItem = { id: 'a1', renderMode: 'none', type: 'application', preview: null };

test('regression: the preview disappears as soon as a frame has painted', () => {
  const before = computeLayerState({ item: videoItem, hasPaintedFrame: false });
  assert.equal(before.showVideo, true);
  assert.equal(before.showPoster, true, '首帧之前用预览图占位，不留黑屏');
  assert.equal(before.reason, 'first-frame-pending');

  const after = computeLayerState({ item: videoItem, hasPaintedFrame: true });
  assert.equal(after.showVideo, true);
  assert.equal(after.showPoster, false, '首帧出现后预览图必须消失（残留 bug 的回归守卫）');
  assert.equal(after.reason, 'playing');
});

test('the preview is never shown for a video without one', () => {
  for (const hasPaintedFrame of [false, true]) {
    const layer = computeLayerState({ item: videoNoPreview, hasPaintedFrame });
    assert.equal(layer.showPoster, false);
    assert.equal(layer.showVideo, true);
  }
});

test('a failed video degrades to the still preview, not a black stage', () => {
  const layer = computeLayerState({ item: videoItem, videoFailed: true });
  assert.equal(layer.showVideo, false);
  assert.equal(layer.showPoster, true);
  assert.equal(layer.shouldPlay, false);
  assert.equal(layer.reason, 'video-failed');
});

test('poster-only and application items never show the video layer', () => {
  const scene = computeLayerState({ item: sceneItem });
  assert.equal(scene.showVideo, false);
  assert.equal(scene.showPoster, true);
  assert.equal(scene.reason, 'poster-only');

  const app = computeLayerState({ item: appItem });
  assert.deepEqual(
    { v: app.showVideo, p: app.showPoster, play: app.shouldPlay },
    { v: false, p: false, play: false },
    'Application 壁纸永不渲染',
  );

  const none = computeLayerState({ item: null });
  assert.equal(none.reason, 'no-item');
});

test('shouldPlay honours the occlusion-pause inputs', () => {
  const base = { item: videoItem, hasPaintedFrame: true };
  assert.equal(computeLayerState(base).shouldPlay, true);
  assert.equal(computeLayerState({ ...base, paused: true }).shouldPlay, false, '用户暂停');
  assert.equal(computeLayerState({ ...base, visible: false }).shouldPlay, false, '面板不可见');
  assert.equal(computeLayerState({ ...base, focused: false }).shouldPlay, false, '窗口失焦');
});

test('computeLayerState tolerates a missing argument', () => {
  const layer = computeLayerState(undefined);
  assert.equal(layer.reason, 'no-item');
});

test('play button label follows the layer, not just the user flag', () => {
  assert.equal(playButtonLabel(computeLayerState({ item: videoItem, hasPaintedFrame: true })), '暂停');
  assert.equal(playButtonLabel(computeLayerState({ item: videoItem, hasPaintedFrame: true, paused: true })), '播放');
  assert.equal(playButtonLabel(computeLayerState({ item: sceneItem })), '播放');
  assert.equal(playButtonLabel(undefined), '播放');
});

// ── Scene (WebWallGL) ────────────────────────────────────────────────────────

const liveScene = {
  id: 's2',
  renderMode: 'scene',
  type: 'scene',
  media: 'http://127.0.0.1:1/wallpaper-engine/scene-files/tok/scene.pkg',
  sceneBase: 'http://127.0.0.1:1/wallpaper-engine/scene-files/tok',
  preview: 'http://127.0.0.1:1/m/preview',
};

test('a scene shows the renderer layer, and the poster until it reports a frame', () => {
  const before = computeLayerState({ item: liveScene, sceneReady: false });
  assert.equal(before.showScene, true, '渲染页 iframe 必须挂上（它自己会画）');
  assert.equal(before.showVideo, false);
  assert.equal(before.showPoster, true, '就绪之前用预览图盖住引擎页自己的 #000 背景');
  assert.equal(before.reason, 'live-first-frame-pending');

  const after = computeLayerState({ item: liveScene, sceneReady: true });
  assert.equal(after.showScene, true);
  assert.equal(after.showPoster, false, '有帧之后预览图必须消失');
  assert.equal(after.reason, 'scene-live');
});

test('the scene layer honours occlusion pause like the video layer', () => {
  const base = { item: liveScene, sceneReady: true };
  assert.equal(computeLayerState(base).shouldPlay, true);
  assert.equal(computeLayerState({ ...base, paused: true }).shouldPlay, false);
  assert.equal(computeLayerState({ ...base, visible: false }).shouldPlay, false);
  assert.equal(computeLayerState({ ...base, focused: false }).shouldPlay, false);
  assert.equal(playButtonLabel(computeLayerState(base)), '暂停', '场景在跑时按钮也要说"暂停"');
});

test('only one live layer can be on: scene items never keep a video layer', () => {
  for (const sceneReady of [false, true]) {
    const layer = computeLayerState({ item: liveScene, sceneReady, hasPaintedFrame: true });
    assert.equal(layer.showVideo, false, '场景与视频不得同时可见');
  }
  // …and a scene without a payload is not renderable at all.
  const noPayload = computeLayerState({ item: { ...liveScene, media: null } });
  assert.equal(noPayload.showScene, false);
  assert.equal(noPayload.showPoster, true, '没有载荷时退回预览图，而不是黑屏');
});

// ── Web (same machine as Scene, different reason label) ──────────────────────

const liveWeb = {
  id: 'w9',
  renderMode: 'web',
  type: 'web',
  media: 'http://127.0.0.1:1/wallpaper-engine/scene-files/tok/index.html',
  sceneBase: 'http://127.0.0.1:1/wallpaper-engine/scene-files/tok',
  preview: 'http://127.0.0.1:1/m/preview',
};

test('a web item rides the same scene layer, with its own ready reason', () => {
  const before = computeLayerState({ item: liveWeb, sceneReady: false });
  assert.equal(before.showScene, true, 'Web 走实时层（引擎的沙箱 iframe）');
  assert.equal(before.showVideo, false);
  assert.equal(before.showPoster, true, '就绪之前用预览图占位');
  assert.equal(before.reason, 'live-first-frame-pending');

  const after = computeLayerState({ item: liveWeb, sceneReady: true });
  assert.equal(after.showScene, true);
  assert.equal(after.showPoster, false, '就绪后预览图消失（挂载 resolve 即视为首帧）');
  assert.equal(after.reason, 'web-live');

  const noPayload = computeLayerState({ item: { ...liveWeb, media: null } });
  assert.equal(noPayload.showScene, false);
  assert.equal(noPayload.reason, 'live-no-payload', '没有载荷时退回预览图，而不是黑屏');
});
