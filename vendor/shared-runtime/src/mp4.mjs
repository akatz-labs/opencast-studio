import { open } from 'node:fs/promises';

const invalid = () => Object.assign(new Error('Incomplete or unsupported MP4 container'), { status: 400 });
function videoTrack(moov) {
  function boxes(start, end, path) {
    let p = start;
    while (p + 8 <= end) {
      let size = moov.readUInt32BE(p), header = 8;
      if (size === 1) { if (p + 16 > end) throw invalid(); size = Number(moov.readBigUInt64BE(p + 8)); header = 16; }
      if (!Number.isSafeInteger(size) || size < header || p + size > end) throw invalid();
      const kind = moov.toString('ascii', p + 4, p + 8);
      if (path.length && kind === path[0] && boxes(p + header, p + size, path.slice(1))) return true;
      if (!path.length && kind === 'hdlr' && size >= header + 12 && moov.toString('ascii', p + header + 8, p + header + 12) === 'vide') return true;
      p += size;
    }
    return false;
  }
  return boxes(0, moov.length, ['moov', 'trak', 'mdia']);
}

/** Inspect the entire box envelope without loading multi-GB mdat bytes into RAM. */
export async function inspectMp4File(file) {
  const handle = await open(file, 'r');
  try {
    const { size: total } = await handle.stat();
    let p = 0, ftyp = false, moov = false, mdat = false;
    const header = Buffer.alloc(16);
    while (p < total) {
      const { bytesRead } = await handle.read(header, 0, Math.min(16, total - p), p);
      if (bytesRead < 8) throw invalid();
      let size = header.readUInt32BE(0), offset = 8;
      const kind = header.toString('ascii', 4, 8);
      if (size === 1) { if (bytesRead < 16) throw invalid(); size = Number(header.readBigUInt64BE(8)); offset = 16; }
      else if (size === 0) size = total - p;
      if (!Number.isSafeInteger(size) || size < offset || p + size > total) throw invalid();
      if (p === 0 && kind !== 'ftyp') throw invalid();
      if (kind === 'ftyp') { if (ftyp || size < offset + 8 || size > 4096) throw invalid(); ftyp = true; }
      if (kind === 'mdat') { if (size <= offset) throw invalid(); mdat = true; }
      if (kind === 'moov') {
        if (moov || size > 32 * 1024 * 1024) throw invalid();
        const bytes = Buffer.alloc(size);
        const read = await handle.read(bytes, 0, size, p);
        if (read.bytesRead !== size || !videoTrack(bytes)) throw invalid();
        moov = true;
      }
      p += size;
    }
    if (!ftyp || !moov || !mdat) throw invalid();
    return { mime: 'video/mp4', extension: '.mp4' };
  } finally { await handle.close(); }
}
