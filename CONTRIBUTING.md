# Contributing

## Everything lands through a pull request

`main` is protected by convention: **no direct commits or pushes to `main`**, including
for the maintainers. Every change — a fix, a feature, a README tweak — goes:

```powershell
git checkout -b feat/short-topic        # or fix/…, docs/…, perf/…
# …edit, then prove it:
npm run verify                          # tsc + node --test, must stay green
git commit -m "…"
git push -u origin feat/short-topic
gh pr create --fill                     # or open the PR in the browser
```

A PR is ready to merge when:

1. `npm run verify` is green, and any new behaviour has a test that would fail without it;
2. the PR body says **what was measured** for anything performance- or
   renderer-related (see below), not just what was changed;
3. user-visible behaviour changes are reflected in `README.md` *and* `README.en.md`
   (they are mirrors; a setting documented in one and not the other is a bug);
4. the packaged extension is still sane: `npx vsce package --no-dependencies` succeeds
   and `.vscodeignore` still keeps repository-only material out of the VSIX.

Releases are cut from `main` after the merge (`gh release create vX.Y.Z <vsix>`), with
the VSIX built from that commit.

## What this project asks of a change

The extension patches a checksummed file inside the VS Code installation and renders
third-party wallpaper code, so a few invariants are load-bearing. Tests pin them; a PR
that weakens one needs to say why.

| Invariant | Where it is defended |
|---|---|
| `workbench.html` stays byte-frozen after the first patch — an extension update must never rewrite it | `test/workbench-patch.test.mjs` (round trip, checksum table, cache-busting side file) |
| `stripPatch(injectPatch(x)) === x`, so disabling always restores the installation | same |
| The workbench CSP is widened only where a media element needs it; nothing widens `frame-src` for the loopback origin or `blob:` | `widenCsp` + its test, `tools/check-workbench-web.mjs` |
| Live layers degrade to the still preview instead of a black stage | `getComputedStyle`-free state machine in `media/render-state.mjs` (+ its tests) |
| Silent renderer failures stay visible: every mount path reports to `/probe` | the `reportLayer` / `web-*` trails, and the two replica harnesses in `tools/` |
| The panel webview and the extension host agree on the message contract, and every id it touches exists | `test/webview-contract.test.mjs` |

## Measuring performance claims

The renderer is shared with the editor UI, so "it feels heavier" is not good enough — a
claim about cost has to be attributable. Two scratch scripts (not shipped, but the
method matters) are what the current numbers were taken with:

- attribute CPU per Electron **process role** (`main` / `renderer` / `gpu-process` /
  `extensionHost`) rather than summing every `Code.exe` — other extensions otherwise
  dominate the number;
- alternate **A/B/A/B**, never A then B: this machine's noise band is ±5–8% of one core,
  which is larger than most of the effects being measured;
- measure the state you actually ship — a wallpaper that is live in two surfaces renders
  twice, and both instances share one main thread.

## Licence

By contributing you agree your work is released under the project's MIT licence
(see [LICENSE](LICENSE)).
