/**
 * What the Eye's own ears must answer: the canvas commands. Anything else is
 * words for the brain — a full-utterance match only, so "show me the file" is words.
 */
const CANVAS =
  /^(?:show me|open (?:the )?canvas|canvas|close (?:the )?canvas|muestra|mu[eé]strame(?:lo)?|abre el (?:lienzo|canvas)|cierra el (?:lienzo|canvas))[.!?]?$/i;

/** His own TV switch, said out loud — the same thing `eye tv off|on|auto` does (E12). */
const TV = {
  off: /^(?:tv off|turn (?:the )?tv off|the tv is off|apaga (?:la )?(?:tele|tv|pantalla)|(?:la )?tele apagada)[.!?]?$/i,
  on: /^(?:tv on|turn (?:the )?tv on|the tv is on|enciende (?:la )?(?:tele|tv|pantalla)|(?:la )?tele encendida)[.!?]?$/i,
  auto: /^(?:tv auto|tele auto)[.!?]?$/i,
};

/** The switch of who hears him: `talk to notes`, `notes, listen`, `cambia a main`; "talk to me" is not a switch. */
const BRAIN = [
  /^(?:talk to|switch to|habla con|cambia a) (?!me\b)([a-z0-9-]{1,16})[.!?]?$/i,
  /^([a-z0-9-]{1,16}), listen[.!?]?$/i,
];

/**
 * The two modes of the conversation, whichever channel is active, and the
 * phrases that enter them. The `name` is the body's own word (`mode.js`); the
 * phrases are his, and "audio notes" is never the `notes` channel. The Eye says
 * the first phrase of the list that matched back to him, so a Spanish way in
 * gets a Spanish answer. The later entries of each list are recogniser
 * mis-hearings he accepts outright.
 */
const MODES = [
  {
    name: "async",
    en: ["audio notes", "audio note", "notes mode", "note mode", "audionotes", "audio nodes", "odio notes", "audio no"],
    es: ["notas de audio", "modo notas", "modo de notas", "audio notas"],
  },
  {
    name: "call",
    en: ["call mode", "back to call", "normal mode", "call mod", "called mode", "call more"],
    es: ["modo llamada", "modo de llamada"],
  },
];
/** Words that may sit before a mode phrase and nothing else may: "what's up audio notes". */
const FILLER = /^(?:hey|hi|ok|okay|eye|dark eye|whats up|wake up|oye|hola|qu[eé] tal|vale)(?= |$)/;
/** A switch verb may also sit before it: "switch to audio notes". */
const MODE_VERB = /^(?:talk to|switch to|habla con|cambia a) /;

/** Lowercase, punctuation gone, one space between words — what the mode rules read. */
const normalise = (t) =>
  t
    .toLowerCase()
    .replace(/[.,;:!?¡¿'"“”’`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The mode phrase can only be the whole utterance, or the tail after filler and a switch verb. */
function modeTail(t) {
  let s = normalise(t);
  for (let m = FILLER.exec(s); m; m = FILLER.exec(s)) s = s.slice(m[0].length).trim();
  const v = MODE_VERB.exec(s);
  return v ? s.slice(v[0].length).trim() : s;
}

/** One substitution, insertion or deletion apart — the near-miss window, no dependency. */
function withinOneEdit(a, b) {
  if (a === b) return true;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return true;
  }
  if (Math.abs(a.length - b.length) !== 1) return false;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  return short.slice(i) === long.slice(i + 1);
}

/** The mode a tail enters, or — one edit away and not on the list — the mode it nearly entered. */
function modeOf(tail, fuzzy = false) {
  if (!tail) return null;
  for (const mode of MODES)
    for (const lang of ["en", "es"])
      for (const phrase of mode[lang])
        if (fuzzy ? withinOneEdit(tail, phrase) : tail === phrase)
          return { name: mode.name, words: mode[lang][0], lang, phrase };
  return null;
}
const WHO = /^(?:who is listening|who's listening|qui[eé]n (?:me )?escucha)[.!?]?$/i;

/**
 * The old words for the two modes: `quiet` is audio notes, `talk to me` is call (M09a).
 * Split per language, so a Spanish phrase is answered in Spanish like every table phrase.
 */
const QUIET = [
  { name: "async", lang: "en", words: "quiet", re: /^(?:quiet|be quiet)[.!?]?$/i },
  { name: "async", lang: "es", words: "silencio", re: /^(?:silencio|c[áa]llate)[.!?]?$/i },
  { name: "call", lang: "en", words: "talk to me", re: /^talk to me[.!?]?$/i },
  { name: "call", lang: "es", words: "háblame", re: /^h[áa]blame[.!?]?$/i },
];

/**
 * classify(text, log) → {kind:"canvas", close}, {kind:"tv", mode}, {kind:"brain", name, words, lang}
 * (`name` null asks who is listening), {kind:"mode", name, words, lang} or {kind:"words"}.
 * A mode phrase heard one edit off is logged, not obeyed: the list grows from his transcripts.
 */
function classify(text, log = () => {}) {
  const t = String(text ?? "").trim();
  if (CANVAS.test(t)) return { kind: "canvas", close: /^(?:close|cierra)/i.test(t) };
  for (const mode of ["off", "on", "auto"]) if (TV[mode].test(t)) return { kind: "tv", mode };
  for (const { name, lang, words, re } of QUIET) if (re.test(t)) return { kind: "mode", name, words, lang };
  const tail = modeTail(t);
  const mode = modeOf(tail);
  if (mode) return { kind: "mode", name: mode.name, words: mode.words, lang: mode.lang };
  for (const re of BRAIN) {
    const m = re.exec(t);
    if (m) return { kind: "brain", name: m[1].toLowerCase() };
  }
  if (WHO.test(t)) return { kind: "brain", name: null };
  const near = modeOf(tail, true);
  if (near) log(`intents: near "${tail}" → ${near.name}?`);
  return { kind: "words" };
}

module.exports = { classify };
