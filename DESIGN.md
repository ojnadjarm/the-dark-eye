# The Dark Eye

> An omniscient presence that watches, judges, and acts — now with a body.

Oscar's own Jarvis/Cortana: a voice-first AI assistant wearing the DarkSaddler
persona, living as an ethereal presence on the desktop, with its subagents
visible inside a Matrix-datastream world you can jack into.

**Thesis:** in the agent era, talking beats writing. You don't read the work —
you watch it happen and ask about it out loud. *Visibility replaces review.*

## Architecture (the spine)

**Core principle: the body is an HTTP bridge any curl-class client speaks.**
Six routes on `127.0.0.1:8642` behind a shared secret — speak, listen, mic,
status, show, health — and that is the whole contract. A brain is anything that
can run `curl`: the Claude orchestrator session, a fleet agent, a shell script,
a local model with a loop. The brain is a plug, not a foundation, and the body
never depends on which one is holding the other end.

```
 TV ◄── node body: eye-render overlay + canvas + voice worker (Parakeet in, Kokoro out)
            ▲  bridge :8642 — speak · listen · mic · status · show · health
            │
      any brain that can curl  ── the orchestrator today, via the /eye skill
```

- **One world, always running.** The Eye is the world at minimum zoom.
  Jacking in = same scene, fullscreen camera. Never a separate app to open —
  zero entry toll.
- **Three plug-agnostic pieces:** the body (the bridge), the hands (tools the
  brain already has), the soul (a prompt file any brain loads). Only the agent
  loop is per-brain.
- **Agent visibility rides the same bridge:** brains report activity with
  `status` calls; the eye renders whatever it is told. A brain that reports
  nothing still talks — degraded gracefully.
- **The body owns the hardware** — mic, speakers, screen. Nothing else touches
  audio.

## The Field (interior — see spec/B-the-field.md)

An infinite digital field, and everything on it is *true*:

- **DarkSaddler = the Tower** — a dark spire, the Eye burning at its top.
- **Subagents = specters** — particle ghosts that rise when dispatched,
  glitch reality around them while working (the static carries their real
  file paths and tool names), dissolve gold when done.
- **The Gaze = the Call:** when an agent needs approval, the Eye turns red
  and its beam holds that specter — visible from anywhere, even the knot.
- **Detail is voice:** focus a specter and ask; DarkSaddler answers out
  loud. Reading is never the interface.
- The field scales: corner knot over the desktop (Eye mode) → fullscreen
  world (jacked in). Same simulation, two zooms.

## Persona

DarkSaddler, ported from Hermes `SOUL.md`: sharp, no filler, no emoji,
opinionated, pushes back. Not a bot — an Eye.

## Build slices (in order, each one usable on its own, done when done)

1. **It talks** — SDK loop + soul + mic → whisper → Claude → TTS → speakers.
   No graphics. Jarvis is already real at the end of this slice.
2. **The Eye appears** — a transparent click-through overlay, glyph-knot Eye in
   the corner, speaks, flickers with agent activity. Shipped in Electron, then
   ported to `eye-render` (Rust) for the idle cost — `PLAN-LOWRES.md`.
3. **Jack in** — fullscreen datastream, agent columns, ask-by-voice targeting.
4. **Hands** — real assistant duties: files, calendar and email through the
   brain's own tools, running agents on Oscar's projects.

Rule inherited from every dead project before this one: **it talks before it's
pretty.** No silent build phases.
