/**
 * The partial ear: while the mic is open, the words he has said so far are
 * decoded again and again as one growing window, so every partial is read with
 * its own context instead of alone. Only words two decodes in a row agree on
 * reach the caption, and they only ever get appended — the line never flickers.
 * A word old enough to be settled is frozen and cut out of the window, which is
 * what keeps the decode bounded and makes the final transcript cheap.
 */
const FRAME = 512; // 32 ms at 16 kHz
/** A frame louder than this is speech; room noise and an idle mic sit far below. */
const SPEECH_RMS = 0.01;
/** No frame reached `SPEECH_RMS` in this long: decode anyway, a quiet mic is not silence. */
const NO_ONSET_MS = 3000;
/** A caption redrawn over partials resolves this fast — the words were said already. */
const SETTLE_MS = 300;
/** Kept when the leading silence is dropped, so a word starting on the edge survives. */
const KEEP_MS = 300;
/** The first window: short, because the first words on screen are what he waits for. */
const FIRST_MS = 800;
/** No second decode until this much new audio exists — a window that barely grew says nothing new. */
const STEP_MS = 400;
/** A window this long has settled words at its head: freeze them and cut them out. */
const ANCHOR_MS = 4000;
/** Never frozen: the words in the last of the window still need their context. */
const SAFE_TAIL_MS = 1500;
/** Hard ceiling: a decode never reads more than this, whatever the mic has. */
const MAX_WINDOW_MS = 8000;
/** The share of one core the ear may burn while he speaks; the cadence follows from it. */
const BUDGET = 0.35;
/** A silent final tail this short is already in the last window: no decode at all. */
const REUSE_MS = 2500;
/** The cut lands in the quietest frame of the window's last stretch. */
const TAIL_MS = 400;
/** Audio kept in front of the anchor: a window that starts cold loses its first words. */
const LEAD_MS = 800;

function rms(s, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Where speech starts in `s`, or -1 while it is all silence. */
function speechAt(s) {
  for (let i = 0; i + FRAME <= s.length; i += FRAME)
    if (rms(s, i, i + FRAME) > SPEECH_RMS) return i;
  return -1;
}

/** Cut at the end of the quietest frame in the last `tailMs` — between words, not inside one. */
function cutIndex(s, rate, tailMs) {
  const tail = Math.max(0, s.length - Math.round((tailMs * rate) / 1000));
  let best = s.length;
  let quietest = Infinity;
  for (let i = tail; i + FRAME <= s.length; i += FRAME) {
    const r = rms(s, i, i + FRAME);
    if (r < quietest) {
      quietest = r;
      best = i + FRAME;
    }
  }
  return best;
}

/**
 * The words of a decode, each with the second it starts and the second it ends.
 * sherpa gives one entry per token — a token that opens a word carries a
 * leading space (or `▁`) — so the words are glued back together here. Without
 * timings the words are still the words; they simply can never be frozen.
 */
function timedWords(res) {
  if (typeof res === "string" || !res) {
    const t = (res || "").trim();
    return t ? t.split(/\s+/).map((w) => ({ w, at: null, to: null })) : [];
  }
  const { tokens, timestamps, durations = [] } = res;
  if (!Array.isArray(tokens) || !Array.isArray(timestamps) || tokens.length !== timestamps.length)
    return timedWords(res.text || "");
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const piece = String(tokens[i]).replace(/^[\s▁]+/, "");
    const to = timestamps[i] + (durations[i] ?? 0);
    if (!out.length || /^[\s▁]/.test(tokens[i])) out.push({ w: piece, at: timestamps[i], to });
    else {
      out[out.length - 1].w += piece;
      out[out.length - 1].to = to;
    }
  }
  return out.filter((x) => x.w);
}

/** A word as agreement sees it: the recogniser flips case and commas freely. */
function key(w) {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** How many words `a` and `b` open with in common. */
function agreedCount(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && key(a[i]) === key(b[i])) i++;
  return i;
}

/**
 * The caption already showing `shown`, now that the final text is `full`: the
 * words it does not have yet if `full` continues it, the whole line otherwise.
 * `null` when the caption already says it. A line redrawn over words that are
 * already up settles in `SETTLE_MS` instead of typing itself out a second time.
 */
function captionDelta(shown, full) {
  const a = shown.trim().split(/\s+/).filter(Boolean);
  const b = full.trim().split(/\s+/).filter(Boolean);
  if (!b.length) return null;
  const continues = a.length > 0 && a.length <= b.length && a.every((w, i) => w === b[i]);
  if (!continues) return { text: full, append: false, ms: a.length ? SETTLE_MS : undefined };
  const rest = b.slice(a.length);
  return rest.length ? { text: rest.join(" "), append: true } : null;
}

/**
 * `{start, stop, finalize, shown}`. Every `tickMs` it reads the clip captured
 * so far and, once speech has started, decodes the whole growing window from
 * its anchor to now through `decode(samples)`. Words the last two decodes agree
 * on go to `onText(text, append, ms)`; the settled head of the window is frozen
 * and the anchor moves past it. One decode at a time, and the next one waits
 * long enough that the ear averages `budget` of a core while he speaks.
 */
function createPartialEar({
  read,
  decode,
  onText = () => {},
  rate = 16000,
  firstMs = FIRST_MS,
  stepMs = STEP_MS,
  anchorMs = ANCHOR_MS,
  safeTailMs = SAFE_TAIL_MS,
  maxWindowMs = MAX_WINDOW_MS,
  tailMs = TAIL_MS,
  leadMs = LEAD_MS,
  tickMs = 250,
  budget = BUDGET,
  reuseMs = REUSE_MS,
  timers = { setInterval, clearInterval },
  clock = () => Date.now(),
} = {}) {
  const n = (ms) => Math.round((ms * rate) / 1000);
  let timer = null;
  let base = 0; // where the decode window starts, in samples of the whole clip
  let lead = 0; // of which this much is already-frozen audio, kept only as context
  let started = false;
  let first = true;
  let busy = null; // the decode in flight, so `finalize` can wait for it
  let stopped = true;
  let frozen = []; // words settled before `base` — they are never decoded again
  let hyp = []; // the whole transcript as the last decode saw it
  let prev = []; // and as the one before it did
  let shown = []; // the words on the eye
  let covered = 0; // the sample the last decode read up to

  /** The words a decode found that are actually new — the lead is frozen already. */
  function fresh(res) {
    const secs = lead / rate;
    return timedWords(res).filter((x) => x.at == null || x.at + 0.02 >= secs);
  }

  function render() {
    // what two decodes agreed on — and never less than what is already up, as
    // long as this decode still starts with it: a caption that shrinks flickers
    const keep = agreedCount(hyp, shown) === shown.length ? shown.length : 0;
    // frozen words are already committed to the transcript: they are not a guess
    let words = hyp.slice(0, Math.max(agreedCount(hyp, prev), keep, frozen.length));
    if (!words.length && !shown.length) words = hyp; // the first words go up unconfirmed
    const delta = captionDelta(shown.join(" "), words.join(" "));
    if (!delta) return;
    onText(delta.text, delta.append, delta.ms);
    shown = words;
  }

  /**
   * The head of the window is old enough to be settled: commit those words and
   * move the anchor past them, so the next decode is short again. A word that
   * ended more than `safeTailMs` ago has had all the right context it will get,
   * and re-decoding it forever is what made the window — and the final — slow.
   */
  function freeze(win, endAbs) {
    const dur = (endAbs - base) / rate;
    if (dur - lead / rate < anchorMs / 1000) return;
    const limit = dur - safeTailMs / 1000;
    let k = 0;
    for (let i = 0; i < win.length; i++) {
      if (win[i].to == null || win[i].to > limit) break;
      k = i + 1;
    }
    if (!k) return;
    const cut = Math.min(endAbs - base, n((win[k - 1].to + 0.04) * 1000));
    const keepLead = Math.min(n(leadMs), cut);
    if (cut - keepLead <= 0) return;
    frozen = frozen.concat(win.slice(0, k).map((x) => x.w));
    base += cut - keepLead;
    lead = keepLead;
  }

  function tick() {
    if (busy || stopped || clock() < tick.nextAt) return;
    let pend = read(base);
    if (!started) {
      const at = speechAt(pend);
      if (at < 0) {
        if (pend.length < n(NO_ONSET_MS)) {
          base += Math.max(0, pend.length - n(KEEP_MS));
          return;
        }
      } else {
        base += at;
        pend = pend.subarray(at);
      }
      started = true;
      covered = base;
    }
    if (first ? pend.length < n(firstMs) : base + pend.length - covered < n(stepMs)) return;
    const win = pend.subarray(0, Math.min(pend.length, n(maxWindowMs)));
    const end = cutIndex(win, rate, tailMs);
    if (end <= 0) return;
    const at = base;
    const t0 = clock();
    busy = Promise.resolve(decode(win.subarray(0, end))).then(
      (res) => {
        busy = null;
        // the cadence is the cost: a decode that took `d` waits until it has
        // averaged `budget` of a core, so a long window slows the ear down
        tick.nextAt = clock() + Math.round((clock() - t0) * (1 / budget - 1));
        if (stopped || at !== base) return; // the anchor moved under it: stale
        first = false;
        covered = base + end;
        const words = fresh(res);
        prev = hyp;
        hyp = frozen.concat(words.map((x) => x.w));
        freeze(words, covered);
        render();
      },
      () => {
        busy = null;
        tick.nextAt = clock() + tickMs;
      }
    );
  }
  tick.nextAt = 0;

  return {
    start() {
      if (timer) return;
      base = 0;
      lead = 0;
      started = false;
      first = true;
      busy = null;
      stopped = false;
      frozen = [];
      hyp = [];
      prev = [];
      shown = [];
      covered = 0;
      tick.nextAt = 0;
      timer = timers.setInterval(tick, tickMs);
      timer.unref?.();
    },
    stop() {
      timers.clearInterval(timer);
      timer = null;
    },
    /**
     * The transcript of the whole clip at mic close. The frozen head is already
     * decoded, so only the window from the anchor on is left — and when the last
     * decode already reached the end through silence, not even that. `null` when
     * the ear heard nothing and the caller should decode the clip itself.
     */
    async finalize(samples) {
      const inflight = busy;
      if (inflight) await inflight;
      stopped = true;
      if (!started || samples.length <= base) return null;
      if (
        covered > base &&
        hyp.length &&
        samples.length - covered < n(reuseMs) &&
        rms(samples, covered, samples.length) <= SPEECH_RMS
      )
        return { text: hyp.join(" "), reused: true };
      const res = await decode(samples.subarray(base), true);
      if (res == null) return null; // the recogniser is gone: the clip is the caller's again
      const tail = fresh(res);
      // a tail that comes back empty never throws the transcript away: the words
      // he already watched appear are still his words
      const words = tail.length ? frozen.concat(tail.map((x) => x.w)) : hyp.length > frozen.length ? hyp : frozen;
      return words.length ? { text: words.join(" "), reused: !tail.length } : null;
    },
    get shown() {
      return shown.join(" ");
    },
  };
}

module.exports = {
  createPartialEar,
  captionDelta,
  timedWords,
  agreedCount,
  speechAt,
  cutIndex,
  rms,
  FRAME,
  SPEECH_RMS,
  SETTLE_MS,
  BUDGET,
};
