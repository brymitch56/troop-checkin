'use strict';
// The app mark as a PNG, drawn from the theme palette.
//
// Why rasterize at all when lib/theme already emits the same mark as SVG:
// iOS home screens take `apple-touch-icon`, and that link accepts PNG only.
// Without this, a themed instance installed to an iPhone shows the other
// program's colour — the exact lookalike problem the SVG icon fixed for
// browser tabs.
//
// Why by hand instead of an image library: this runs on a Pi, the repo is
// public, and an icon is not worth a native dependency (or a build step that
// bakes one PNG per preset and still misses THEME_* overrides). The mark is
// two stroked shapes on a flat ground, which is a few lines of signed-distance
// maths, and Node ships zlib — everything PNG encoding actually needs.
//
// Geometry is the 512-unit space of lib/theme's iconSvg(), scaled to the
// requested size, so the SVG and the PNG are the same drawing.
const zlib = require('zlib');

// --------------------------------------------------------------- geometry ---
// Rounded rect: centre, half-extent and corner radius of the stroke's centre
// line; the check: two segments with round caps and a round join.
const BOX = { cx: 256, cy: 256, half: 186, r: 30, halfStroke: 6 };
const CHECK = { pts: [[156, 273], [230, 342], [366, 183]], halfStroke: 10.5 };

// Distance from p to the rounded-rect outline (negative inside the outline's
// enclosed area; we only care about |d|, the distance to the line itself).
function boxEdgeDistance(x, y) {
  const qx = Math.abs(x - BOX.cx) - (BOX.half - BOX.r);
  const qy = Math.abs(y - BOX.cy) - (BOX.half - BOX.r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - BOX.r;
  return Math.abs(d);
}

// Distance from p to a line segment — round caps and joins come free, since
// the union of two capsules is exactly a round-joined polyline stroke.
function segmentDistance(x, y, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = x - ax, wy = y - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 ? (wx * vx + wy * vy) / len2 : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(wx - t * vx, wy - t * vy);
}

// Is this point inside the paper-coloured mark?
function inMark(x, y) {
  if (boxEdgeDistance(x, y) <= BOX.halfStroke) return true;
  for (let i = 0; i < CHECK.pts.length - 1; i++) {
    const [ax, ay] = CHECK.pts[i], [bx, by] = CHECK.pts[i + 1];
    if (segmentDistance(x, y, ax, ay, bx, by) <= CHECK.halfStroke) return true;
  }
  return false;
}

const SS = 4; // supersampling grid per axis — 16 coverage samples per pixel

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// size x size RGB buffer: `paper` mark composited over a `pine` ground, with
// edges antialiased by coverage rather than left to jag at 180px.
function rasterize(size, pine, paper) {
  const bg = hexToRgb(pine), fg = hexToRgb(paper);
  const scale = 512 / size;
  const out = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          if (inMark(x, y)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (py * size + px) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(bg[c] + (fg[c] - bg[c]) * a);
    }
  }
  return out;
}

// ---------------------------------------------------------- PNG container ---
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// 8-bit truecolour PNG. Every row uses filter 0 (None): the image is flat
// colour over most of its area, so zlib already collapses it to a few KB and
// per-row filter heuristics would buy nothing worth the code.
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // deflate, adaptive filtering, no interlace

  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ cache ---
// Keyed by the colours actually used, so a THEME_* change takes effect on the
// next request without a restart, and the common case never rasterizes twice.
const cache = new Map();

function iconPng(size, pine, paper) {
  const key = `${size}|${pine}|${paper}`;
  let png = cache.get(key);
  if (!png) {
    png = encodePng(size, rasterize(size, pine, paper));
    cache.set(key, png);
  }
  return png;
}

module.exports = { iconPng, rasterize, encodePng, inMark, _cache: cache };
