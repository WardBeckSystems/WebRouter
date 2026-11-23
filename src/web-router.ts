/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/**
 * Web Router — Ward-Beck Systems browser routing console.
 *
 *   INPUT SOURCES  │  CROSSPOINT MATRIX  │  OUTPUT DESTINATIONS
 *
 * The router owns the POD-33 and ABB-1 generator state (CH 3 / CH 4 engage
 * them), but not their control panels: a host can build those against
 * setPod33 / setPod33Config / setBitBuddy / setBitBuddyConfig / onChange.
 *
 * 5 inputs × 7 outputs. Strips are compact: name + level readout on one
 * line, a stereo VU pair, and one row of actions.
 */

import {
  DEFAULT_BITBUDDY_CONFIG,
  DEFAULT_POD33_CONFIG,
  type BitBuddyConfig,
  type Pod33Config,
  type RouterChannel,
  type WebRouterAudio,
  type WebRouterLevels,
  type WebRouterOptions,
} from './types';
import { PIVOT_L, PIVOT_R, clampDb, renderMeterPair, vuDbToAngle } from './vu-meter';

export const INPUTS: RouterChannel[] = [
  { tag: 'CH 1', name: 'Soundcard In', sub: 'Mic / Line In', pill: 'mic' },
  { tag: 'CH 2', name: 'System Audio', sub: 'Desktop / YouTube', pill: 'sys' },
  { tag: 'CH 3', name: 'POD-33 Tone', sub: 'DARS 100/400/1k', pill: 'pod' },
  { tag: 'CH 4', name: 'Bit Buddy', sub: 'ABP-1 Bit Spitter', pill: 'abb' },
  { tag: 'CH 5', name: 'Pink / Sweep', sub: 'Noise Reference', pill: 'noise' },
];

export const OUTPUTS: RouterChannel[] = [
  { tag: 'OUT 1', name: 'XTM-4 Master', sub: 'wbs-flow-master-stereo', pill: 'out' },
  { tag: 'OUT 2', name: 'POD-22 Loudness', sub: 'ITU-R BS.1770 Bar', pill: 'out' },
  { tag: 'OUT 3', name: 'Monitor 1 / Speakers', sub: 'Physical ALSA HW', pill: 'out' },
  { tag: 'OUT 4', name: 'Studio Cue / HP', sub: 'Control Room Listen', pill: 'out' },
  { tag: 'OUT 5', name: 'Ward-Beck Tap', sub: 'WBS Test Point Tap', pill: 'out' },
  { tag: 'OUT 6', name: 'POD-33 Tone Out', sub: 'wbs-flow-ref-tone DARS', pill: 'out' },
  { tag: 'OUT 7', name: 'Bit Spitter Out', sub: 'wbs-flow-bit-spitter ABP-1', pill: 'out' },
];

const SHORT_OUT = ['XTM-4', 'POD-22', 'Speakers', 'Cue/HP', 'Test Tap', 'POD-33', 'Bit Spitter'];

/** Column indices with special meaning. */
const OUT_SPEAKERS = 2;
const OUT_CUE = 3;
const IN_POD33 = 2;
const IN_BITBUDDY = 3;

const FLOW_MASTER = 'wbs-flow-master-stereo';
const FLOW_TONE = 'wbs-flow-ref-tone';
const FLOW_BITS = 'wbs-flow-bit-spitter';

const PRESETS: Record<string, { matrix: boolean[][]; select?: number }> = {
  broadcast: {
    select: 1,
    matrix: [
      [true, true, false, false, false, false, false],
      [true, true, true, false, false, false, false],
      [true, true, true, false, false, true, false],
      [true, true, true, false, false, false, true],
      [true, true, true, false, false, false, false],
    ],
  },
  pod33: {
    select: 2,
    matrix: [
      [true, true, false, false, false, false, false],
      [true, true, true, false, false, false, false],
      [true, true, true, true, true, true, false],
      [true, true, true, false, false, false, true],
      [true, true, true, false, false, false, false],
    ],
  },
  bitbuddy: {
    select: 3,
    matrix: [
      [true, true, false, false, false, false, false],
      [true, true, true, false, false, false, false],
      [true, true, true, false, false, true, false],
      [true, true, true, true, true, false, true],
      [true, true, true, false, false, false, false],
    ],
  },
  all: {
    matrix: Array.from({ length: 5 }, () => [true, true, true, false, false, true, true]),
  },
};

const cloneMatrix = (m: boolean[][]) => m.map((row) => row.slice());

export class WebRouter {
  readonly container: HTMLElement;
  private audio: WebRouterAudio | null;
  private daemonUrl: string;
  private onFlowHint?: (flowId: string) => void;

  /** Rows = inputs, columns = outputs. Soundcard is kept off the speakers to avoid feedback. */
  matrix: boolean[][] = cloneMatrix(PRESETS.broadcast.matrix);
  outMutes: boolean[] = new Array(OUTPUTS.length).fill(false);
  outDims: boolean[] = new Array(OUTPUTS.length).fill(false);
  activeInput = 1; // System Audio

  pod33Config: Pod33Config = { ...DEFAULT_POD33_CONFIG };
  bitBuddyConfig: BitBuddyConfig = { ...DEFAULT_BITBUDDY_CONFIG };
  pod33Engaged = false;
  bitBuddyEngaged = false;

  private needles: { inL: Element[]; inR: Element[]; outL: Element[]; outR: Element[] } = { inL: [], inR: [], outL: [], outR: [] };
  private inDigits: Element[] = [];
  private outDigits: Element[] = [];
  private built = false;
  private listeners = new Set<(router: WebRouter) => void>();

  constructor(container: HTMLElement, opts: WebRouterOptions = {}) {
    this.container = container;
    this.audio = opts.audio ?? null;
    this.daemonUrl = (opts.daemonUrl ?? 'http://localhost:8467').replace(/\/$/, '');
    this.onFlowHint = opts.onFlowHint;
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
    this.inDigits = INPUTS.map((_, i) => q(`#wrInDb${i}`));
    this.outDigits = OUTPUTS.map((_, i) => q(`#wrOutDb${i}`));
    this.attachEvents();
    this.refresh();
    this.built = true;
    return this;
  }

  setAudio(audio: WebRouterAudio | null): void {
    this.audio = audio;
  }

  destroy(): void {
    this.container.innerHTML = '';
    this.built = false;
  }

  // ───────────────────────────── markup ─────────────────────────────

  private renderHtml(): string {
    return `
      <div class="wr-rack">
        <div class="wr-rack-header">
          <div class="wr-header-left">
            <div class="wr-wbs-badge"><span class="wr-wbs-mark">WBS</span><span class="wr-rack-code">WEB ROUTER</span></div>
            <div>
              <div class="wr-header-title">WARD-BECK SYSTEMS // WEB ROUTER</div>
              <div class="wr-header-sub">5 inputs × 7 outputs · crosspoint matrix</div>
            </div>
          </div>
          <div class="wr-matrix-presets" role="group" aria-label="Router presets">
            <button type="button" class="wr-btn-preset" data-preset="broadcast">Default</button>
            <button type="button" class="wr-btn-preset" data-preset="pod33">1kHz Cal</button>
            <button type="button" class="wr-btn-preset" data-preset="bitbuddy">Bit Spitter</button>
            <button type="button" class="wr-btn-preset" data-preset="all">Mix All</button>
          </div>
        </div>

        <div class="wr-bays">
          <section class="wr-bay wr-inputs-bay" aria-label="Input sources">
            <div class="wr-bay-header"><span>INPUT SOURCES</span><span class="wr-bay-sub">${INPUTS.length} CH</span></div>
            <div class="wr-channel-strips">${INPUTS.map((c, i) => this.renderInputStrip(c, i)).join('')}</div>
          </section>

          <section class="wr-bay wr-matrix-card" aria-label="Crosspoint matrix">
            <div class="wr-matrix-header">
              <span>CROSSPOINT MATRIX</span>
              <button type="button" class="wr-btn-master-speakers" id="wrRouteThisToSpeakers" title="Route the selected input to Monitor 1 (speakers)">🔊 SELECTED → SPEAKERS</button>
            </div>
            <div class="wr-matrix-table-wrap">
              <table class="wr-matrix-table">
                <thead><tr>
                  <th class="wr-th-blank">IN \\ OUT</th>
                  ${SHORT_OUT.map((s, i) => `<th>${i + 1}<br><span class="wr-th-sub">${s}</span></th>`).join('')}
                </tr></thead>
                <tbody>${INPUTS.map((c, r) => this.renderMatrixRow(c, r)).join('')}</tbody>
              </table>
            </div>
          </section>

          <section class="wr-bay wr-outputs-bay" aria-label="Output destinations">
            <div class="wr-bay-header"><span>OUTPUT DESTINATIONS</span><span class="wr-bay-sub">${OUTPUTS.length} BUSES</span></div>
            <div class="wr-channel-strips">${OUTPUTS.map((c, i) => this.renderOutputStrip(c, i)).join('')}</div>
          </section>
        </div>

      </div>`;
  }

  private renderInputStrip(c: RouterChannel, idx: number): string {
    return `
      <div class="wr-strip wr-in-strip" id="wrInStrip${idx}" title="${c.name} — ${c.sub}">
        <div class="wr-strip-top">
          <span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>
          <span class="wr-strip-name">${c.name}</span>
          <span class="wr-strip-digits" id="wrInDb${idx}">—</span>
        </div>
        ${renderMeterPair('wrIn', idx)}
        <div class="wr-in-actions">
          <button type="button" class="wr-btn-engage" data-in-idx="${idx}">ENGAGE</button>
          <button type="button" class="wr-btn-to-speakers" data-to-speakers="${idx}" title="Route ${c.name} to Monitor 1 (speakers)">🔊 SPK</button>
        </div>
      </div>`;
  }

  private renderOutputStrip(c: RouterChannel, idx: number): string {
    return `
      <div class="wr-strip wr-out-strip" id="wrOutStrip${idx}" title="${c.name} — ${c.sub}">
        <div class="wr-strip-top">
          <span class="wr-strip-tag wr-pill-out">${c.tag}</span>
          <span class="wr-strip-name">${c.name}</span>
          <span class="wr-strip-digits" id="wrOutDb${idx}">—</span>
        </div>
        ${renderMeterPair('wrOut', idx)}
        <div class="wr-out-btns">
          <button type="button" class="wr-btn-out-tool wr-btn-mute" data-out-mute="${idx}">MUTE</button>
          <button type="button" class="wr-btn-out-tool wr-btn-dim" data-out-dim="${idx}">-20dB</button>
        </div>
      </div>`;
  }

  private renderMatrixRow(c: RouterChannel, row: number): string {
    const cells = OUTPUTS.map((o, col) => `
      <td class="wr-td-crosspoint">
        <button type="button" class="wr-matrix-btn" data-row="${row}" data-col="${col}" title="${c.name} → ${o.name}" aria-label="${c.name} to ${o.name}">
          <span class="wr-matrix-led"></span>
        </button>
      </td>`).join('');
    return `<tr><th class="wr-th-row">${row + 1}: ${c.name}</th>${cells}</tr>`;
  }

  // ───────────────────────────── events ─────────────────────────────

  private attachEvents(): void {
    const root = this.container;
    // One delegated listener: every control carries a data-* attribute.
    root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('button');
      if (!t || !root.contains(t)) return;
      const d = t.dataset;
      if (d.row !== undefined) return this.toggleCrosspoint(+d.row, +(d.col ?? 0));
      if (d.inIdx !== undefined) return this.selectInput(+d.inIdx);
      if (d.toSpeakers !== undefined) return this.routeToSpeakers(+d.toSpeakers);
      if (d.preset !== undefined) return this.applyPreset(d.preset);
      if (d.outMute !== undefined) return this.toggleOut('mute', +d.outMute);
      if (d.outDim !== undefined) return this.toggleOut('dim', +d.outDim);
      if (t.id === 'wrRouteThisToSpeakers') return this.routeToSpeakers(this.activeInput);
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
    return this.outDims[OUT_SPEAKERS] ? 0.1 : 0.8;
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
    this.matrix[row][col] = !this.matrix[row][col];
    if (this.matrix[row][0] && row !== this.activeInput) {
      this.selectInput(row); // connecting to master engages the source
      return;
    }
    if (row === this.activeInput && (col === OUT_SPEAKERS || col === OUT_CUE)) this.syncMonitor();
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

  applyPreset(name: string): void {
    const p = PRESETS[name];
    if (!p) return;
    this.matrix = cloneMatrix(p.matrix);
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
    this.matrix[IN_POD33][0] = on;
    this.matrix[IN_POD33][OUT_SPEAKERS] = on;
    if (on) this.audio?.startPod33Generator(this.pod33Config);
    else this.audio?.stopPod33Generator();
    this.post('/api/test_tone', { freq: this.pod33Config.freq, restart: on });
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  setBitBuddy(on: boolean, sync = true): void {
    this.bitBuddyEngaged = on;
    this.matrix[IN_BITBUDDY][0] = on;
    this.matrix[IN_BITBUDDY][OUT_SPEAKERS] = on;
    if (on) this.audio?.startBitBuddyGenerator(this.bitBuddyConfig);
    else this.audio?.stopBitBuddyGenerator();
    this.post('/api/bitbuddy', on ? this.bitBuddyPayload() : { active: false });
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  private bitBuddyPayload() {
    const b = this.bitBuddyConfig;
    return { active: true, pattern: b.pattern, pro_mode: b.proMode, audio_data: b.audioData === 'audio', sample_rate: b.sampleRate };
  }

  /** Update POD-33 settings (restarts the generator if it is running). */
  setPod33Config(patch: Partial<Pod33Config>): void {
    Object.assign(this.pod33Config, patch);
    if (this.pod33Engaged) this.audio?.startPod33Generator(this.pod33Config);
    this.refresh();
  }

  /** Update ABB-1 settings (restarts the generator if it is running). */
  setBitBuddyConfig(patch: Partial<BitBuddyConfig>): void {
    Object.assign(this.bitBuddyConfig, patch);
    if (this.bitBuddyEngaged) this.audio?.startBitBuddyGenerator(this.bitBuddyConfig);
    this.refresh();
  }

  /** Subscribe to state changes (routing, generators, mutes). Returns an unsubscribe function. */
  onChange(cb: (router: WebRouter) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // ───────────────────────────── visuals ─────────────────────────────

  private isInputLive(i: number): boolean {
    return i === this.activeInput || (i === IN_POD33 && this.pod33Engaged) || (i === IN_BITBUDDY && this.bitBuddyEngaged);
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
      if (eng) { eng.classList.toggle('engaged', live); eng.textContent = live ? '● ROUTED' : 'ENGAGE'; }
      root.querySelector(`[data-to-speakers="${i}"]`)?.classList.toggle('active', this.matrix[i][OUT_SPEAKERS] && !this.outMutes[OUT_SPEAKERS]);
    });
    OUTPUTS.forEach((_, i) => {
      const m = root.querySelector<HTMLElement>(`[data-out-mute="${i}"]`);
      if (m) { m.classList.toggle('active', this.outMutes[i]); m.textContent = this.outMutes[i] ? 'MUTED' : 'MUTE'; }
      root.querySelector(`[data-out-dim="${i}"]`)?.classList.toggle('active', this.outDims[i]);
    });
    const spk = root.querySelector<HTMLElement>('#wrRouteThisToSpeakers');
    if (spk) {
      const on = this.matrix[this.activeInput][OUT_SPEAKERS] && !this.outMutes[OUT_SPEAKERS];
      spk.classList.toggle('active', on);
      spk.classList.toggle('inactive', !on);
      spk.textContent = on ? '🔊 SELECTED ON SPEAKERS' : '🔊 SELECTED → SPEAKERS';
    }

    this.listeners.forEach((cb) => cb(this));
  }

  // ───────────────────────────── metering ─────────────────────────────

  private pod33Db(): [number, number] {
    const { levelDb: cal, channelMode: m } = this.pod33Config;
    return [m === 'right' ? -60 : cal, m === 'left' ? -60 : cal];
  }

  private bitBuddyDb(): [number, number] {
    const p = this.bitBuddyConfig.pattern;
    const base = p === 'tone' ? -18 : p === 'minmax' ? -1 : -14;
    const j = p === 'tone' ? 0 : Math.sin(Date.now() / 90) * 1.5;
    return [base + j, base - j];
  }

  private setMeter(l: Element | undefined, r: Element | undefined, digits: Element | undefined, dbL: number, dbR: number): void {
    l?.setAttribute('transform', `rotate(${vuDbToAngle(dbL).toFixed(1)} ${PIVOT_L} 42)`);
    r?.setAttribute('transform', `rotate(${vuDbToAngle(dbR).toFixed(1)} ${PIVOT_R} 42)`);
    if (digits) digits.textContent = dbL > -55 || dbR > -55 ? `${clampDb(dbL).toFixed(1)} / ${clampDb(dbR).toFixed(1)}` : '—';
  }

  /** Per-frame hook: move needles from the host's live levels. */
  render(levels?: WebRouterLevels | null): void {
    if (!this.built || !this.container.isConnected || this.container.offsetParent === null) return;
    const vuL = levels?.vuDb ? levels.vuDb[0] : -60;
    const vuR = levels?.vuDb ? levels.vuDb[1] : -60;
    const n = this.needles;

    INPUTS.forEach((_, i) => {
      let db: [number, number] = [-60, -60];
      if (i === IN_POD33 && this.pod33Engaged) db = this.pod33Db();
      else if (i === IN_BITBUDDY && this.bitBuddyEngaged) db = this.bitBuddyDb();
      else if (i === this.activeInput) db = [vuL, vuR];
      this.setMeter(n.inL[i], n.inR[i], this.inDigits[i], db[0], db[1]);
    });

    OUTPUTS.forEach((_, o) => {
      const dim = this.outDims[o] ? -20 : 0;
      let db: [number, number] = [-60, -60];
      if (!this.outMutes[o]) {
        if (o === 5 && this.pod33Engaged) db = this.pod33Db();
        else if (o === 6 && this.bitBuddyEngaged) db = this.bitBuddyDb();
        else if (INPUTS.some((_, r) => this.isInputLive(r) && this.matrix[r][o])) db = [vuL, vuR];
        db = [clampDb(db[0] + dim), clampDb(db[1] + dim)];
      }
      this.setMeter(n.outL[o], n.outR[o], this.outDigits[o], db[0], db[1]);
    });
  }
}
