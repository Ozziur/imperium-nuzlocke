// Download della patch ufficiale di Emerald Imperium e applicazione BPS.
import { unzipSync } from '../vendor/fflate.js';

// Fonte ufficiale: il patcher web linkato da emeraldimperium.info.
export const PATCH_SOURCES = [
  'https://danayatsuta.github.io/emerald-imperium-patcher/patches.zip',
  'https://raw.githubusercontent.com/danayatsuta/emerald-imperium-patcher/master/patches.zip',
];

// Pokémon Emerald (U) pulita, richiesta dalla patch.
export const EMERALD_US_CRC32 = 0x1f1c08fb;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');

// ---------- BPS ----------

function readU32LE(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

export function bpsInfo(patch) {
  if (patch.length < 16 || String.fromCharCode(...patch.subarray(0, 4)) !== 'BPS1') {
    throw new Error('Il file non è una patch BPS valida.');
  }
  const n = patch.length;
  return {
    sourceCrc: readU32LE(patch, n - 12),
    targetCrc: readU32LE(patch, n - 8),
    patchCrc: readU32LE(patch, n - 4),
  };
}

/** Applica una patch BPS. Lancia un errore se la ROM di partenza non è quella attesa. */
export function applyBps(source, patch, onProgress) {
  const info = bpsInfo(patch);
  if (crc32(patch, 0, patch.length - 4) !== info.patchCrc) {
    throw new Error('La patch è danneggiata (checksum errato). Riprova il download.');
  }
  if (crc32(source) !== info.sourceCrc) {
    throw new Error(
      `ROM non compatibile: serve Pokémon Emerald (USA) pulita. ` +
        `CRC atteso ${hex(info.sourceCrc)}, trovato ${hex(crc32(source))}.`,
    );
  }

  let p = 4;
  const decode = () => {
    let data = 0;
    let shift = 1;
    for (;;) {
      const x = patch[p++];
      data += (x & 0x7f) * shift;
      if (x & 0x80) break;
      shift *= 128;
      data += shift;
    }
    return data;
  };

  const sourceSize = decode();
  const targetSize = decode();
  const metaSize = decode();
  p += metaSize;
  if (sourceSize !== source.length) throw new Error('Dimensione della ROM inattesa.');

  const target = new Uint8Array(targetSize);
  let out = 0;
  let srcRel = 0;
  let tgtRel = 0;
  const end = patch.length - 12;
  let lastReport = 0;

  while (p < end) {
    const data = decode();
    const cmd = data % 4;
    let len = Math.floor(data / 4) + 1;
    if (cmd === 0) {
      target.set(source.subarray(out, out + len), out);
      out += len;
    } else if (cmd === 1) {
      target.set(patch.subarray(p, p + len), out);
      p += len;
      out += len;
    } else if (cmd === 2) {
      const d = decode();
      srcRel += (d & 1 ? -1 : 1) * Math.floor(d / 2);
      target.set(source.subarray(srcRel, srcRel + len), out);
      srcRel += len;
      out += len;
    } else {
      const d = decode();
      tgtRel += (d & 1 ? -1 : 1) * Math.floor(d / 2);
      while (len--) target[out++] = target[tgtRel++]; // può sovrapporsi: byte per byte
    }
    if (onProgress && out - lastReport > 1 << 20) {
      lastReport = out;
      onProgress(out / targetSize);
    }
  }

  if (crc32(target) !== info.targetCrc) throw new Error('Patch applicata ma il risultato non è valido.');
  return target;
}

// ---------- Download ----------

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url, { mode: 'cors', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) return new Uint8Array(await res.arrayBuffer());
  const buf = new Uint8Array(total);
  const reader = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf.set(value, got);
    got += value.length;
    onProgress?.(got / total);
  }
  return buf.subarray(0, got);
}

const versionOf = (name) => (name.match(/v(\d+(?:\.\d+)*)\.bps$/i)?.[1] || '0').split('.').map(Number);
const cmpVer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
};

/** Estrae dallo zip ufficiale la patch con la versione più alta. */
export function latestPatchFromZip(zipBytes) {
  const names = [];
  const files = unzipSync(zipBytes, {
    filter: (f) => {
      const ok = /\.bps$/i.test(f.name);
      if (ok) names.push(f.name);
      return ok;
    },
  });
  if (!names.length) throw new Error('Nessuna patch trovata nell’archivio.');
  names.sort((a, b) => cmpVer(versionOf(b), versionOf(a)));
  const name = names[0];
  return { name, version: versionOf(name).join('.'), bytes: files[name] };
}

/** Scarica l'ultima patch disponibile, provando le fonti in ordine. */
export async function downloadLatestPatch(onProgress) {
  let lastErr;
  for (const url of PATCH_SOURCES) {
    try {
      const zip = await fetchWithProgress(url, onProgress);
      return latestPatchFromZip(zip);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`Download della patch non riuscito (${lastErr?.message || 'rete'}).`);
}

/** Accetta una patch scelta a mano: .bps singola o lo zip ufficiale. */
export function patchFromFile(name, bytes) {
  if (/\.zip$/i.test(name)) return latestPatchFromZip(bytes);
  bpsInfo(bytes);
  return { name, version: versionOf(name).join('.') || 'manuale', bytes };
}
