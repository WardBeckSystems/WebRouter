/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/**
 * Web Router — Ward-Beck Systems browser routing console.
 *
 *   One grid: each input row starts with its strip (name · level · VU ·
 *   ENGAGE) followed by its crosspoints; the bottom row holds each
 *   output's name · VU · level · -20 dB. A crosspoint is the mute: there
 *   are no separate mute or "to speakers" buttons.
 *
 * The router owns the POD-33 and ABB-1 generator state (CH 3 / CH 4 engage
 * them), but not their control panels: a host can build those against
 * setPod33 / setPod33Config / setBitBuddy / setBitBuddyConfig / onChange.
 *
 * 5 inputs × 7 outputs.
 */

import {
  type BrowserTabInfo,
  DEFAULT_BITBUDDY_CONFIG,
  DEFAULT_POD33_CONFIG,
  type BitBuddyConfig,
  type Pod33Config,
  type RouterChannel,
  type WebRouterAudio,
  type WebRouterLevels,
  type WebRouterOptions,
} from './types';
import { PIVOT_L, PIVOT_R, PIVOT_Y, clampDb, renderMeterPair, vuDbToAngle } from './vu-meter';

export const INPUTS: RouterChannel[] = [
  { tag: 'CH 1', name: 'Soundcard In', sub: 'Mic / Line In', pill: 'mic' },
  { tag: 'CH 2', name: 'Browser Tab', sub: 'Shared tab audio (getDisplayMedia)', pill: 'sys' },
  { tag: 'CH 3', name: 'POD-33 Tone', sub: 'DARS 100/400/1k', pill: 'pod' },
  { tag: 'CH 4', name: 'Bit Buddy', sub: 'ABS-1 Bit Spitter', pill: 'abb' },
  { tag: 'CH 5', name: 'Pink / Sweep', sub: 'Noise Reference', pill: 'noise' },
];

/**
 * Destinations, by what they really are: the meter's four INPUT buttons (MTR), the sound card
 * outputs (HW), and MXL flows written to /dev/shm (MXL: to disk, not an output).
 */
export const OUTPUTS: RouterChannel[] = [
  // The meter's four INPUT buttons: one source each
  { tag: 'MTR 1', name: 'Meter Input 1', sub: 'XTM-4 INPUT 1 button', pill: 'mtr' },
  { tag: 'MTR 2', name: 'Meter Input 2', sub: 'XTM-4 INPUT 2 button', pill: 'mtr' },
  { tag: 'MTR 3', name: 'Meter Input 3', sub: 'XTM-4 INPUT 3 button', pill: 'mtr' },
  { tag: 'MTR 4', name: 'Meter Input 4', sub: 'XTM-4 INPUT 4 button', pill: 'mtr' },
  { tag: 'HW 1', name: 'Monitor 1 / Speakers', sub: 'Sound card out (ALSA)', pill: 'hw' },
  { tag: 'HW 2', name: 'Studio Cue / HP', sub: 'Sound card out (control room listen)', pill: 'hw' },
  // The four MXL transmitters
  { tag: 'MXL 1', name: 'Repeater', sub: 'MXL flow wbs-flow-master-stereo (repeats the routed mix) → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL 2', name: 'POD-33 1 kHz', sub: 'MXL flow POD-33-1kHz-Reference → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL 3', name: 'POD-33 400 / 100 Hz', sub: 'MXL flow POD-33-400Hz-Alignment / POD-33-100Hz-LowEnd (click the name to switch) → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL 4', name: 'Bit Spitter', sub: 'MXL flow wbs-flow-bit-spitter → /dev/shm/mxl', pill: 'mxl' },
];

const SHORT_OUT = ['Input 1', 'Input 2', 'Input 3', 'Input 4', 'Speakers', 'Cue/HP', 'Repeater', '1 kHz', '400 Hz', 'Bit Spitter'];

/** The MXL flow each transmitter column writes (MXL 3 follows its 400 / 100 Hz switch). */
const MXL_FLOW: Record<number, string> = {
  6: 'wbs-flow-master-stereo',
  7: 'wbs-flow-ref-tone',
  9: 'wbs-flow-bit-spitter',
};
const FLOW_400 = '25030044-0440-4416-8000-000000000003';
const FLOW_100 = '25030044-0440-4416-8000-000000000004';

/** Column indices with special meaning. */
const METERS = 4; // columns 0-3: Meter Input 1-4
const OUT_SPEAKERS = 4;
const OUT_CUE = 5;
const OUT_POD33 = 7;
const OUT_POD33_LOW = 8; // 400 / 100 Hz, switchable
const OUT_BITS = 9;
const IN_POD33 = 2;
const IN_BITBUDDY = 3;
const IN_TAB = 1;

const FLOW_MASTER = 'wbs-flow-master-stereo';
const FLOW_TONE = 'wbs-flow-ref-tone';
const FLOW_BITS = 'wbs-flow-bit-spitter';

const PRESETS: Record<string, { matrix: boolean[][]; select?: number }> = {
  broadcast: {
    select: 1,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, false, false, true, false, false],
      [false, false, false, false, true, false, false, false, false, true],
      [false, false, false, false, true, false, false, false, false, false],
    ],
  },
  pod33: {
    select: 2,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, true, true, true, false, false],
      [false, false, false, false, true, false, false, false, false, true],
      [false, false, false, false, true, false, false, false, false, false],
    ],
  },
  bitbuddy: {
    select: 3,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, false, false, true, false, false],
      [false, false, false, false, true, true, true, false, false, true],
      [false, false, false, false, true, false, false, false, false, false],
    ],
  },
  all: {
    matrix: Array.from({ length: 5 }, () => [false, false, false, false, true, false, false, true, false, true]),
  },
};

const cloneMatrix = (m: boolean[][]) => m.map((row) => row.slice());

export class WebRouter {
  readonly container: HTMLElement;
  private audio: WebRouterAudio | null;
  private daemonUrl: string;
  private onFlowHint?: (flowId: string) => void;
  private onOpenFlow?: (flowId: string) => void;
  private onMeterInput?: (meter: number, input: number) => void;

  /** Rows = inputs, columns = outputs. Soundcard is kept off the speakers to avoid feedback. */
  matrix: boolean[][] = cloneMatrix(PRESETS.broadcast.matrix);
  /** Speakers and Cue/HP start muted so nothing the page hears loops back out of it. */
  outMutes: boolean[] = OUTPUTS.map((_, i) => i === OUT_SPEAKERS || i === OUT_CUE);
  outDims: boolean[] = new Array(OUTPUTS.length).fill(false);
  /** Speaker (HW 1) level 0…1: the strip's fader, shared with Settings → Monitor Volume. */
  speakerLevel = 0.7;
  activeInput = 1; // Browser Tab
  /** Router input on each meter INPUT button (1-4), or null when it plays something else. */
  meterInputs: (number | null)[] = [0, 1, 2, 3];

  pod33Config: Pod33Config = { ...DEFAULT_POD33_CONFIG };
  bitBuddyConfig: BitBuddyConfig = { ...DEFAULT_BITBUDDY_CONFIG };
  pod33Engaged = false;
  /** MXL 3 transmits POD-33 400 Hz or 100 Hz. */
  pod33LowHz: 400 | 100 = 400;
  bitBuddyEngaged = false;
  /**
   * ABB-1 Bit Buddy has one home: the TAP daemon. While it answers, the daemon is the only
   * generator and its state is the shared control every page reflects; the browser generator
   * only plays when no daemon is reachable.
   */
  private daemonOnline = false;
  private daemonTimer: number | null = null;
  /** Last local Bit Buddy change: polls just after it may predate the daemon applying it. */
  private bbLocalAt = 0;

  private needles: { inL: Element[]; inR: Element[]; outL: Element[]; outR: Element[] } = { inL: [], inR: [], outL: [], outR: [] };
  private built = false;
  private tabKey = '';
  private wasExternal = false;
  private tabInfoEl: Element | null = null;
  private tabPeak = -120;
  private listeners = new Set<(router: WebRouter) => void>();

  constructor(container: HTMLElement, opts: WebRouterOptions = {}) {
    this.container = container;
    this.audio = opts.audio ?? null;
    this.daemonUrl = (opts.daemonUrl ?? 'http://localhost:8467').replace(/\/$/, '');
    this.onFlowHint = opts.onFlowHint;
    this.onOpenFlow = opts.onOpenFlow;
    this.onMeterInput = opts.onMeterInput;
    this.setMeterInputs(this.meterInputs);
  }

  /** Render the router into its container and wire events. */
  mount(): this {
    this.container.innerHTML = this.renderHtml();
    const q = (sel: string) => this.container.querySelector(sel) as Element;
    this.needles = {
      inL: INPUTS.map((_, i) => q(`#wrInNeedleL${i}`)),
      inR: INPUTS.map((_, i) => q(`#wrInNeedleR${i}`)),
      outL: OUTPUTS.map((_, i) => q(`#wrOutNeedleL${i}`)),
      outR: OUTPUTS.map((_, i) => q(`#wrOutNeedleR${i}`)),
    };
    this.tabInfoEl = q('#wrTabInfo');
    this.tabKey = '';
    this.attachEvents();
    this.refresh();
    this.built = true;
    this.watchDaemon();
    return this;
  }

  setAudio(audio: WebRouterAudio | null): void {
    this.audio = audio;
  }

  destroy(): void {
    if (this.daemonTimer !== null) window.clearInterval(this.daemonTimer);
    this.daemonTimer = null;
    this.container.innerHTML = '';
    this.built = false;
  }

  /** Poll the daemon's Bit Buddy so every page shows (and controls) the one shared generator. */
  private watchDaemon(): void {
    if (this.daemonTimer !== null) return;
    const poll = () => {
      fetch(`${this.daemonUrl}/api/bitbuddy`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((st: { active?: boolean; config?: { pattern?: string } }) => {
          const wasOnline = this.daemonOnline;
          this.daemonOnline = true;
          // The daemon took over: silence the browser copy so it is only heard once.
          if (!wasOnline) this.audio?.stopBitBuddyGenerator();
          const pat = st.config?.pattern as BitBuddyConfig['pattern'] | undefined;
          const patChanged = !!pat && pat !== this.bitBuddyConfig.pattern;
          if (patChanged) this.bitBuddyConfig.pattern = pat!;
          if (Date.now() - this.bbLocalAt < 2000) return;
          if (!!st.active !== this.bitBuddyEngaged) this.applyBitBuddy(!!st.active);
          else if (patChanged) this.refresh();
        })
        .catch(() => {
          if (!this.daemonOnline) return;
          this.daemonOnline = false;
          // Daemon gone: the browser generator carries on for this page.
          if (this.bitBuddyEngaged) this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
        });
    };
    poll();
    this.daemonTimer = window.setInterval(poll, 1500);
  }

  // ───────────────────────────── markup ─────────────────────────────

  private renderHtml(): string {
    return `
      <div class="wr-rack">
        <div class="wr-grid-card">
          <table class="wr-matrix-table wr-grid" aria-label="Crosspoint matrix: inputs down, outputs across">
            <thead><tr>
              <th class="wr-grid-corner" aria-label="Inputs down, outputs across"></th>
              ${OUTPUTS.map((o, i) => this.renderOutputCell(o, i)).join('')}
            </tr></thead>
            <tbody>${INPUTS.map((c, r) => this.renderInputRow(c, r)).join('')}</tbody>
          </table>
        </div>

      </div>`;
  }

  /** Row header = the input strip: tag · name · level, VU pair, ENGAGE. The crosspoints follow. */
  private renderInputRow(c: RouterChannel, idx: number): string {
    const cells = OUTPUTS.map((o, col) => `
      <td class="wr-td-crosspoint">
        <button type="button" class="wr-matrix-btn" data-row="${idx}" data-col="${col}" title="${c.name} → ${o.name}" aria-label="${c.name} to ${o.name}">
          <span class="wr-matrix-led"></span>
        </button>
      </td>`).join('');
    return `<tr class="wr-grid-row">
      <th class="wr-grid-in" scope="row">
        <div class="wr-strip wr-in-strip" id="wrInStrip${idx}" title="${c.name} — ${c.sub}">
          <div class="wr-strip-top">
            <span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>
            <span class="wr-strip-name" id="wrInName${idx}">${c.name}</span>
            <button type="button" class="wr-btn-engage" data-in-idx="${idx}">ENGAGE</button>
          </div>
          ${idx === IN_TAB ? `<div class="wr-strip-info" id="wrTabInfo"></div>` : ''}
          ${renderMeterPair('wrIn', idx)}
        </div>
      </th>${cells}</tr>`;
  }

  /** Column head: each output's tag, name, -20 dB dim and its VU meter, above its crosspoints. */
  private renderOutputCell(c: RouterChannel, idx: number): string {
    return `
      <th class="wr-grid-out-head wr-grid-out" scope="col">
        <div class="wr-strip wr-out-strip" id="wrOutStrip${idx}" title="${c.name} — ${c.sub}">
          <div class="wr-strip-top">
            ${c.pill === 'mxl'
              ? `<button type="button" class="wr-strip-tag wr-pill-mxl wr-btn-open-flow" data-open-flow="${idx}" title="Open the ${c.name} MXL transmitter">${c.tag}</button>`
              : `<span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>`}
            ${idx === OUT_POD33_LOW
              ? `<button type="button" class="wr-strip-name wr-btn-hz" data-low-hz="1" id="wrLowHz" title="Switch POD-33 400 Hz / 100 Hz">${this.pod33LowHz} Hz</button>`
              : c.pill === 'mxl'
                ? `<button type="button" class="wr-strip-name wr-btn-open-flow" data-open-flow="${idx}" title="Open the ${c.name} MXL transmitter">${SHORT_OUT[idx]}</button>`
                : `<span class="wr-strip-name">${SHORT_OUT[idx]}</span>`}
            ${c.pill === 'hw' ? `<button type="button" class="wr-btn-out-tool wr-btn-dim" data-out-dim="${idx}" title="Dim ${c.name} by 20 dB">-20dB</button>` : ''}
          </div>
          ${renderMeterPair('wrOut', idx)}
          ${idx === OUT_SPEAKERS ? `<input type="range" class="wr-level" data-out-level="${idx}" min="0" max="1" step="0.01" value="${this.speakerLevel}" title="Speaker level" aria-label="Speaker level">` : ''}
        </div>
      </th>`;
  }

  // ───────────────────────────── events ─────────────────────────────

  private attachEvents(): void {
    const root = this.container;
    // One delegated listener: every control carries a data-* attribute.
    root.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset?.outLevel !== undefined) this.setSpeakerLevel(parseFloat(t.value));
    });
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t || !root.contains(t)) return;
      const d = t.dataset;
      if (d.row !== undefined) return this.toggleCrosspoint(+d.row, +(d.col ?? 0));
      if (d.inIdx !== undefined) return this.selectInput(+d.inIdx);
      if (d.outDim !== undefined) return this.toggleOut('dim', +d.outDim);
      if (d.lowHz !== undefined) {
        this.pod33LowHz = this.pod33LowHz === 400 ? 100 : 400;
        const el = root.querySelector('#wrLowHz');
        if (el) el.textContent = `${this.pod33LowHz} Hz`;
        return;
      }
      if (d.openFlow !== undefined) {
        const col = +d.openFlow;
        const flow = col === OUT_POD33_LOW ? (this.pod33LowHz === 400 ? FLOW_400 : FLOW_100) : MXL_FLOW[col];
        if (flow) this.onOpenFlow?.(flow);
        return;
      }
    });
  }

  // ───────────────────────────── routing ─────────────────────────────

  private post(path: string, body?: unknown): void {
    fetch(`${this.daemonUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch(() => {});
  }

  private resumeAudio(): void {
    const ctx = this.audio?.ctx;
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }

  private monitorGain(): number {
    return this.speakerLevel * (this.outDims[OUT_SPEAKERS] ? 0.1 : 1);
  }

  /** Set the speaker level (0…1); the -20 dB dim still applies on top. */
  setSpeakerLevel(v: number): void {
    const lvl = Math.max(0, Math.min(1, isFinite(v) ? v : this.speakerLevel));
    if (lvl === this.speakerLevel) return;
    this.speakerLevel = lvl;
    this.audio?.setMonitorVolume(this.monitorGain());
    this.refresh();
  }

  /** Re-derive the physical monitor (speakers) state from the matrix. */
  private syncMonitor(): void {
    if (!this.audio) return;
    const a = this.activeInput;
    const on =
      this.matrix[a][OUT_SPEAKERS] || this.matrix[a][OUT_CUE] ||
      (this.pod33Engaged && this.matrix[IN_POD33][OUT_SPEAKERS]) ||
      (this.bitBuddyEngaged && this.matrix[IN_BITBUDDY][OUT_SPEAKERS]);
    this.audio.setMonitor(on && !this.outMutes[OUT_SPEAKERS], this.monitorGain());
  }

  private hintFlow(): void {
    const flow = this.bitBuddyEngaged && (this.activeInput === IN_BITBUDDY || !this.pod33Engaged)
      ? FLOW_BITS
      : this.pod33Engaged ? FLOW_TONE : FLOW_MASTER;
    this.onFlowHint?.(flow);
  }

  toggleCrosspoint(row: number, col: number): void {
    if (col < METERS) {
      // A meter input takes one source: the new crosspoint replaces the old, and the
      // meter's INPUT button follows (the host assigns and plays it).
      this.matrix.forEach((r, i) => { r[col] = i === row; });
      this.refresh();
      this.onMeterInput?.(col + 1, row);
      return;
    }
    this.matrix[row][col] = !this.matrix[row][col];
    if (col === OUT_SPEAKERS || col === OUT_CUE) this.syncMonitor(); // the crosspoint is the mute
    this.refresh();
  }

  selectInput(idx: number): void {
    this.activeInput = idx;
    const audio = this.audio;
    this.resumeAudio();
    if (idx === IN_POD33) this.setPod33(true, false);
    else if (idx === IN_BITBUDDY) this.setBitBuddy(true, false);
    else if (audio) {
      if (idx === 0) audio.connectSoundCard();
      else if (idx === 1) audio.connectSystemAudio('browser');
      else if (idx === 4) audio.startTestGenerator('pink');
    }
    this.syncMonitor();
    this.hintFlow();
    this.refresh();
  }

  /** Force a source onto Monitor 1 (speakers) and unmute it. */
  routeToSpeakers(idx: number = this.activeInput): void {
    if (idx !== this.activeInput) this.selectInput(idx);
    this.matrix[idx][OUT_SPEAKERS] = true;
    this.outMutes[OUT_SPEAKERS] = false;
    this.resumeAudio();
    this.audio?.setMonitor(true, this.monitorGain());
    this.post('/api/force_speakers');
    this.refresh();
  }

  /** Mirror the meter's INPUT 1-4 assignments: inputs[n] = router input on button n+1, or null. */
  setMeterInputs(inputs: (number | null)[]): void {
    for (let c = 0; c < METERS; c++) this.matrix.forEach((r, i) => { r[c] = inputs[c] === i; });
    this.meterInputs = inputs.slice(0, METERS);
    if (this.built) this.refresh();
  }

  applyPreset(name: string): void {
    const p = PRESETS[name];
    if (!p) return;
    this.matrix = cloneMatrix(p.matrix);
    for (let c = 0; c < METERS; c++) this.matrix.forEach((r, i) => { r[c] = this.meterInputs[c] === i; });
    if (p.select !== undefined) this.selectInput(p.select);
    else this.refresh();
  }

  private toggleOut(kind: 'mute' | 'dim', idx: number): void {
    const arr = kind === 'mute' ? this.outMutes : this.outDims;
    arr[idx] = !arr[idx];
    if (idx === OUT_SPEAKERS || idx === OUT_CUE) {
      if (kind === 'mute') this.syncMonitor();
      else this.audio?.setMonitorVolume(this.monitorGain());
    }
    this.refresh();
  }

  setPod33(on: boolean, sync = true): void {
    this.pod33Engaged = on;
    this.matrix[IN_POD33][OUT_SPEAKERS] = on;
    if (on) this.audio?.startPod33Generator(this.pod33Config);
    else this.audio?.stopPod33Generator();
    this.restartSpitterIfExt();
    this.post('/api/test_tone', { freq: this.pod33Config.freq, restart: on });
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  setBitBuddy(on: boolean, sync = true): void {
    this.bbLocalAt = Date.now();
    this.post('/api/bitbuddy', on ? this.bitBuddyPayload() : { active: false });
    this.applyBitBuddy(on, sync);
  }

  /** Local state for the shared Bit Buddy; sound comes from the browser only when the daemon is away. */
  private applyBitBuddy(on: boolean, sync = true): void {
    this.bitBuddyEngaged = on;
    this.matrix[IN_BITBUDDY][OUT_SPEAKERS] = on;
    if (on && !this.daemonOnline) this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
    else this.audio?.stopBitBuddyGenerator();
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  private bitBuddyPayload() {
    const b = this.bitBuddyConfig;
    return {
      active: true, pattern: b.pattern, pro_mode: b.proMode, audio_data: b.audioData === 'audio', sample_rate: b.sampleRate,
      level_db: b.level, tone_hz: b.tone, ext: b.ext, ch_b: b.bOff ? 'off' : b.invert ? (b.cycle ? 'cycle_invert' : 'invert') : b.cycle ? 'cycle' : 'on',
      validity: b.invalid,
    };
  }

  /**
   * ABS-1 SAMPLE RATE = EXT locks to an AES reference. In XTM the reference is
   * the POD-33 DARS generator: engaged at a rate the CS8412 accepts (30-50 kHz).
   */
  get extRefLocked(): boolean {
    return this.pod33Engaged && this.pod33Config.refClock !== 'int96';
  }

  /** Config handed to the audio engine: `ext` there means "EXT selected and unlocked" (muted). */
  private spitterAudioConfig(): BitBuddyConfig {
    const b = this.bitBuddyConfig;
    return { ...b, ext: b.ext && !this.extRefLocked };
  }

  private restartSpitterIfExt(): void {
    if (this.bitBuddyEngaged && this.bitBuddyConfig.ext && !this.daemonOnline) this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
  }

  /** Update POD-33 settings (restarts the generator if it is running). */
  setPod33Config(patch: Partial<Pod33Config>): void {
    Object.assign(this.pod33Config, patch);
    if (this.pod33Engaged) this.audio?.startPod33Generator(this.pod33Config);
    this.restartSpitterIfExt();
    this.refresh();
  }

  /** Update ABB-1 settings (restarts the generator if it is running). */
  setBitBuddyConfig(patch: Partial<BitBuddyConfig>): void {
    Object.assign(this.bitBuddyConfig, patch);
    if (!this.bitBuddyEngaged) { /* off: just remember the settings */ }
    else if (this.daemonOnline) this.post('/api/bitbuddy', { ...this.bitBuddyPayload(), restart: true });
    else this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
    this.refresh();
  }

  /** Subscribe to state changes (routing, generators, mutes). Returns an unsubscribe function. */
  onChange(cb: (router: WebRouter) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ───────────────────────────── visuals ─────────────────────────────

  /** True while an MXL flow picked elsewhere (Data view) is the meter source instead of a router input. */
  get externalSource(): boolean {
    return this.audio?.sourceType === 'mxl';
  }

  private isInputLive(i: number): boolean {
    return (i === this.activeInput && !this.externalSource) || (i === IN_POD33 && this.pod33Engaged) || (i === IN_BITBUDDY && this.bitBuddyEngaged);
  }

  /** Sync every button/LED/class to current state. Cheap; called after each change. */
  refresh(): void {
    const root = this.container;
    root.querySelectorAll<HTMLElement>('.wr-matrix-btn').forEach((b) => {
      b.classList.toggle('connected', this.matrix[+b.dataset.row!][+b.dataset.col!]);
    });
    INPUTS.forEach((_, i) => {
      const live = this.isInputLive(i);
      root.querySelector(`#wrInStrip${i}`)?.classList.toggle('selected', live);
      const eng = root.querySelector<HTMLElement>(`[data-in-idx="${i}"]`);
      if (eng) { eng.classList.toggle('engaged', live); eng.title = live ? 'Routed' : 'Engage'; }
      root.querySelector(`#wrInStrip${i}`)?.closest('tr')?.classList.toggle('live', live);
    });
    OUTPUTS.forEach((_, i) => {
      root.querySelector(`[data-out-dim="${i}"]`)?.classList.toggle('active', this.outDims[i]);
    });
    const fader = root.querySelector<HTMLInputElement>('[data-out-level]');
    if (fader && document.activeElement !== fader) fader.value = String(this.speakerLevel);
    // An output column is live when any live input is routed to it.
    OUTPUTS.forEach((_, o) => {
      const on = INPUTS.some((_, r) => this.isInputLive(r) && this.matrix[r][o]);
      root.querySelector(`#wrOutStrip${o}`)?.classList.toggle('selected', on);
    });

    this.listeners.forEach((cb) => cb(this));
  }

  // ───────────────────────────── metering ─────────────────────────────

  private pod33Db(): [number, number] {
    const { levelDb: cal, channelMode: m } = this.pod33Config;
    return [m === 'right' ? -60 : cal, m === 'left' ? -60 : cal];
  }

  private bitBuddyDb(): [number, number] {
    const b = this.bitBuddyConfig, p = b.pattern;
    if (b.ext && !this.extRefLocked) return [-60, -60]; // EXT with no reference: clock stopped, muted
    const base = p === 'tone' ? (b.level === null ? -60 : b.level) : p === 'minmax' ? -1 : -14;
    const j = p === 'tone' ? 0 : Math.sin(Date.now() / 90) * 1.5;
    const bMuted = b.bOff || (b.cycle && Math.floor(Date.now() / 520) % 2 === 1);
    return [base + j, bMuted ? -60 : base - j];
  }

  private setMeter(l: Element | undefined, r: Element | undefined, dbL: number, dbR: number): void {
    l?.setAttribute('transform', `rotate(${vuDbToAngle(dbL).toFixed(1)} ${PIVOT_L} ${PIVOT_Y})`);
    r?.setAttribute('transform', `rotate(${vuDbToAngle(dbR).toFixed(1)} ${PIVOT_R} ${PIVOT_Y})`);
  }

  /** The shared tab behind CH 2 (from the audio engine), or null when nothing is shared. */
  get tabInfo(): BrowserTabInfo | null {
    const t = this.audio?.tabInfo;
    return t && t.live ? t : null;
  }

  /** Name CH 2 after the shared tab and show its origin, format and live level. */
  private renderTabStrip(levels?: WebRouterLevels | null): void {
    const t = this.tabInfo;
    const key = t ? `${t.title}|${t.origin}|${t.sampleRate}|${t.channelCount}|${t.startedAt}` : '';
    if (key !== this.tabKey) {
      this.tabKey = key;
      this.tabPeak = -120;
      const kind = !t ? 'Browser Tab' : t.surface === 'browser' ? 'Tab' : t.surface === 'window' ? 'Window' : 'Screen';
      const name = t ? `${kind}: ${t.title}` : 'Browser Tab';
      const nameEl = this.container.querySelector('#wrInName' + IN_TAB);
      if (nameEl) nameEl.textContent = name;
      const row = this.container.querySelector('#wrRowName' + IN_TAB);
      if (row) { row.textContent = `${IN_TAB + 1}: ${name.length > 30 ? name.slice(0, 29) + '…' : name}`; (row as HTMLElement).title = t ? this.tabTooltip(t) : ''; }
      const strip = this.container.querySelector<HTMLElement>('#wrInStrip' + IN_TAB);
      if (strip) strip.title = t ? this.tabTooltip(t) : `${INPUTS[IN_TAB].name} — ${INPUTS[IN_TAB].sub}`;
    }
    if (!this.tabInfoEl) return;
    if (!t) { this.tabInfoEl.textContent = ''; return; }
    const live = this.activeInput === IN_TAB && levels?.dbfs;
    let lvl = '';
    if (live) {
      const pk = Math.max(levels!.dbfs![0], levels!.dbfs![1]);
      this.tabPeak = Math.max(pk, this.tabPeak - 0.15); // slow-falling peak hold
      lvl = ` · ${pk > -100 ? pk.toFixed(1) : '-∞'} dBFS (pk ${this.tabPeak > -100 ? this.tabPeak.toFixed(1) : '-∞'})`;
    }
    const fmt = [t.origin, t.sampleRate ? `${(t.sampleRate / 1000).toFixed(1)} kHz` : '', t.channelCount ? `${t.channelCount} ch` : '']
      .filter(Boolean).join(' · ');
    this.tabInfoEl.textContent = `${fmt}${lvl}`;
  }

  private tabTooltip(t: BrowserTabInfo): string {
    const lines = [
      `Shared ${t.surface === 'browser' ? 'tab' : t.surface}: ${t.title}`,
      t.origin ? `Origin: ${t.origin}` : '',
      t.audioLabel ? `Audio track: ${t.audioLabel}` : '',
      t.sampleRate ? `Format: ${t.sampleRate} Hz · ${t.channelCount ?? '?'} ch` : '',
      t.width && t.height ? `Surface: ${t.width}×${t.height}` : '',
      `Shared since ${new Date(t.startedAt).toLocaleTimeString()}`,
    ];
    return lines.filter(Boolean).join('\n');
  }

  /** Per-frame hook: move needles from the host's live levels. */
  render(levels?: WebRouterLevels | null): void {
    if (!this.built || !this.container.isConnected || this.container.offsetParent === null) return;
    const vuL = levels?.vuDb ? levels.vuDb[0] : -60;
    const vuR = levels?.vuDb ? levels.vuDb[1] : -60;
    const n = this.needles;
    if (this.externalSource !== this.wasExternal) { this.wasExternal = this.externalSource; this.refresh(); }
    this.renderTabStrip(levels);

    INPUTS.forEach((_, i) => {
      let db: [number, number] = [-60, -60];
      if (i === IN_POD33 && this.pod33Engaged) db = this.pod33Db();
      else if (i === IN_BITBUDDY && this.bitBuddyEngaged) db = this.bitBuddyDb();
      else if (i === this.activeInput && !this.externalSource && (i !== IN_TAB || this.tabInfo)) db = [vuL, vuR];
      this.setMeter(n.inL[i], n.inR[i], db[0], db[1]);
    });

    OUTPUTS.forEach((_, o) => {
      const dim = (this.outDims[o] ? -20 : 0)
        + (o === OUT_SPEAKERS ? 20 * Math.log10(Math.max(1e-3, this.speakerLevel)) : 0);
      let db: [number, number] = [-60, -60];
      if (!this.outMutes[o]) {
        if ((o === OUT_POD33 || o === OUT_POD33_LOW) && this.pod33Engaged) db = this.pod33Db();
        else if (o === OUT_BITS && this.bitBuddyEngaged) {
          // The transmitter's L channel blinks on the Bit Spitter's ~0.5 s cycle
          const bits = this.bitBuddyDb();
          db = [Math.floor(Date.now() / 520) % 2 === 1 ? -60 : bits[0], bits[1]];
        }
        else if (INPUTS.some((_, r) => this.isInputLive(r) && this.matrix[r][o])) db = [vuL, vuR];
        else if (this.externalSource && o < METERS) db = [vuL, vuR]; // an MXL flow drives the meters directly
        db = [clampDb(db[0] + dim), clampDb(db[1] + dim)];
      }
      this.setMeter(n.outL[o], n.outR[o], db[0], db[1]);
    });
  }
}
