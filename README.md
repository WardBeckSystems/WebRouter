# Web Router

The Ward-Beck Systems **Web Router**: a browser routing console with a 5 × 7 crosspoint matrix.

| Input sources | Crosspoint matrix | Output destinations |
|---|---|---|
| CH 1 Soundcard In · CH 2 System Audio · CH 3 POD-33 Tone · CH 4 Bit Buddy · CH 5 Pink / Sweep | 35 illuminated crosspoints, presets (Default, 1 kHz Cal, Bit Spitter, Mix All) | XTM-4 Master · POD-22 Loudness · Monitor 1 / Speakers · Cue / HP · Test Tap · POD-33 Out · Bit Spitter Out |

The router owns the **POD-33** tone generator and **ABB-1 Bit Buddy** state (CH 3 and CH 4 engage them),
but not their control panels: build those against `setPod33Config()`, `setBitBuddyConfig()` and `onChange()`.

Each strip is compact: channel tag, name and live L / R level on one line, a stereo VU
pair, and one row of actions (ENGAGE / 🔊 SPK on inputs, MUTE / −20 dB on outputs).

## Use

The router imports nothing from its host. You pass in an audio engine that has the
methods listed in `WebRouterAudio` (`src/types.ts`).

```ts
import { WebRouter } from './WebRouter/src';
import './WebRouter/src/web-router.css';

const router = new WebRouter(document.getElementById('routingStage')!, {
  audio,                                  // engine implementing WebRouterAudio
  daemonUrl: 'http://localhost:8467',     // ward-beck-audio-tab.py (default)
  onFlowHint: (flowId) => { /* show this MXL flow elsewhere */ },
}).mount();

// every animation frame:
router.render({ vuDb: [left, right] });
```

`render()` skips work while the container is hidden.

Public methods: `mount()`, `render(levels)`, `selectInput(i)`, `routeToSpeakers(i)`,
`toggleCrosspoint(row, col)`, `applyPreset(name)`, `setPod33(on)`, `setBitBuddy(on)`,
`setPod33Config(patch)`, `setBitBuddyConfig(patch)`, `onChange(cb)`, `setAudio(engine)`,
`refresh()`, `destroy()`.

### Daemon endpoints (optional)

If `ward-beck-audio-tab.py` is running, the router also posts to
`/api/force_speakers`, `/api/test_tone` and `/api/bitbuddy`. Failures are ignored.

## Themes

Styles follow the host's `body.theme-mccurdy-dark`, `theme-mccurdy-light`,
`theme-wbs-ca` and `theme-wbs-dark` classes. All classes use the `wr-` prefix.

## Develop

```sh
npm install
npm run dev        # standalone demo (index.html → demo/main.ts, stub audio engine)
npm run typecheck
```

## Used by

- [XTM.WBSps.ca](https://github.com/WardBeckSystems/XTM.WBSps.ca): mounted as the `WebRouter/`
  submodule and shown under the **routing** tab in the footer (loudness · data · routing).

---

© 2026 Ward-Beck Systems ([Ward-Beck.ca](https://ward-beck.ca)). All rights reserved.
