# Research Digest: Elevating the Glyph Eye (2D canvas, transparent Electron overlay)

*Historical (Windows-era, D9). Superseded by `PLAN-UBUNTU.md` and `PLAN-LOWRES.md`; the shipped look is `spec/eye-reference.html`, ported in `body/render`. Kept unrewritten.*

Scope: visual-quality techniques for the existing katakana cat-eye. Concept stays; execution gets professional.

---

## 1. What separates amateur from professional canvas glyph art

**The single biggest tell is tonality, not geometry.** Rezmason's reference Matrix implementation
(https://github.com/Rezmason/matrix) is explicit: "Matrix symbols aren't just some shade of
phosphorous green; they're first given a bloom effect, and then get tone-mapped to the green
color palette." Amateur versions draw one green at varying globalAlpha; professional versions
have a *palette curve* — the brightest glyphs desaturate toward white-green, mids are saturated
green, dims slide toward dark blue-green. A 4-5 step brightness LUT applied per glyph, instead
of one color faded by alpha, is the cheapest possible upgrade with the biggest perceptual jump.

**Brightness hierarchy.** Frame-by-frame film analysis (https://carlnewton.github.io/digital-rain-analysis/)
found: only the *leading* glyph of a string is highlighted, only ~1 in 5 strings has a highlight
at all, and glyphs *mutate in place* (a glyph changes to another glyph every ~3 frames, briefly
showing both at 50% during the swap) rather than moving. Rezmason confirms: "The 2D glyphs are in
a fixed grid and don't move. The 'raindrops' are simply waves of illumination of stationary
symbols." Transfer to the eye: glyphs keep their stations on the eyelid curve; a *brightness wave*
travels along the curve (sawtooth with modulated width, per Rezmason); individual glyphs
occasionally mutate in place. Restraint (most glyphs dim, few bright) reads as professional;
uniform brightness reads as clip-art.

**Temporal persistence (trails).** The classic rain trail is `fillRect` of `rgba(0,0,0,0.05)`
each frame (https://dev.to/javascriptacademy/matrix-raining-code-effect-using-javascript-4hep)
— but that only works on an opaque canvas. On a transparent overlay the equivalent is: render
glyphs into an *offscreen* buffer, and each frame decay that buffer toward transparency with
`globalCompositeOperation = 'destination-out'` + a low-alpha fillRect (~0.08-0.15), then
composite the buffer to the visible canvas (https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/globalCompositeOperation).
Known gotcha: 8-bit alpha rounding makes very low alphas "stick" and never reach zero, leaving
faint ghosting (discussed in https://github.com/Automattic/node-canvas/issues/1413) — mitigate
with a periodic stronger wipe (e.g. every ~30 frames use alpha 0.5) or keep decay alpha >= ~0.1.
This is blind-debuggable: the failure mode is visible residue, not a crash.

**Glow: never shadowBlur per frame.** MDN's optimization guide says flatly "Avoid the shadowBlur
property whenever possible" (https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)
— it is one of the most expensive 2d ops, especially stacked ~110 times/frame. The professional
pattern: pre-render glyphs *with glow baked in* to a sprite atlas once (shadowBlur is fine at
atlas-build time), then blit with drawImage.

**Sprite atlas: it's about quality control, not just speed.** Benchmarks show per-glyph bitmap
caching of *plain* text is roughly a wash vs fillText (0.91-0.98x, https://github.com/coder/ghostty-web/issues/163),
while caching rendered output as bitmaps gave 10ms->1ms wins in string-level tests
(https://www.mirkosertic.de/blog/2015/03/tuning-html5-canvas-filltext/). The decisive case is
ours: each atlas sprite carries baked glow + palette tier, which would otherwise cost a
shadowBlur per draw. Atlas = glow for free, deterministic anti-aliasing, and 110 drawImage
calls/frame is trivial at 60fps. Atlas size: ~50 katakana x 5 brightness tiers x 2x DPR is a
single small offscreen canvas built at startup.

**Motion: noise, not sinusoids or constant velocity.** Constant angular velocity is the
"screensaver" tell. Perlin/simplex noise "has the same general look and feel as a sine wave but
is not as regular," and is the standard tool for breathing/idle/organic drift
(https://varun.ca/noise/, https://thebookofshaders.com/13/). Feed a 1D simplex stream into flow
speed, glyph mutation rate, and brightness-wave spawn timing. Also: ease every state change
(300-600ms), never snap parameters.

**Grain/scanlines: last, subtle, masked.** CRT-emulation practice: grain goes on *last* (grain
over scanlines reads as tape; under reads as fake) and effects stay subtle (https://datagubbe.se/crt/).
Given the hard constraint (nothing may reach window bounds), any grain/scanline must be masked
to the eye shape — safest as *modulation of glyph brightness by row parity* rather than drawn
overlay lines.

## 2. What transfers from Rezmason's Matrix, what needs WebGL

Transfers directly to 2d canvas:
- Fixed-grid glyphs + traveling illumination waves (sawtooth, modulated teeth widths).
- Glyph cycling in place; palette tone-mapping approximated by the pre-baked brightness-tier atlas.
- `bloomSize`/`bloomStrength` as design parameters — in 2d these become baked glow radius and
  `'lighter'` compositing strength.

Requires WebGL2: MSDF glyph atlases (msdfgen), true HDR bloom (bright-pass + downsample chain),
per-pixel tone-mapping curves. Verified: WebGL *does* composite correctly in transparent Electron
windows on Windows — working example https://github.com/jeromeetienne/electron-threejs-example
(renderer `alpha: true`, clear color alpha 0, body background transparent); watch
`premultipliedAlpha` since browser compositing defaults to premultiplied
(https://webglfundamentals.org/webgl/lessons/webgl-and-alpha.html). Transparent windows already
pay the DXGI_ALPHA_MODE_PREMULTIPLIED DWM cost regardless of canvas type
(https://github.com/electron/electron/pull/39895). Verdict: WebGL2 is a *viable escalation
path*, not required — everything the 340x380 eye needs is achievable in 2d, and blind
debugging (no DevTools) strongly favors the simpler 2d pipeline.

## 3. Bloom that stays inside the shape

Three techniques, all structurally incapable of touching the window edge:
1. **Per-glyph baked glow** (atlas): glow radius 4-8px baked into each sprite; falloff ends at
   sprite bounds by construction. Composite bright tiers with `'lighter'` so overlapping glyphs
   sum, which *is* poor-man's bloom.
2. **Downscale/upscale bloom buffer**: draw only the bright-tier glyphs to a quarter-res
   offscreen sized to the eye's bounding box, blur (2x downscale gives ~5-6x cheaper blur for
   equivalent look — 3.3ms vs 0.55ms at 512px in measurements: https://github.com/piellardj/post-treatment-gpu),
   upscale-composite with `'lighter'`. Because the offscreen is *smaller than the eye region*,
   glow physically cannot reach window bounds. `ctx.filter = 'blur(px)'` is GPU-backed in
   Chromium and fine once per frame on a small buffer.
3. **Shape-masked falloff**: if a soft inner ambiance is wanted, draw the radial falloff into a
   small offscreen and `'destination-in'` it against the eye silhouette before compositing.
   The mask guarantees zero alpha outside the eyelid curve.

## 4. Organic "alive" motion for an ambient companion

Robotics/avatar research (Disney's gaze work, https://la.disneyresearch.com/wp-content/uploads/root.pdf;
autonomous-avatar literature, https://arxiv.org/pdf/1903.05448) converges on *layered* idle
motion: breathing + saccades + attention, composed additively. Key findings:
- **Micro-saccades sell life more than anything else.** Eyes don't glide; they *jump* to a new
  fixation (ease-out, ~80-150ms) then hold with tiny tremor. For the eye: shift the iris ring +
  slit cluster 1-3px toward a random fixation point at Poisson-ish intervals (1-4s), snappy
  ease-out, then micro-tremor from low-amplitude noise. No blinking needed — saccades alone
  carry the effect (and blinking is banned anyway).
- **Breathing**: slow (~0.1Hz) amplitude modulation. Since eyelid aperture change could read as
  blinking, breathe *brightness and glow strength* instead of geometry — the whole eye gently
  swells in luminance, ±10% max, driven by noise-modulated sine so it never metronomes.
- **State grammar** (idle / listening / thinking / speaking) is the modern voice-orb standard —
  distinct color, glow, and motion per state with interpolated transitions and audio-level
  smoothing (https://github.com/xqetsia/VoiceOrb, https://smoothui.dev/docs/components/siri-orb).
  Map to the eye: idle = slow mutation + dim palette + rare saccades; listening = faster
  mutation + expanding rings (already built) + brighter tier ceiling; speaking = fastest
  mutation + brightness waves synced to output. "Idle" must stay *visibly* alive but below
  attention threshold — the keep-alive principle (https://arxiv.org/pdf/1904.02898).

## 5. Text rendering quality on Windows

- **Consolas has no katakana.** Every katakana in "13px Consolas" is per-glyph *fallback* to a
  system Japanese font chosen by Chromium — and that choice has shifted between MS Gothic and
  Meiryo across versions (https://github.com/microsoft/vscode/issues/84774). The current glyph
  shapes are therefore accidental. Fix: name the font explicitly. `"MS Gothic"` gives sharp,
  terminal-feeling glyphs and covers *half-width katakana* (U+FF66-FF9D) — the narrower forms
  that match the film's condensed look; Meiryo is the ClearType-tuned smoother alternative
  (https://en.wikipedia.org/wiki/Meiryo). Best-practice: bundle a font via @font-face in the
  Electron app (Noto Sans JP, or a Matrix-style display font) for fully deterministic rendering
  — trivial in Electron, zero fallback risk.
- **devicePixelRatio is likely the #1 sharpness bug.** Windows commonly runs 125-150% scaling;
  a 340x380 canvas with a 1:1 backing store is upscaled and blurred by the compositor. Fix:
  `canvas.width = 340 * devicePixelRatio`, CSS size stays 340px, `ctx.scale(dpr, dpr)`
  (https://www.kirupa.com/canvas/canvas_high_dpi_retina.htm). Combined with atlas sprites
  rendered at 2x, glyphs go from soft to razor-sharp. This alone may account for much of "raw."
- **Integer snapping**: MDN recommends whole-pixel drawImage coordinates — sub-pixel blits are
  slower and softer (https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas).
  Snap blit positions to *device* pixels; at 2x DPR that is half-CSS-pixel granularity, so
  motion still looks smooth.

Perf reality check: ~110 glyphs/frame as integer-snapped drawImage blits from one atlas +
one destination-out decay pass + one small bloom buffer is comfortably within 60fps CPU-canvas
budget at 680x760 device pixels; it *removes* per-frame fillText and never touches shadowBlur.

---

## Three visual directions (ranked by quality gain / risk)

### 1. "Phosphor Discipline" — the craft pass
**Pitch:** Same eye, but every glyph razor-sharp and lit like a real phosphor display instead of flat green.
**Techniques:** (a) devicePixelRatio-scaled backing store; (b) explicit/bundled Japanese font,
half-width katakana; (c) startup-built glyph sprite atlas with 4-5 baked brightness tiers
(white-hot -> saturated green -> dim blue-green) and baked per-glyph glow; (d) `'lighter'`
compositing for bright tiers; (e) leading-bright-glyph hierarchy — brightness waves travel the
eyelid curve, ~1 in 5 waves highlighted; (f) glyph mutation-in-place every few frames.
**Risk:** Low — all techniques are build-time or drop-in replacements; failure modes are visible,
not silent; no new buffers to debug blind.
**Perf:** Neutral to better — drawImage replaces fillText, shadowBlur never runs at frame time.

### 2. "Afterimage" — persistence and life
**Pitch:** The eye stops animating and starts breathing — glyphs leave fading phosphor trails and the gaze flicks and settles like something is looking back.
**Techniques:** (a) offscreen trail buffer with `destination-out` alpha decay (+ periodic strong
wipe against 8-bit residue); (b) 1D simplex noise driving flow speed, mutation rate, and wave
spawn timing; (c) micro-saccades — iris/slit cluster jumps 1-3px with ease-out then holds with
tremor; (d) luminance breathing at ~0.1Hz, noise-modulated; (e) eased 300-600ms state
transitions between idle/listening/speaking parameter sets.
**Risk:** Medium — buffer decay and saccade tuning need blind iteration; ghosting residue is the
known trap (mitigation documented above).
**Perf:** Low addition — two full-buffer composites per frame at 680x760, noise eval is cheap.

### 3. "Signal Bleed" — the CRT dressing
**Pitch:** A faint broadcast-monitor haze — bloom that hugs the glyphs, a whisper of color fringe on the hottest ones, grain living only inside the eye.
**Techniques:** (a) quarter-res bloom buffer over bright tiers only, masked to the eye's
bounding box, `'lighter'` composite; (b) chromatic fringe pre-baked into the hottest sprite tier
only (1px red/blue offset copies at 'screen' — atlas-time, zero frame cost); (c) film grain as
low-alpha noise masked by `'destination-in'` to the eye silhouette, applied last; (d) scanline
feel via row-parity brightness modulation of glyphs, not drawn lines; (e) inner falloff vignette
drawn on a small offscreen so it cannot reach window bounds.
**Risk:** Medium-high — pure taste risk: every one of these is easy to overdo and hard to judge
without live viewing; the bloom mask must be verified to fade fully inside bounds (the old
window-edge bug's territory). Do this *after* directions 1-2, at half the intensity that seems right.
**Perf:** Moderate — one extra blur pass on a small buffer, one grain composite; still in budget.

**Recommended order: 1 -> 2 -> 3.** Direction 1 fixes "raw" at its root (sharpness + tonality),
2 adds the "alive" quality that makes companions feel professional, 3 is seasoning to apply
sparingly once the foundation reads clean.
