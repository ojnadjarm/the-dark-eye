/**
 * Split text into speakable chunks: one sentence each, and only fragments
 * shorter than `MERGE` together — the chunk is the unit the voice generates,
 * the ear waits for and the caption follows, so a big one is a long silence.
 * Kokoro runs with `maxNumSentences: 1`, so merging buys no prosody anyway.
 */
const MERGE = 60;

module.exports = function chunks(text) {
  const parts = text
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?…;:])\s+/)
    .filter(Boolean);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur && (cur + " " + p).length > MERGE) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + " " + p : p;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
};
