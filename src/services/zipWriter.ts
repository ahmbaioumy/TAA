// Minimal, dependency-free ZIP writer shared by the .xlsx export
// (xlsxWriter.ts) and the bundled email-draft download (emlBuilder.ts).
// Entries use the "stored" (uncompressed) method — no deflate needed, just a
// CRC-32 and plain header records, so there's no dependency on
// CompressionStream support. Windows Explorer opens the result natively.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | (Math.floor(d.getSeconds() / 2) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// A ZIP file needs no compression to be valid — "stored" entries (method 0)
// just need a correct CRC-32 and the standard local/central header records.
// All multi-byte fields are little-endian, written via DataView so field
// offsets can't drift.
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const { time, date } = dosDateTime(new Date());
  const encoder = new TextEncoder();
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, 0x04034b50, true);
    ldv.setUint16(4, 20, true); // version needed to extract
    ldv.setUint16(6, 0, true); // general purpose flag
    ldv.setUint16(8, 0, true); // compression method: stored
    ldv.setUint16(10, time, true);
    ldv.setUint16(12, date, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, size, true); // compressed size
    ldv.setUint32(22, size, true); // uncompressed size
    ldv.setUint16(26, nameBytes.length, true);
    ldv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);
    localChunks.push(local, entry.data);

    const central = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(central.buffer);
    cdv.setUint32(0, 0x02014b50, true);
    cdv.setUint16(4, 20, true); // version made by
    cdv.setUint16(6, 20, true); // version needed to extract
    cdv.setUint16(8, 0, true); // general purpose flag
    cdv.setUint16(10, 0, true); // compression method: stored
    cdv.setUint16(12, time, true);
    cdv.setUint16(14, date, true);
    cdv.setUint32(16, crc, true);
    cdv.setUint32(20, size, true);
    cdv.setUint32(24, size, true);
    cdv.setUint16(28, nameBytes.length, true);
    cdv.setUint16(30, 0, true); // extra field length
    cdv.setUint16(32, 0, true); // comment length
    cdv.setUint16(34, 0, true); // disk number start
    cdv.setUint16(36, 0, true); // internal file attributes
    cdv.setUint32(38, 0, true); // external file attributes
    cdv.setUint32(42, offset, true); // relative offset of local header
    central.set(nameBytes, 46);
    centralChunks.push(central);

    offset += local.length + entry.data.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralChunks.reduce((sum, c) => sum + c.length, 0);

  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(4, 0, true); // disk number
  edv.setUint16(6, 0, true); // disk with central directory start
  edv.setUint16(8, entries.length, true); // entries on this disk
  edv.setUint16(10, entries.length, true); // total entries
  edv.setUint32(12, centralDirSize, true);
  edv.setUint32(16, centralDirOffset, true);
  edv.setUint16(20, 0, true); // comment length

  const total = centralDirOffset + centralDirSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of localChunks) { out.set(chunk, pos); pos += chunk.length; }
  for (const chunk of centralChunks) { out.set(chunk, pos); pos += chunk.length; }
  out.set(eocd, pos);
  return out;
}
