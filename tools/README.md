# Rigenerare i dati di Imperium

1. Scarica il bundle JavaScript del Pokédex (il nome del file cambia a ogni versione, si trova in `index.html`):

   ```
   curl -s https://dex.emeraldimperium.net/ | grep -o '/assets/index-[^"]*\.js'
   curl -so dex.js https://dex.emeraldimperium.net/assets/index-XXXX.js
   node tools/extract_dex.js dex.js raw/
   ```

2. Esporta le squadre dei boss dal calcolatore di hzla:

   ```
   git clone --depth 1 https://github.com/hzla/Dynamic-Calc-Decomps.git calc
   node -e '
   const fs=require("fs");const src=fs.readFileSync("calc/backups/imp_1-3.js","utf8");const g={};
   Function("g",src.replace(/^(\s*)(var |let |const )?([a-zA-Z_]+) = /gm,"$1g.$3 = ")+";return g")(g);
   fs.writeFileSync("raw/raw_sets.json",JSON.stringify(g.backup_data));'
   ```

3. Scarica il foglio "Emerald Imperium 1.3 Encounter Tracker" come xlsx:

   ```
   curl -sLo enc.xlsx "https://docs.google.com/spreadsheets/d/1T-BLRBgbDTUnWqthJGALvCRCmH6CFq9aJgfUMTN5a3A/export?format=xlsx"
   ```

4. Genera il file:

   ```
   pip install openpyxl
   python3 tools/build_data.py raw enc.xlsx web/data/imperium.json
   ```

Lo script stampa i nomi che non riesce a collegare a una specie: se ne compaiono, aggiorna `resolve()` o le tabelle di conversione.
