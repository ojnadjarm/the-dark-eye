/**
 * The replies waiting for the phone: the Kokoro chunks of one utterance
 * assembled into a 16-bit WAV, kept in a bounded ring until the phone polls
 * for them or they go stale. Nothing here touches the buds — a remote reply
 * is heard on the phone and nowhere else.
 */
const crypto = require("node:crypto");

const RING = 20;
const TTL_MS = 300_000; // 5 min — a reply nobody came back for is not worth holding
const POLL_MS = 50_000;

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
 * `wav(id)` is the audio behind it, until the TTL, played or not. `partial(utt, text)`
 * rides the same long-poll with his own words as he says them.
 */
function createReplies({ ring = RING, ttlMs = TTL_MS, pollMs = POLL_MS, now = Date.now, log = () => {} } = {}) {
  const open = new Map(); // speak id → the chunks arriving for it
  const items = []; // {seq, text, id, at, wav}
  const waiters = [];
  let seq = 0;
  let growing = null; // his words so far, on the same seq line as the replies

  const fresh = () => {
    const cut = now() - ttlMs;
    while (items.length && items[0].at < cut) items.shift();
    return items;
  };

  const shape = (it) => ({ seq: it.seq, text: it.text, audio: `/remote/audio/${it.id}.wav` });

  function publish(utt) {
    const item = {
      seq: ++seq,
      text: utt.texts.join(" ").trim(),
      id: crypto.randomBytes(8).toString("base64url"),
      at: now(),
      wav: wavOf(utt.parts, utt.rate),
    };
    fresh().push(item);
    while (items.length > ring) items.shift();
    log(`reply ${item.seq} for the phone: ${item.wav.length} bytes`);
    for (const w of waiters.splice(0)) w(shape(item));
  }

  /** Whichever of the two lanes comes next after `since`; a played reply is behind him. */
  const next = (since) => {
    const it = fresh().find((x) => x.seq > since && !x.played);
    const p = growing && growing.seq > since ? growing : null;
    if (it && p) return it.seq < p.seq ? shape(it) : p;
    return it ? shape(it) : p;
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

    chunk({ id, last, text = "", sampleRate, samples }) {
      const utt = open.get(id) ?? { parts: [], texts: [], rate: sampleRate };
      open.set(id, utt);
      if (samples?.length) utt.parts.push(samples);
      if (text) utt.texts.push(text);
      if (!last) return;
      open.delete(id);
      if (utt.parts.length) publish(utt);
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

module.exports = { createReplies, wavOf, RING, TTL_MS, POLL_MS };
