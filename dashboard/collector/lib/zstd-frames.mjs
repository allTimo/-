// Multi-frame zstd reader for DSH session logs.
// session.v4.jsonl.zstd is a CONCATENATION of many zstd frames; the stock
// zstdDecompressSync() returns only the first frame. We split on the zstd magic
// (28 B5 2F FD) and decompress every frame separately, then join the text.
import fs from 'node:fs';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function splitZstdFrames(buf) {
  const offsets = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offsets.push(i); i += 4; }
  if (offsets.length === 0) return [];
  const frames = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    frames.push(buf.subarray(offsets[k], end));
  }
  return frames;
}

export function decompressSessionBuffer(buf) {
  let frames = splitZstdFrames(buf);
  const parts = [];
  let badFrames = 0;
  if (frames.length === 0) frames = [buf];
  for (const frame of frames) {
    try { parts.push(zlib.zstdDecompressSync(frame).toString('utf8')); }
    catch (e) { badFrames++; }
  }
  return { text: parts.join(''), frames: frames.length, badFrames: badFrames, bytes: buf.length };
}

export function decompressSessionFile(filePath) {
  return decompressSessionBuffer(fs.readFileSync(filePath));
}

// Parse newline-delimited JSON, tolerating truncated/corrupt lines.
export function parseJsonl(text) {
  const events = [];
  let badLines = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '' || line === '\r') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') events.push(obj);
      else badLines++;
    } catch (e) { badLines++; }
  }
  return { events: events, badLines: badLines, totalLines: lines.length };
}
