// Estrae dal bundle del Pokédex ufficiale (dex.emeraldimperium.net) i dati usati dall'app.
// Uso: node tools/extract_dex.js <bundle.js> <cartella-output>
const fs = require('fs');
const path = require('path');
const [, , bundlePath, outDir] = process.argv;
const s = fs.readFileSync(bundlePath, 'utf8');

function balanced(start) {
  // start punta a '{' o '['; restituisce il testo fino alla parentesi di chiusura corrispondente.
  const open = s[start], close = open === '{' ? '}' : ']';
  let depth = 0, inStr = null;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return s.slice(start, i + 1);
  }
  throw new Error('non bilanciato');
}
const evalObj = (txt) => Function('"use strict";return (' + txt + ')')();
const objAfter = (marker) => {
  const i = s.indexOf(marker);
  if (i < 0) throw new Error('marker mancante: ' + marker);
  return evalObj(balanced(s.indexOf('{', i)));
};

const species = objAfter('={1:{speciesId:1,');
const abilities = objAfter('={1:{abilityId:1,');
const moves = objAfter('={1:{moveId:1,');

// Costanti SPECIES_*: l'oggetto mappa nomi -> variabili minificate, risolte qui.
const constStart = s.indexOf('{SPECIES_NONE:');
const constTxt = balanced(constStart);
const varVal = (v) => {
  if (/^\d/.test(v)) return Number(v);
  const m = s.match(new RegExp('[,;\\s]' + v.replace('$', '\\$') + '=([0-9e.]+)[,;]'));
  return m ? Number(m[1]) : null;
};
const speciesConst = {};
for (const m of constTxt.slice(1, -1).split(',')) {
  const [k, v] = m.split(':');
  speciesConst[k] = varVal(v);
}

// Incontri selvatici (JSON del decomp).
const wi = s.indexOf("JSON.parse('[{\"label\":\"gWildMonHeaders\"") + "JSON.parse('".length;
const wild = JSON.parse(s.slice(wi, s.indexOf("')", wi)).replace(/\\'/g, "'"));

fs.mkdirSync(outDir, { recursive: true });
const write = (n, d) => fs.writeFileSync(path.join(outDir, n), JSON.stringify(d));
write('raw_species.json', species);
write('raw_abilities.json', abilities);
write('raw_moves.json', moves);
write('raw_species_const.json', speciesConst);
write('raw_wild.json', wild);
console.log('species', Object.keys(species).length, 'abilities', Object.keys(abilities).length,
  'moves', Object.keys(moves).length, 'const', Object.keys(speciesConst).length,
  'nullconst', Object.values(speciesConst).filter((v) => v == null).length);
