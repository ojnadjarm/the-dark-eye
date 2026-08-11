/**
 * Minimal PNG encoding — enough to draw tray-menu dots at runtime without
 * any image dependency. Same format as scripts/make-tray-icon.js.
 */
const zlib = require("node:zlib");

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePng(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) px.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 16×16 session dot: filled disc = connected, hollow ring = silent. */
function dotPng(hex, filled) {
  const W = 16;
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const px = Buffer.alloc(W * W * 4);
  const C = 7.5;
  const R = 5.6;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - C, y - C);
      // soft 1px edges so the dot doesn't look jagged at menu scale
      let a = Math.max(0, Math.min(1, R - d + 0.5));
      if (!filled) a = Math.min(a, Math.max(0, Math.min(1, d - (R - 2.1) + 0.5)));
      if (a <= 0) continue;
      const i = (y * W + x) * 4;
      px[i] = rgb[0];
      px[i + 1] = rgb[1];
      px[i + 2] = rgb[2];
      px[i + 3] = Math.round(a * 255);
    }
  }
  return encodePng(W, W, px);
}

module.exports = { encodePng, dotPng };
