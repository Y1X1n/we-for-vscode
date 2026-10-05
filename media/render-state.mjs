/**
 * Layer state machine — pure, so the bug it exists to prevent stays fixed.
 *
 * The bug: the wallpaper preview was rendered as an <img> that came *after* the
 * <video> in the DOM, so it painted on top of the playing video, and it was also
 * set as the <video poster> attribute. For two of the four Video wallpapers on
 * this machine the preview is an animated GIF, so what the user saw was a looping
 * low-frame-rate overlay — reported as "the video keeps the first frame".
 *
 * The rule this encodes follows upstream's intent ("首帧之前不留黑屏" — no black
 * screen before the first frame) without the residue: the preview is a
 * placeholder *behind* the video, and it must disappear as soon as a real frame
 * has painted. There is no state in which both the live video and the preview
 * are deliberately visible.
 */

/**
 * @param {object} input
 * @param {object|null} input.item           inventory item (renderMode/media/preview)
 * @param {boolean} input.paused             user asked for pause
 * @param {boolean} input.visible            webview panel is visible (occlusion pause)
 * @param {boolean} input.focused            window has focus (occlusion pause)
 * @param {boolean} input.hasPaintedFrame    a real video frame has been decoded
 * @param {boolean} input.videoFailed        the <video> element errored
 * @param {boolean} input.sceneReady         the scene renderer reported its first frame
 */
export function computeLayerState(input) {
  const {
    item,
    paused = false,
    visible = true,
    focused = true,
    hasPaintedFrame = false,
    videoFailed = false,
    sceneReady = false,
  } = input || {};
  const hasPreview = Boolean(item && item.preview);

  if (!item) {
    return { showVideo: false, showScene: false, showPoster: false, shouldPlay: false, reason: 'no-item' };
  }

  if (item.renderMode === 'video' && item.media) {
    if (videoFailed) {
      // Degrade to the still preview rather than a black stage.
      return { showVideo: false, showScene: false, showPoster: hasPreview, shouldPlay: false, reason: 'video-failed' };
    }
    return {
      // The preview is a placeholder only until a frame exists.
      showVideo: true,
      showScene: false,
      showPoster: hasPreview && !hasPaintedFrame,
      shouldPlay: !paused && visible && focused,
      reason: hasPaintedFrame ? 'playing' : 'first-frame-pending',
    };
  }

  if (item.renderMode === 'scene' || item.renderMode === 'web') {
    if (!item.media) {
      // The payload could not be registered (dir outside the allowed roots, server
      // not started, …). Degrade to the still preview: the alternative is a black
      // stage, which is the one outcome this state machine exists to prevent.
      return { showVideo: false, showScene: false, showPoster: hasPreview, shouldPlay: false, reason: 'live-no-payload' };
    }
    // Same rule as video, but readiness cannot be observed directly: the renderer
    // runs in a cross-origin iframe, so it *tells* us (see the injected probe in
    // src/we/engine.ts) once its frame counter moves. Until then the preview stays
    // visible — the engine page paints #000, so revealing it early is a black flash.
    return {
      showVideo: false,
      showScene: true,
      showPoster: hasPreview && !sceneReady,
      shouldPlay: !paused && visible && focused,
      reason: sceneReady ? (item.renderMode === 'web' ? 'web-live' : 'scene-live') : 'live-first-frame-pending',
    };
  }

  if (item.renderMode === 'poster') {
    return { showVideo: false, showScene: false, showPoster: hasPreview, shouldPlay: false, reason: 'poster-only' };
  }

  // Application wallpapers are never rendered (upstream ADR-0001 D4).
  return { showVideo: false, showScene: false, showPoster: false, shouldPlay: false, reason: 'not-renderable' };
}

/** Play/pause button label, kept next to the state it describes. */
export function playButtonLabel(layer) {
  const live = layer && (layer.showVideo || layer.showScene) && layer.shouldPlay;
  return live ? '暂停' : '播放';
}
