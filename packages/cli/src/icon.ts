import { crc32, deflateSync } from 'node:zlib';

/**
 * A tiny book-shaped icon, drawn here so the site does not depend on a
 * binary asset or a network fetch. Home Screen needs a PNG; SVG is not
 * reliable as an apple-touch-icon.
 */
export function bookIcon(size = 180): Buffer {
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);
  const bg: Rgb = [20, 19, 17, 255];
  const page: Rgb = [243, 239, 230, 255];
  const spine: Rgb = [90, 62, 36, 255];
  const margin = Math.round(size * 0.18);
  const spineWidth = Math.max(6, Math.round(size * 0.05));

  for (let y = 0; y < size; y++) {
    const row = y * rowBytes;
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const onPage = x >= margin && x < size - margin && y >= margin && y < size - margin;
      const onSpine = onPage && x < margin + spineWidth;
      const px = onSpine ? spine : onPage ? page : bg;
      const i = row + 1 + x * 4;
      raw[i] = px[0];
      raw[i + 1] = px[1];
      raw[i + 2] = px[2];
      raw[i + 3] = px[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

type Rgb = [number, number, number, number];

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, sum]);
}
