const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

// Minimal pure-JS PNG generator for 32-bit RGBA
function createPNG(width, height, getPixel) {
  // getPixel(x, y) => [r, g, b, a]
  const rowSize = width * 4;
  const rawData = Buffer.alloc(height * (rowSize + 1));

  let pos = 0;
  for (let y = 0; y < height; y++) {
    rawData[pos++] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = getPixel(x, y);
      rawData[pos++] = r;
      rawData[pos++] = g;
      rawData[pos++] = b;
      rawData[pos++] = a;
    }
  }

  const compressedData = zlib.deflateSync(rawData);

  function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
  }

  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    crcTable[n] = c >>> 0;
  }

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(8 + len + 4);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crcBuf = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    buf.writeUInt32BE(crc32(crcBuf), 8 + len);
    return buf;
  }

  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdrData);

  const idatChunk = makeChunk('IDAT', compressedData);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

// Draw minimalist icon with anti-aliasing / supersampling
function renderIcon(size) {
  const scale = 4; // 4x supersampling
  const w = size * scale;
  const h = size * scale;

  // Pixel grid for supersampled buffer
  const buffer = new Uint8ClampedArray(w * h * 4);

  function setSSPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = (y * w + x) * 4;
    // Alpha blending
    const srcA = a / 255;
    const dstA = buffer[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA > 0) {
      buffer[idx + 0] = Math.round((r * srcA + buffer[idx + 0] * dstA * (1 - srcA)) / outA);
      buffer[idx + 1] = Math.round((g * srcA + buffer[idx + 1] * dstA * (1 - srcA)) / outA);
      buffer[idx + 2] = Math.round((b * srcA + buffer[idx + 2] * dstA * (1 - srcA)) / outA);
      buffer[idx + 3] = Math.round(outA * 255);
    }
  }

  function fillRoundedRect(x0, y0, rw, rh, rad, r, g, b, a) {
    for (let y = Math.floor(y0); y < Math.ceil(y0 + rh); y++) {
      for (let x = Math.floor(x0); x < Math.ceil(x0 + rw); x++) {
        let inside = false;
        const dx = Math.max(x0 + rad - x, 0, x - (x0 + rw - rad));
        const dy = Math.max(y0 + rad - y, 0, y - (y0 + rh - rad));
        if (dx <= 0 || dy <= 0) {
          inside = (x >= x0 && x < x0 + rw && y >= y0 && y < y0 + rh);
        } else if (dx * dx + dy * dy <= rad * rad) {
          inside = true;
        }
        if (inside) {
          setSSPixel(x, y, r, g, b, a);
        }
      }
    }
  }

  // Clear buffer (transparent)
  buffer.fill(0);

  // Outer badge: squircle / rounded rect
  const badgePad = 0.5 * scale;
  const badgeW = w - badgePad * 2;
  const badgeH = h - badgePad * 2;
  const badgeRad = Math.round(size * 0.22 * scale);

  // Background: Solid Deep Black #0a0a0a
  fillRoundedRect(badgePad, badgePad, badgeW, badgeH, badgeRad, 10, 10, 10, 255);

  // Layout for panes inside
  // Padding around inner grid:
  const innerPad = Math.round(size * 0.18 * scale);
  const gap = Math.max(1 * scale, Math.round(size * 0.08 * scale));
  const innerW = w - innerPad * 2;
  const innerH = h - innerPad * 2;

  const leftW = Math.round((innerW - gap) * 0.48);
  const rightW = innerW - gap - leftW;
  const topH = Math.round((innerH - gap) * 0.48);
  const botH = innerH - gap - topH;

  const paneRad = Math.max(0.5 * scale, Math.round(size * 0.05 * scale));

  // Left pane (Focus primary pane): Pure white #ffffff
  fillRoundedRect(innerPad, innerPad, leftW, innerH, paneRad, 255, 255, 255, 255);

  // Right top pane: Pure white #ffffff
  fillRoundedRect(innerPad + leftW + gap, innerPad, rightW, topH, paneRad, 255, 255, 255, 255);

  // Right bottom pane: Pure white #ffffff
  fillRoundedRect(innerPad + leftW + gap, innerPad + topH + gap, rightW, botH, paneRad, 255, 255, 255, 255);

  // Downsample to final size
  return createPNG(size, size, (x, y) => {
    let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
    for (let sy = 0; sy < scale; sy++) {
      for (let sx = 0; sx < scale; sx++) {
        const idx = ((y * scale + sy) * w + (x * scale + sx)) * 4;
        rSum += buffer[idx + 0];
        gSum += buffer[idx + 1];
        bSum += buffer[idx + 2];
        aSum += buffer[idx + 3];
      }
    }
    const samples = scale * scale;
    return [
      Math.round(rSum / samples),
      Math.round(gSum / samples),
      Math.round(bSum / samples),
      Math.round(aSum / samples),
    ];
  });
}

// Generate icons
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 32, 48, 128].forEach((size) => {
  const pngBuf = renderIcon(size);
  const filePath = path.join(iconsDir, `icon-${size}.png`);
  fs.writeFileSync(filePath, pngBuf);
  console.log(`Generated ${filePath} (${pngBuf.length} bytes)`);
});

// Also create icon.svg
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <rect width="128" height="128" rx="28" fill="#0a0a0a"/>
  <rect x="23" y="23" width="37" height="82" rx="6" fill="#ffffff"/>
  <rect x="68" y="23" width="37" height="37" rx="6" fill="#ffffff"/>
  <rect x="68" y="68" width="37" height="37" rx="6" fill="#ffffff"/>
</svg>
`;
fs.writeFileSync(path.join(iconsDir, 'icon.svg'), svg);
console.log('Generated icons/icon.svg');
