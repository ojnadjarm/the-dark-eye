/**
 * The phone's ear: the Int16 blocks the page streams while he records, kept in
 * one growing buffer and read by a partial ear of its own, so his words appear
 * on the page as he says them. One utterance at a time — he has one thumb — and
 * the buffer is let go on the final tap or after it has been idle too long.
 * Nothing here touches the local mic or the TV caption: a turn from the phone
 * is not in the room.
 */
/** 10 MB of Int16 at 16 kHz — ~312 s, the one cap a turn has; the upload route takes it too. */
const MAX_SAMPLES = 5_000_000;
/** A stream nobody finalised: the page left, the tunnel died. */
const IDLE_MS = 120_000;
const FIRST = 1 << 16;

/**
 * `{push, close, live}`. `makeEar({read, onText})` builds the ear over the
 * buffer; `onPartial(utt, text)` is the whole growing line, not the delta.
 */
function createRemoteEars({
  makeEar,
  onPartial = () => {},
  maxSamples = MAX_SAMPLES,
  idleMs = IDLE_MS,
  timers = { setTimeout, clearTimeout },
  log = () => {},
} = {}) {
  let live = null;

  function drop(why) {
    if (!live) return;
    timers.clearTimeout(live.timer);
    live.ear.stop();
    log(`remote utterance ${live.utt} ${why}`);
    live = null;
  }

  /** The live utterance for `utt`, opening one (and closing any other) if needed. */
  function open(utt) {
    if (live && live.utt === utt) return live;
    if (live) drop("abandoned for a newer one");
    const u = { utt, buf: new Float32Array(FIRST), len: 0, next: 0, held: new Map(), heldLen: 0, line: "", timer: null };
    u.ear = makeEar({
      // the ear reads the clip as it grows, exactly as it reads the local mic
      read: (from) => u.buf.subarray(Math.min(from, u.len), u.len),
      onText: (text, append) => {
        u.line = append && u.line ? `${u.line} ${text}` : text;
        onPartial(u.utt, u.line);
      },
    });
    u.ear.start();
    live = u;
    return u;
  }

  function append(u, s) {
    if (u.len + s.length > u.buf.length) {
      let cap = u.buf.length;
      while (cap < u.len + s.length) cap *= 2;
      const grown = new Float32Array(cap);
      grown.set(u.buf.subarray(0, u.len));
      u.buf = grown;
    }
    u.buf.set(s, u.len);
    u.len += s.length;
  }

  const touch = (u) => {
    timers.clearTimeout(u.timer);
    u.timer = timers.setTimeout(() => drop("went idle — dropped"), idleMs);
    u.timer?.unref?.();
  };

  return {
    /**
     * One streamed block, appended in `seq` order — a block that overtakes its
     * neighbour waits for it. False means the cap is spent and the caller
     * should answer 413.
     */
    push(utt, seq, samples) {
      const u = open(utt);
      touch(u);
      if (u.len + u.heldLen + samples.length > maxSamples) return false;
      if (seq < u.next) return true; // a retry of a block already in
      u.held.set(seq, samples);
      u.heldLen += samples.length;
      for (let s; (s = u.held.get(u.next)); u.next++) {
        u.held.delete(u.next);
        u.heldLen -= s.length;
        append(u, s);
      }
      return true;
    },

    /**
     * The final tap: the whole clip and the ear that has been reading it, and
     * the buffer is let go. `null` when nothing was ever streamed for `utt`.
     */
    close(utt, tail) {
      if (!live || live.utt !== utt) return null;
      const u = live;
      if (tail?.length) append(u, tail);
      timers.clearTimeout(u.timer);
      u.ear.stop();
      live = null;
      return { samples: u.buf.subarray(0, u.len), ear: u.ear };
    },

    /** `{utt, samples}` of the one in flight, for a log line or a test. */
    get live() {
      return live ? { utt: live.utt, samples: live.len } : null;
    },
  };
}

module.exports = { createRemoteEars, MAX_SAMPLES, IDLE_MS };
