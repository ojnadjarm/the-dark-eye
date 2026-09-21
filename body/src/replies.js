/**
 * The replies waiting for the phone: the Kokoro chunks of one utterance
 * assembled into a 16-bit WAV, kept in a bounded ring until the phone polls
 * for them or they go stale. Nothing here touches the buds — a remote reply
 * is heard on the phone and nowhere else.
 */
const crypto = require("node:crypto");

const RING = 20;
const TTL_MS = 300_000; // 5 min — but only for a reply he has heard: the tray holds for hours
const POLL_MS = 50_000;
const EAGER_BYTES_MAX = 12 * 1024 * 1024; // ~4 minutes of speech waiting on the ring
const EAGER_BYTES_ONE = 4 * 1024 * 1024; // ~85 s: past that the press synthesises instead

/** Float32 samples in [-1,1) as 16-bit little-endian PCM. */
function toPcm16(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.allocUnsafe(total * 2);
  let i = 0;
  for (const p of parts)
    for (const s of p) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i);
      i += 2;
    }
  return buf;
}

/** A canonical 44-byte RIFF header in front of mono 16-bit PCM. */
function wavOf(parts, rate) {
  const data = toPcm16(parts);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16); // fmt chunk size
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // mono
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28); // byte rate
  head.writeUInt16LE(2, 32); // block align
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * `{chunk, poll, wav}`. `chunk(m)` takes the voice worker's `{id, seq, last,
 * text, sampleRate, samples}` for an utterance addressed to the phone and
 * publishes it when its last chunk lands; `poll(since, ms)` long-polls for the
 * first reply after `since`; `cursor()` is the newest published seq, where a
 * fresh page starts; `ack(seq)` marks one played so it is never polled again;
 * `wav(id)` is the audio behind it — kept while the reply is unplayed, and for the
 * TTL after he has heard it. `attach(seq, parts, rate)` puts an eagerly made voice
 * onto a reply already on the ring, `ready(seq)` tells the page that reply is pressable at
 * last, and `repeat(seq)` publishes those bytes again as
 * the answer to his ▶, so a press costs no synthesis. `partial(utt, text)`
 * rides the same long-poll with his own words as he says them; `brains(roster)`
 * rides it too, whenever the active brain, the roster or the mode changes; `text(text)` is
 * a reply with no audio (audio notes mode), on the ring like any other; `find(seq)` is the
 * text behind one, so a replay can only ask for what the ring still holds.
 */
function createReplies({
  ring = RING,
  ttlMs = TTL_MS,
  pollMs = POLL_MS,
  bytesMax = EAGER_BYTES_MAX,
  bytesOne = EAGER_BYTES_ONE,
  now = Date.now,
  log = () => {},
} = {}) {
  const open = new Map(); // speak id → the chunks arriving for it
  const items = []; // {seq, text, id, at, wav, played, press, pending, readyAt}
  const waiters = [];
  let seq = 0;
  let growing = null; // his words so far, on the same seq line as the replies
  let roster = null; // the brains and who is active, the newest only

  /** The clock only evicts what he has heard — an unplayed reply waits for his ▶ however long. */
  const fresh = () => {
    const cut = now() - ttlMs;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].played && items[i].at < cut) items.splice(i, 1);
    return items;
  };

  /** One Buffer counts once, however many items share it: his press republishes the bytes it played. */
  const bytes = () => {
    const seen = new Set();
    let n = 0;
    for (const it of items)
      if (it.wav && !seen.has(it.wav)) {
        seen.add(it.wav);
        n += it.wav.length;
      }
    return n;
  };

  /**
   * Past the budget: the audio he has already heard goes first, then the oldest
   * unheard — never the answer to a press he has not played yet, which is the one
   * thing being fetched right now. Words, line and ▶ always stay.
   */
  function budget() {
    const shed = items.filter((it) => it.wav && !(it.press && !it.played));
    for (const it of [...shed.filter((it) => it.played), ...shed.filter((it) => !it.played)]) {
      if (bytes() <= bytesMax) return;
      log(`reply ${it.seq}: audio dropped for the byte budget — its words stay`);
      it.wav = null;
      it.id = null;
    }
  }

  const shape = (it) => ({
    seq: it.seq,
    text: it.text,
    ...(it.id && { audio: `/remote/audio/${it.id}.wav` }),
    ...(it.pending && { pending: true }),
  });

  /**
   * Its voice is in hand, or will never be: either way the press is his to make, so the
   * page is told once, on its own seq, and swaps the quiet mark for the ▶ on that same
   * line. A notice rides the ring with its item and is never withheld by `played` — a
   * words-only reply is acked the moment it is drawn.
   */
  function settle(it) {
    if (!it?.pending) return;
    it.pending = false;
    it.readyAt = ++seq;
    for (const w of waiters.splice(0)) w({ seq: it.readyAt, ready: it.seq });
  }

  /** One item onto the ring: `{text}` alone is a reply he reads, `{text, id, wav}` one he hears. */
  function publish(item) {
    item.seq = ++seq;
    item.at = now();
    fresh().push(item);
    while (items.length > ring) items.shift();
    log(`reply ${item.seq} for the phone: ${item.wav ? `${item.wav.length} bytes` : "text only"}`);
    for (const w of waiters.splice(0)) w(shape(item));
    return item.seq;
  }

  /** Whichever lane comes next after `since`; a played reply is behind him. */
  const next = (since) => {
    const it = fresh().find((x) => x.seq > since && !x.played);
    const note = fresh().find((x) => x.readyAt > since);
    return [it && shape(it), note && { seq: note.readyAt, ready: note.seq }, growing, roster]
      .filter((x) => x && x.seq > since)
      .sort((a, b) => a.seq - b.seq)[0] ?? null;
  };

  return {
    /**
     * The growing line of what he is saying right now, for the phone's own gold
     * caption; `null` clears it, once the final transcript has taken its place.
     */
    partial(utt, text) {
      growing = text == null ? null : { seq: ++seq, utt, partial: text };
      if (growing) for (const w of waiters.splice(0)) w(growing);
    },

    /** The roster as the page draws it: `{seq, brains, active, mode}`, the newest replacing the last. */
    brains({ brains, active, mode }) {
      roster = { seq: ++seq, brains, active, mode };
      for (const w of waiters.splice(0)) w(roster);
    },

    chunk({ id, last, text = "", sampleRate, samples }) {
      const utt = open.get(id) ?? { parts: [], texts: [], rate: sampleRate };
      open.set(id, utt);
      if (samples?.length) utt.parts.push(samples);
      if (text) utt.texts.push(text);
      if (!last) return;
      open.delete(id);
      if (utt.parts.length)
        publish({
          text: utt.texts.join(" ").trim(),
          id: crypto.randomBytes(8).toString("base64url"),
          wav: wavOf(utt.parts, utt.rate),
        });
    },

    /**
     * Words with no voice behind them — a reply in audio notes mode: shown, never played.
     * `pending` is "a voice is being made for this one": the page draws no ▶ until
     * `ready(seq)` says it is there. Answers its seq.
     */
    text(text, pending = false) {
      return publish({ text: String(text), pending });
    },

    /** That reply is pressable now: its eager voice landed, or it will never get one. */
    ready(seq) {
      settle(items.find((x) => x.seq === seq));
    },

    /**
     * The eagerly made voice of a reply already on the ring, under the two caps:
     * past `bytesOne` nothing is held, and past `bytesMax` audio he has heard is
     * dropped first, then the oldest unheard. Answers whether the bytes are his to press.
     */
    attach(seq, parts, rate) {
      const it = items.find((x) => x.seq === seq);
      if (!it || it.wav) return false;
      const wav = wavOf(parts, rate);
      if (wav.length > bytesOne) {
        log(`reply ${seq}: ${wav.length} bytes is past the per-reply cap — the press will synthesise`);
        return false;
      }
      it.id = crypto.randomBytes(8).toString("base64url");
      it.wav = wav;
      budget();
      return !!it.wav;
    },

    /**
     * His ▶ on a reply whose voice already exists: those same bytes published as the
     * answer, with no synthesis at all. The pressed item counts as heard — the page
     * plays and acks the item published here. Answers false when there are no bytes.
     */
    repeat(seq) {
      const it = fresh().find((x) => x.seq === seq);
      if (!it?.wav) return false;
      it.played = true;
      // `press`: the budget leaves these bytes alone until he has heard them — his phone is fetching them
      publish({ text: it.text, id: crypto.randomBytes(8).toString("base64url"), wav: it.wav, press: true });
      return true;
    },

    /** The first item after `since` — a reply or a partial — waiting up to `ms`. */
    poll(since = 0, ms = pollMs) {
      const waiting = next(since);
      if (waiting) return Promise.resolve(waiting);
      return new Promise((res) => {
        waiters.push(res);
        setTimeout(() => {
          const i = waiters.indexOf(res);
          if (i >= 0) {
            waiters.splice(i, 1);
            res(null);
          }
        }, ms);
      });
    },

    /** Marks a reply as heard, so no reload is ever given it again; an unknown seq is a no-op. */
    ack(seq) {
      const it = items.find((x) => x.seq === seq);
      if (it) it.played = true;
    },

    /** The words of a reply still on the ring, else null — the ring is what may be said again. */
    find(seq) {
      return fresh().find((x) => x.seq === seq)?.text ?? null;
    },

    /** The seq of the newest reply still in the ring, 0 if none — where a fresh page starts. */
    cursor() {
      const list = fresh();
      return list.length ? list[list.length - 1].seq : 0;
    },

    /** The WAV behind a reply, while it is still fresh. */
    wav(id) {
      return fresh().find((it) => it.id === id)?.wav ?? null;
    },
  };
}

module.exports = { createReplies, wavOf, RING, TTL_MS, POLL_MS, EAGER_BYTES_MAX, EAGER_BYTES_ONE };
