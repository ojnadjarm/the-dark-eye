# Phase B Spec — The Field (Jack In)

*Historical (Windows-era, D9). Superseded by `PLAN-UBUNTU.md` and `PLAN-LOWRES.md`; the shipped look is `spec/eye-reference.html`, ported in `body/render`. Kept unrewritten.*

> A second way to talk to your agents. The Eye is the ambient interface —
> a glance and a voice over the desktop. The Field is the immersive one —
> a 3D place you enter, where agents take form and show you things in
> real time. Same agents, same bridge, two interfaces.

Status: DRAFT v4 — 2026-08-19, reconciled after adversarial review.
Oscar's five calls that shaped this draft:
(1) the Eye and the Field are two different interfaces to the same agents;
(2) VR only for now — AR parked until the platforms actually ship it;
(3) the old Tower world was demo scaffolding — re-spaced freely;
(4) local-only for the MVP;
(5) it's an interface — don't make it more complicated than it is.

Live concept demo (v5, iterated at the same URL):
https://claude.ai/code/artifact/bc48cc4e-6a51-4047-b12d-2715028e6d8b
Demo source: `spec/field-demo.html`.

History: v1 2D Matrix rain → v2 3D field with Tower (2026-08-11) →
v3 Tower dropped, shapeshifter + design-discussion purpose + multi-lens
(2026-08-19) → v4 this draft (same day).

## 1. What it is

- **An interface, served as a web page.** One live three.js scene. Opened
  in a desktop browser today; a Quest opens the same URL in VR later. The
  Electron body may embed it as a flat lens but can never BE the VR window
  — Electron ships no immersive WebXR (electron/electron#35011).
- **The main agent is a shapeshifter.** One glyph mass that takes any
  form — eye, figure, hound, ghost, wave — and grows more. No monuments.
- **Purpose: real-time visual conversation.** Discussing designs: summon a
  tableboard and put waves or plots on it, conjure forms, morph them as
  the conversation moves. His frame: "a game engine but also a real-time
  field."
- Voice keeps flowing through the Eye (existing push-to-talk + hub
  routing). The Field is the visual half of the same conversation.

## 2. The law (lean)

1. Nothing appears unless an agent or Oscar asked for it. Asked-for
   content is a real cause; unrequested decoration stays illegal.
2. Empty field = honest field.
3. Where status is shown, color is status: green working · red the call ·
   gold done/dissolved. Conjured content is content, not status — a red
   car is just a red car.
4. The field never opens by itself.

## 3. The world — Matrix skin (main theme)

- Infinite grid fading into fog, 3D glyph rain. In this skin everything
  is woven from Matrix characters — the shapeshifter, the board, the
  glitches.
- **Forms are TRUE 3D** (his call, 2026-08-19, on seeing the flat MVP:
  "forms shouldn't be 2D in a 3D world"): real meshes (glTF, CC0/CC-BY,
  attributed in `field/assets/`) surface-sampled into glyph particle
  bodies — load a 3D dog, transform it into the Matrix hound. Forms: eye
  (default, procedural), hound, figure, ghost, wave — grow the bestiary
  from real models.
- **Quality bar:** the field must read as a designed engine, not a school
  project — glyph-atlas instanced shader, bloom, fog, a scene that
  survives orbiting from any angle. The v5 demo's flat outlines were
  proof-of-concept only.
- **Tableboard = a TV in the world** (his call, 2026-08-19): the world is
  Matrix, but what plays ON the board is content — real graphs, charts,
  images, anything an agent needs to show. Glyph modes (waves, lissajous,
  bars — MVP-validated and approved) are just one channel; real content
  renders as a texture on the plane, pushed over the bridge. No forced
  glyphification of content.
- **Conjured forms:** procedural/wireframe primitives now (cube, torus,
  ...). Real assets later (§5).
- Dissolve is always gold.

## 4. Architecture (MVP — local only)

- **The Field is its own application** (his call, 2026-08-19): a standalone
  server + web page, separate from the Eye's Electron body. It lives at
  `field/` in this repo, runs in WSL (Node) as a real npm project with
  three.js as a true dependency, owns its scene truth, and keeps running
  whether or not the Eye is up. The Eye carries NO field code. Windows browsers reach it
  via WSL2 localhost forwarding.
- The page owns the render; the field server owns scene state (current
  form, board mode, conjured shape). Late-opening pages receive the
  current state on connect.
- Small field ops as tiny JSON: spawn / morph / board / conjure / dismiss,
  driven from any brain via the bridge client. Push to open pages over
  SSE.
- The Eye and the Field are two clients of the same agents — neither
  contains the other. Shared secret auth on both; local machine only for
  the MVP. Exposing to LAN/headset is a later, deliberate decision.
- No perf ceremony at this scale: procedural ops are one POST + client
  render. Budgets matter when real assets arrive, not before.
- **The spatial reference** (his call, 2026-08-23: "the field must have a
  good reference of the surroundings — size, positions, camera angles;
  the agent's camera is different from the user's, and agents need
  both"). The world looks infinite but has a real, named frame, and
  agents perceive it through three channels:
  1. **The world atlas** — `__SCENE_STATE__().world` + `.landmarks`:
     units (wu), +Y up, origin at grid center, grid cells 60/300 wu,
     ground plane 4200, fog 700→1800, and every landmark (board,
     conjured, avatar bbox) with position and size. Space is stated,
     never guessed.
  2. **The agent's own eye** — `__AGENT_VIEW__({yaw,pitch,dist | pos,
     target, fov})`: an offscreen render from ANY angle, moved at will,
     returned as PNG + pose. Never touches the user's canvas. Optional
     overlay draws axes + landmark labels into the agent's image only.
     `preset: "top"` = orthographic map (north = -Z up the image) —
     spatial relations become 2D reading instead of perspective
     guessing.
  3. **The user's perspective** — `__SCENE_STATE__().camera` (pos,
     target, fov, what's on the user's screen in NDC) plus the page
     screenshot. Agents always know what the user is seeing, and can
     tell their own view apart from the user's.
  4. **The camera law** (his call, 2026-08-23): the user's camera NEVER
     moves on its own — auto-rotate is dead. The one exception is the
     agent's `look` op (glide his view to frame board / avatar /
     conjured / center / a point), which exists because he asked for
     it — and his drag cancels the glide instantly. His hand always
     wins.

## 5. Later (parked until a real conversation starves for it)

- Quest 3 VR lens — same URL; needs the HTTPS/secure-context + LAN
  decision made on purpose.
- Themes as skins: a "real" PBR skin beside Matrix. Glyphifying arbitrary
  meshes is a design problem, not a shader toggle.
- Agents present real assets: glTF/.glb pipeline ("design this car" →
  asset in ~30s–minutes via cloud text-to-3D → materializes in-field).
- AR passthrough: Quest today, Vision Pro when Safari ships immersive-ar.
- Specters/subagent presence + the Gaze in-world (from v2) — re-enters
  when agent-watching becomes a field activity, redesigned without the
  Tower.
- **Voice in the Field** — BUILT 2026-08-23, self-contained (his call:
  "the field is a completely different app"): browser mic (`voice ●`
  button → SSE `voice` op → any listening agent) and browser TTS
  (`field say`). No Eye involved. Still later: headset mic, better
  voices, hands-free wake.
- **Summon anything** — PARTLY BUILT 2026-08-23: `field summon` takes
  arbitrary wireframe geometry (any form an agent can write, ≤340
  edges — first: a DNA double helix generated on request), and
  `field tv` puts any image on the board (the TV is real; first
  broadcast: a poverty chart drawn from model memory, labeled so).
  Still later: solid/textured meshes, and SOUND (agent-conjured audio
  in the world).
- **Locomotion** — avatars that actually move through the world (his
  call 2026-08-19: MVP = good IDLE animations only; walking-in-place
  rejected — movement comes later, done properly).
- **ENDGAME (his words, 2026-08-19, on seeing the real engine): a world
  the agent can construct** — terrain, structures, spaces; the field as
  a constructible world, not a fixed stage.
- Voice input from inside a headset.

## 6. The MVP slice

Oscar opens `/field` in a browser, talks to a session through the Eye as
usual, asks for a board with waves and a conjured form, watches them
appear in real time, says dismiss, sees gold, closes the tab. Reading
nothing.

## 7. Working method

Concept demos in the artifact (same URL, iterated live) are the design
tool: discuss near-real-time, see it, reshape it. Spec files record what
the demo settles.
