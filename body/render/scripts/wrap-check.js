#!/usr/bin/env node
/**
 * The caption wrap of `spec/eye-reference.html:layoutCaption`, verbatim, with
 * `measureText` stubbed from the Rust renderer's Pango advance — the parity
 * check E15 asks for. argv: text, advance px, TEXT_W. Prints the lines.
 */
const [text, advance, textW] = process.argv.slice(2);
const measure = (s) => s.length * Number(advance);
const words = text.split(/\s+/);
const lines = [];
let cur = "";
for (const w of words) {
  const probe = cur ? cur + " " + w : w;
  if (measure(probe) > Number(textW) && cur) {
    lines.push(cur);
    cur = w;
  } else cur = probe;
}
if (cur) lines.push(cur);
process.stdout.write(JSON.stringify(lines));
