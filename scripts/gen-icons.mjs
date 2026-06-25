// Procedurally generates the PWA icon set (no external image deps).
// Renders a NotePlan-style calendar glyph into an RGBA buffer and encodes
// it as PNG using Node's built-in zlib. Run with: node scripts/gen-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(OUT, { recursive: true })

// ── tiny RGBA canvas ────────────────────────────────────────────────────────
function canvas(size) {
  return { size, buf: new Uint8Array(size * size * 4) }
}
function hex(c) {
  const n = parseInt(c.slice(1), 16)
  return c.length === 7
    ? [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
    : [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
}
function blend(c, x, y, [r, g, b, a], cov = 1) {
  if (x < 0 || y < 0 || x >= c.size || y >= c.size) return
  const i = (y * c.size + x) * 4
  const af = (a / 255) * cov
  c.buf[i]     = Math.round(c.buf[i]     * (1 - af) + r * af)
  c.buf[i + 1] = Math.round(c.buf[i + 1] * (1 - af) + g * af)
  c.buf[i + 2] = Math.round(c.buf[i + 2] * (1 - af) + b * af)
  c.buf[i + 3] = Math.min(255, Math.round(c.buf[i + 3] + 255 * af))
}
// rounded rect with ~1px anti-aliased edges via 3x3 supersampling near borders
function roundRect(c, x0, y0, w, h, r, color) {
  const x1 = x0 + w, y1 = y0 + h
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y1) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x1) + 1; x++) {
      let cov = 0
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3
        if (inRound(px, py, x0, y0, x1, y1, r)) cov++
      }
      if (cov) blend(c, x, y, color, cov / 9)
    }
  }
}
function inRound(px, py, x0, y0, x1, y1, r) {
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  const corners = [[x0 + r, y0 + r], [x1 - r, y0 + r], [x0 + r, y1 - r], [x1 - r, y1 - r]]
  const inX = px < x0 + r ? 0 : px > x1 - r ? 1 : -1
  const inY = py < y0 + r ? 0 : py > y1 - r ? 1 : -1
  if (inX >= 0 && inY >= 0) {
    const [cx, cy] = corners[inY * 2 + inX]
    return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
  }
  return true
}
function circle(c, cx, cy, r, color) {
  for (let y = Math.floor(cy - r) - 1; y <= Math.ceil(cy + r) + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= Math.ceil(cx + r) + 1; x++) {
      let cov = 0
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3
        if ((px - cx) ** 2 + (py - cy) ** 2 <= r * r) cov++
      }
      if (cov) blend(c, x, y, color, cov / 9)
    }
  }
}

// ── PNG encode ──────────────────────────────────────────────────────────────
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const body = Buffer.concat([t, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePNG(c) {
  const { size, buf } = c
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(buf.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── draw the icon ───────────────────────────────────────────────────────────
function draw(size, maskable) {
  const c = canvas(size)
  const s = size
  const pad = maskable ? s * 0.10 : 0      // safe-zone padding for maskable
  const bg = hex('#2563eb')                // brand blue
  // background panel (full-bleed for maskable, rounded card otherwise)
  if (maskable) {
    for (let i = 0; i < c.buf.length; i += 4) { c.buf[i] = bg[0]; c.buf[i+1] = bg[1]; c.buf[i+2] = bg[2]; c.buf[i+3] = 255 }
  } else {
    roundRect(c, 0, 0, s, s, s * 0.22, bg)
  }
  // calendar card
  const cx0 = pad + s * 0.17, cy0 = pad + s * 0.18
  const cw = s - 2 * (pad + s * 0.17), ch = s - 2 * (pad + s * 0.18)
  roundRect(c, cx0, cy0, cw, ch, s * 0.06, hex('#ffffff'))
  // orange header strip
  const hh = ch * 0.22
  roundRect(c, cx0, cy0, cw, hh + s * 0.05, s * 0.06, hex('#f97316'))
  roundRect(c, cx0, cy0 + hh, cw, s * 0.06, 0, hex('#f97316'))
  // binder rings
  const ringW = cw * 0.07, ringH = ch * 0.12
  roundRect(c, cx0 + cw * 0.26, cy0 - ringH * 0.45, ringW, ringH, ringW * 0.5, hex('#1e293b'))
  roundRect(c, cx0 + cw * 0.67, cy0 - ringH * 0.45, ringW, ringH, ringW * 0.5, hex('#1e293b'))
  // task dots grid (echo the reference calendar dots)
  const dotR = cw * 0.045
  const gridTop = cy0 + hh + ch * 0.20
  const gridLeft = cx0 + cw * 0.20
  const gx = cw * 0.30, gy = ch * 0.22
  const palette = [hex('#ec4899'), hex('#f97316'), hex('#2563eb')]
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if ((row + col) % 2 === 1 && !(row === 1 && col === 1)) continue
      circle(c, gridLeft + col * gx, gridTop + row * gy, dotR, palette[(row + col) % 3])
    }
  }
  return encodePNG(c)
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-192.png', 192, true],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
]
for (const [name, size, maskable] of targets) {
  writeFileSync(join(OUT, name), draw(size, maskable))
  console.log('wrote', name, size)
}
