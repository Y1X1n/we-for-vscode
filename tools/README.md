# tools/

Reproduction harnesses for the whole-window layer (`方案 B`). They exist because the
patched workbench document is the one place where a silent failure looks exactly like
"this wallpaper just does not work": the page runs `require-trusted-types-for 'script'`
plus a fixed `trusted-types` allowlist, and a refused frame or a refused module import
produces no visible error anywhere the extension can read.

Both scripts stand up the real media server from `out/`, serve a page carrying the
patched `workbench.html`'s **verbatim CSP** (including Trusted Types), drive it in
headless Edge/Chrome, and print the mount lifecycle it reports to `/probe`.

```powershell
npm run compile                            # they import from out/
node tools/check-workbench-scene.mjs 1     # Scene: blob import -> mount -> canvas frame
node tools/check-workbench-web.mjs 0       # Web: same-origin stub -> engine -> author frames
```

Both need a local Wallpaper Engine library (they scan it through `WallpaperService`),
and `check-workbench-web.mjs` uses the offscreen `itemIndex` into the Web wallpapers it
finds. Captured output goes to `tools/.shots/` (git-ignored).

What each one is actually pinning down:

| Script | The claim it verifies |
|---|---|
| `check-workbench-scene.mjs` | A Scene mounts under the real CSP via blob-URL import, and the canvas holds real pixels (a JPEG frame, not a black rectangle). |
| `check-workbench-web.mjs` | The parent document **cannot** frame the engine's `blob:` author iframe (`frame-src` refuses it — the negative control is in the output), while the same-origin stub **can**, and the author page really paints (its shim's `we-frame` heartbeats arrive). |

The measured results behind these decisions are documented in the source:
`src/workbench/patch.ts` (`buildWebStubHtml`, `buildWebStubJs`, `mountWeb`, `mountScene`).
