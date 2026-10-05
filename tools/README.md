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

## `perf-roles.ps1` — what a live layer actually costs

```powershell
.\tools\perf-roles.ps1 -Seconds 15 -Label "both live"
```

CPU and GPU per Electron **process role** (`main` / `renderer` / `gpu-process` /
`extensionHost`), parsed from each `Code.exe` command line. Two rules make the numbers
mean something, and skipping either produces a confidently wrong answer:

1. **Attribute by role, never by "all Code processes"** — other extensions otherwise
   dominate the total (this machine idles around 27% of one core with no wallpaper live
   at all, and around 45% with a heavy scene, so the wallpaper is a minority term).
2. **Alternate A/B/A/B**, never A-then-B: the noise band here is ±5–8% of one core,
   wider than most of the effects being measured.

Measured results and the decisions they drove are in the README's *Performance* section.

The measured results behind these decisions are documented in the source:
`src/workbench/patch.ts` (`buildWebStubHtml`, `buildWebStubJs`, `mountWeb`, `mountScene`).
