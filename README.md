# Imperium Nuzlocke

App Android per giocare **Pokémon Emerald Imperium** con un tracker Nuzlocke integrato.

## Cosa fa

- **Primo avvio**: scegli la tua ROM di Pokémon Emerald (USA, CRC32 `1F1C08FB`). L'app scarica la patch ufficiale dal patcher linkato da [emeraldimperium.info](https://emeraldimperium.info/), la applica e conserva il gioco. La ROM non lascia il telefono.
- **Emulatore**: core mGBA (libretro, WebAssembly senza thread), controlli touch in verticale e orizzontale, avanti veloce, 4 slot di salvataggio rapido, ripresa automatica da dove avevi lasciato, esportazione e importazione del `.sav`.
- **Più partite**: ogni partita ha il suo salvataggio, i suoi stati e il suo tracker.
- **Tracker Nuzlocke**: 128 zone in ordine di progressione con gli incontri di Imperium, clausola duplicati per famiglia evolutiva, clausola shiny, regali opzionali, cimitero, 19 level cap ufficiali con le squadre dei boss (strumenti, abilità, nature, mosse).
- **Regole applicabili**: caricamento stati e riavvolgimento possono essere liberi, conteggiati o bloccati.

## Struttura

```
web/        app (HTML/CSS/JS, nessuna build richiesta)
  js/       main.js (interfaccia), emulator.js, nuzlocke.js, patcher.js, controls.js, storage.js
  data/     imperium.json (specie, zone, incontri, level cap e boss)
  vendor/   core mGBA libretro (EmulatorJS) e fflate
android/    contenitore WebView (Java) che impacchetta /web come asset
tools/      script per rigenerare i dati di Imperium
```

## Build

Ogni push su `main` compila l'APK con GitHub Actions (scheda **Actions** → ultimo run → artifact `imperium-nuzlocke-apk`).

In locale servono JDK 21 e Android SDK 36:

```
cd android
./gradlew assembleRelease
# app/build/outputs/apk/release/app-release.apk
```

L'APK è firmato con la chiave in `android/keystore/`, così ogni build si installa sopra la precedente senza perdere i dati.

Per provare l'interfaccia nel browser basta servire `web/` con un server statico qualsiasi.

## Dati

`web/data/imperium.json` è generato da `tools/build_data.py` a partire da:

- Pokédex ufficiale (dex.emeraldimperium.net): specie, tipi, statistiche, evoluzioni, incontri selvatici
- "Emerald Imperium 1.3 Encounter Tracker": ordine delle zone, regali e incontri statici
- Calcolatore danni di hzla (dati 1.3) e foglio "Boss Battles": squadre dei boss e level cap

Vedi `tools/README.md`.

## Prossimi passi (Fase 2)

Lettura automatica della memoria del gioco (zona attuale, catture, esausti, livelli della squadra) per aggiornare il tracker da solo e avvisare sul level cap. Gli indirizzi di memoria per Imperium sono documentati nello script Lua del calcolatore di hzla.

## Licenze di terze parti

- mGBA (MPL-2.0) e RetroArch/EmulatorJS (GPL-3.0): `web/vendor/libretro/license.txt`
- fflate (MIT)
- Pokémon è © Nintendo, Game Freak, The Pokémon Company. Emerald Imperium è un progetto amatoriale di iriv24 e della sua community. Questo repository non contiene ROM né file del gioco.
