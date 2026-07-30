/**
 * Generates the application icon.
 *
 * Written as a script rather than committing a binary blob so the icon is
 * reviewable, reproducible, and easy to restyle. No image libraries are
 * available in CI, so this encodes the PNG directly (zlib + the four chunks
 * PNG actually requires).
 *
 * Design: a dark rounded tile with a countdown ring — the app is fundamentally
 * about timers — broken at the top like a wave-timer arc, with a centre dot.
 *
 * Run: node scripts/makeIcon.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const SIZE = 1024;
const OUT_DIR = join(import.meta.dirname, '..', 'build');

// Palette, matching the app's UI.
const BG = [15, 18, 22];
const RING = [74, 158, 255];
const RING_DIM = [37, 79, 128];
const DOT = [232, 234, 237];

/** Smooth 0..1 coverage across a 1px band — cheap analytic anti-aliasing. */
function coverage(distance, edge) {
  return Math.max(0, Math.min(1, edge - distance + 0.5));
}

function blend(dst, src, alpha) {
  for (let i = 0; i < 3; i++) dst[i] = Math.round(dst[i] * (1 - alpha) + src[i] * alpha);
}

function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const c = SIZE / 2;
  const tileRadius = SIZE * 0.22;
  const inset = SIZE * 0.055;
  const ringR = SIZE * 0.30;
  const ringW = SIZE * 0.075;
  const dotR = SIZE * 0.075;

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const fx = x + 0.5;
      const fy = y + 0.5;

      // --- Rounded-square tile mask -------------------------------------
      const dx = Math.max(Math.abs(fx - c) - (c - inset - tileRadius), 0);
      const dy = Math.max(Math.abs(fy - c) - (c - inset - tileRadius), 0);
      const tileDist = Math.hypot(dx, dy);
      const tileAlpha = coverage(tileDist, tileRadius);
      if (tileAlpha <= 0) continue;

      const colour = [...BG];

      // --- Countdown ring ------------------------------------------------
      const rx = fx - c;
      const ry = fy - c;
      const r = Math.hypot(rx, ry);
      // Angle measured clockwise from 12 o'clock.
      let angle = Math.atan2(rx, -ry);
      if (angle < 0) angle += Math.PI * 2;

      const ringDist = Math.abs(r - ringR);
      const onRing = coverage(ringDist, ringW / 2);
      if (onRing > 0) {
        // Filled for the first ~70% of the sweep, dim for the remainder, with
        // a small gap at 12 o'clock so it reads as a timer rather than a donut.
        const sweep = Math.PI * 2 * 0.7;
        const gap = 0.16;
        const inGap = angle < gap / 2 || angle > Math.PI * 2 - gap / 2;
        if (!inGap) {
          blend(colour, angle <= sweep ? RING : RING_DIM, onRing);
        }
      }

      // --- Centre dot ------------------------------------------------------
      blend(colour, DOT, coverage(r, dotR));

      px[i] = colour[0];
      px[i + 1] = colour[1];
      px[i + 2] = colour[2];
      px[i + 3] = Math.round(255 * tileAlpha);
    }
  }
  return px;
}

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10-12: compression, filter, interlace — all 0.

  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Box-downsamples the master render so smaller sizes stay clean. */
function downsample(pixels, from, to) {
  const out = Buffer.alloc(to * to * 4);
  const factor = from / to;
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * factor); sy < (y + 1) * factor; sy++) {
        for (let sx = Math.floor(x * factor); sx < (x + 1) * factor; sx++) {
          const i = (sy * from + sx) * 4;
          const alpha = pixels[i + 3] / 255;
          r += pixels[i] * alpha; g += pixels[i + 1] * alpha; b += pixels[i + 2] * alpha;
          a += pixels[i + 3];
          n++;
        }
      }
      const o = (y * to + x) * 4;
      const alphaSum = a / n / 255 || 1;
      out[o] = Math.round(r / n / alphaSum);
      out[o + 1] = Math.round(g / n / alphaSum);
      out[o + 2] = Math.round(b / n / alphaSum);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

await mkdir(OUT_DIR, { recursive: true });
const master = render();

// electron-builder picks up build/icon.png and derives platform formats from it.
await writeFile(join(OUT_DIR, 'icon.png'), encodePng(master, SIZE));
for (const size of [512, 256, 128, 64]) {
  await writeFile(join(OUT_DIR, `icon-${size}.png`), encodePng(downsample(master, SIZE, size), size));
}

console.log(`makeIcon: wrote build/icon.png (${SIZE}px) + 512/256/128/64 variants`);
