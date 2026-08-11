# The Dark Eye

> An omniscient presence that watches, judges, and acts — now with a body.

Oscar's own Jarvis/Cortana: a voice-first AI assistant wearing the DarkSaddler
persona, living as an ethereal presence on the desktop, with its subagents
visible inside a Matrix-datastream world you can jack into.

**Thesis:** in the agent era, talking beats writing. You don't read the work —
you watch it happen and ask about it out loud. *Visibility replaces review.*

## Architecture (the spine)

**Core principle: the body is an MCP server — model-agnostic by contract.**
Any MCP client (Claude Agent SDK, another framework, a local model with an
MCP-capable loop) can possess the Eye. The brain is a plug, not a foundation.
Same pattern as Navi's `notify` tool, scaled up.

```
┌─ Windows ─────────────────────────┐        ┌─ WSL2 ────────────────────────┐
│  Electron overlay ("the body")    │  MCP   │  Brain #1: Claude Agent SDK   │
│  = MCP server exposing:           │◄──────►│  (subagents, hooks, tools)    │
│   • speak(text, mood?)            │        │  Brain #N: anything MCP-      │
│   • listen() → transcript         │        │  capable (local model, etc.)  │
│   • agent_status(id, state, info) │        └───────────────────────────────┘
│   • the Eye + jack-in rain        │        Soul: DarkSaddler prompt file,
└───────────────────────────────────┘        loaded by whatever brain drives
     STT: faster-whisper · TTS: Piper/Kokoro (local, inside the body)
```

- **One world, always running.** The Eye is the world at minimum zoom.
  Jacking in = same scene, fullscreen camera. Never a separate app to open —
  zero entry toll.
- **Three model-agnostic pieces:** the body (MCP server), the hands (tools as
  MCP servers), the soul (a prompt file any brain loads). Only the agent loop
  is per-brain — Claude Agent SDK is brain #1 because it gives subagents,
  hooks, and permissions for free, not because anything depends on it.
- **Agent visibility rides MCP too:** brains report activity via
  `agent_status` calls; the rain renders whatever it's told. A brain that
  reports nothing still talks — degraded gracefully.
- **Body owns the hardware** (mic/speakers/screen, on Windows — WSL2 never
  touches audio). Same split as Navi, already shipped once.

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
2. **The Eye appears** — Electron transparent overlay, glyph-knot Eye in the
   corner, speaks, flickers with agent activity.
3. **Jack in** — fullscreen datastream, agent columns, ask-by-voice targeting.
4. **Hands** — real assistant duties: files, calendar/email via MCP, running
   agents on Oscar's projects.

Rule inherited from every dead project before this one: **it talks before it's
pretty.** No silent build phases.
