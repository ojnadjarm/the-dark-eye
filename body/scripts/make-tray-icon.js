/**
 * Generates assets/tray.png — the green cat-eye tray icon, 32×32 RGBA.
 * No dependencies: hand-rolled PNG (IHDR/IDAT/IEND + CRC32, zlib deflate).
 * Run once: node scripts/make-tray-icon.js
 */
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

const W = 32;
const H = 32;
const px = Buffer.alloc(W * H * 4);
const set = (x, y, r, g, b, a) => {
  const i = (y * W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
};

// same cat-lid curve as the renderer: y = RY·(1-dx²)^0.8
const CX = 15.5, CY = 15.5, RX = 14.5, RY = 9.5;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - CX) / RX;
    if (Math.abs(dx) > 1) continue;
    const lid = RY * Math.pow(1 - dx * dx, 0.8);
    const dy = y - CY;
    if (Math.abs(dy) > lid) continue;
    const slit = Math.abs(x - CX) <= 1.4 && Math.abs(dy) <= lid * 0.85;
    const iris = Math.abs(x - CX) <= 4.2 && Math.abs(dy) <= lid * 0.9;
    if (slit) set(x, y, 8, 26, 16, 255);
    else if (iris) set(x, y, 255, 209, 102, 255);
    else if (lid - Math.abs(dy) < 1.7) set(x, y, 77, 255, 160, 255);
    else set(x, y, 26, 110, 64, 235);
  }
}

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

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "assets", "tray.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
