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

/** classify(text) → {kind:"canvas", close}, {kind:"tv", mode} or {kind:"words"}. */
function classify(text) {
  const t = String(text ?? "").trim();
  if (CANVAS.test(t)) return { kind: "canvas", close: /^(?:close|cierra)/i.test(t) };
  for (const mode of ["off", "on", "auto"]) if (TV[mode].test(t)) return { kind: "tv", mode };
  return { kind: "words" };
}

module.exports = { classify };
