/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/**
 * Web Router — Ward-Beck Systems browser routing console.
 *
 *   One grid: each input row starts with its strip (name · level · VU ·
 *   always listening, click to play) followed by its crosspoints; the bottom row holds each
 *   output's name · VU · level · -20 dB. A crosspoint is the mute: there
 *   are no separate mute or "to speakers" buttons.
 *
 * The router owns the POD-33 and ABB-1 generator state (CH 3 / CH 4 engage
 * them), but not their control panels: a host can build those against
 * setPod33 / setPod33Config / setBitBuddy / setBitBuddyConfig / onChange.
 *
 * 9 inputs × 10 outputs. CH 8 / CH 9 are dedicated receivers: the TAP joins the
 * chosen network (AES67 / RAVENNA / SAP) or MoIP stream into its own MXL ring.
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
import { PIVOT_L, PIVOT_R, PIVOT_Y, clampDb, renderArtMeterPair, renderMeterPair, vuDbToAngle, artTemplate, type MeterArt } from './vu-meter';
import { HwOutputs } from './hw-outputs';

export const INPUTS: RouterChannel[] = [
  { tag: 'CH 1', name: 'Soundcard In', sub: 'Mic / Line In', pill: 'mic' },
  { tag: 'CH 2', name: 'Browser Tab', sub: 'Shared tab audio (getDisplayMedia)', pill: 'sys' },
  // POD-33: one unit, its four rear AES outputs (one ENGAGE powers all four)
  { tag: 'CH 3', name: 'POD-33 AES1', sub: 'POD-33 DARS rear AES1 out (100/400/1k)', pill: 'pod' },
  { tag: 'CH 4', name: 'POD-33 AES2', sub: 'POD-33 DARS rear AES2 out (100/400/1k)', pill: 'pod' },
  { tag: 'CH 5', name: 'POD-33 AES3', sub: 'POD-33 DARS rear AES3 out (100/400/1k)', pill: 'pod' },
  { tag: 'CH 6', name: 'POD-33 AES4', sub: 'POD-33 DARS rear AES4 out (100/400/1k)', pill: 'pod' },
  { tag: 'CH 7', name: 'Bit Buddy', sub: 'ABS-1 Bit Spitter', pill: 'abb' },
  // Dedicated receivers: the TAP joins the stream (RTP from its SAP SDP) into its own MXL ring
  { tag: 'CH 8', name: 'Network', sub: 'AES67 / RAVENNA / SAP stream received by the TAP, folded to stereo by its AMS-81 (MXL flow wbs-network-ams81)', pill: 'net' },
  { tag: 'CH 9', name: 'MoIP', sub: 'MoIP stream received by the TAP, folded to stereo by its AMS-81 (MXL flow wbs-moip-ams81)', pill: 'moip' },
];

/** Receiver rows: TAP receiver slot, the flow played and metered (its AMS-81 stereo fold-down)
 *  and the full multichannel flow it receives (the Receivers tab's ring eye). */
export const RECEIVERS: Record<number, { slot: 'network' | 'moip'; flow: string; rx: string }> = {
  7: { slot: 'network', flow: 'wbs-network-ams81', rx: 'wbs-network-rx' },
  8: { slot: 'moip', flow: 'wbs-moip-ams81', rx: 'wbs-moip-rx' },
};

/** A receiver's AMS-81 fold-down, as GET /api/ams81 reports it. */
interface Ams81 { select: string; presets: Record<string, { L: (number | null)[]; R: (number | null)[] }>; flow_id: string }
const AMS_PAIRS = ['1/2', '3/4', '5/6', '7/8'];
const AMS_PRESETS = ['A', 'B', 'C', 'D'];
const amsSel = (v: string) => (v === 'Lo/Ro' ? 'LoRo' : v);
const isRxRow = (i: number) => RECEIVERS[i] !== undefined;

/** A stream the TAP heard announced (SAP), as offered in a receiver's picker. */
export interface RxStream { id: string; name: string; addr: string }

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
  // The four Transmitters
  { tag: 'MXL67-1', name: 'Repeater', sub: 'MXL flow wbs-flow-master-stereo (repeats the routed mix) → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL67-2', name: 'POD-33 1 kHz', sub: 'MXL flow POD-33-1kHz-Reference → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL67-3', name: 'POD-33 400 / 100 Hz', sub: 'MXL flow wbs-flow-ref-tone-low, 400 or 100 Hz (click the name to switch) → /dev/shm/mxl', pill: 'mxl' },
  { tag: 'MXL67-4', name: 'Bit Spitter', sub: 'MXL flow wbs-flow-bit-spitter → /dev/shm/mxl', pill: 'mxl' },
  // Loop outs: the receivers' stereo fold-downs sent on again
  { tag: 'MXL67-5', name: 'Network loop out', sub: 'MXL flow wbs-network-ams81 (CH 8 Network, its AMS-81 fold-down) → AES67', pill: 'mxl' },
  { tag: 'MXL67-6', name: 'MoIP loop out', sub: 'MXL flow wbs-moip-ams81 (CH 9 MoIP, its AMS-81 fold-down) → AES67', pill: 'mxl' },
];

const SHORT_OUT = ['Input 1', 'Input 2', 'Input 3', 'Input 4', 'Speakers', 'Cue/HP', 'Repeater', '1 kHz', '400 Hz', 'Bit Spitter', 'Network out', 'MoIP out'];

/** The MXL flow each transmitter column writes (MXL 3 follows its 400 / 100 Hz switch). */
const MXL_FLOW: Record<number, string> = {
  6: 'wbs-flow-master-stereo',
  7: 'wbs-flow-ref-tone',
  8: 'wbs-flow-ref-tone-low', // 400 or 100 Hz (its switch)
  9: 'wbs-flow-bit-spitter',
  10: 'wbs-network-ams81',
  11: 'wbs-moip-ams81',
};

/** Column indices with special meaning. */
const METERS = 4; // columns 0-3: Meter Input 1-4
const OUT_SPEAKERS = 4;
const OUT_CUE = 5;
const OUT_REPEATER = 6;
const OUT_POD33 = 7;
const OUT_POD33_LOW = 8; // 400 / 100 Hz, switchable
const OUT_BITS = 9;
const OUT_NET_LOOP = 10;
const OUT_MOIP_LOOP = 11;
const IN_POD33 = 2; // POD-33 AES1; AES2-4 are the next three rows
const POD33_OUTS = 4;
const IN_BITBUDDY = IN_POD33 + POD33_OUTS;
const IN_TAB = 1;
const IN_SOUNDCARD = 0;
const isPod33Row = (i: number) => i >= IN_POD33 && i < IN_POD33 + POD33_OUTS;

const FLOW_MASTER = 'wbs-flow-master-stereo';
const FLOW_TONE = 'wbs-flow-ref-tone';
const FLOW_BITS = 'wbs-flow-bit-spitter';

const PRESETS_4ROW: Record<string, { matrix: boolean[][]; select?: number }> = {
  broadcast: {
    select: 1,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, false, false, true, false, false],
      [false, false, false, false, true, false, false, false, false, true],
    ],
  },
  pod33: {
    select: 2,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, true, true, true, false, false],
      [false, false, false, false, true, false, false, false, false, true],
    ],
  },
  bitbuddy: {
    select: 3,
    matrix: [
      [false, false, false, false, false, false, false, false, false, false],
      [false, false, false, false, true, false, false, false, false, false],
      [false, false, false, false, true, false, false, true, false, false],
      [false, false, false, false, true, true, true, false, false, true],
    ],
  },
  all: {
    matrix: Array.from({ length: 4 }, () => [false, false, false, false, true, false, false, true, false, true]),
  },
};

/** Presets are written with one POD-33 row; AES1 takes its routes, AES2-4 start unrouted. */
const expandPod33 = (m: boolean[][]): boolean[][] => [
  ...m.slice(0, IN_POD33 + 1),
  ...Array.from({ length: POD33_OUTS - 1 }, () => new Array(m[0].length).fill(false)),
  ...m.slice(IN_POD33 + 1),
];
const toRow = (r: number | undefined) => (r === undefined || r <= IN_POD33 ? r : r + POD33_OUTS - 1);
/** …and the receiver rows start unrouted. */
const withRx = (m: boolean[][]): boolean[][] => [...m, ...Object.keys(RECEIVERS).map(() => new Array(m[0].length).fill(false))];
const PRESETS: Record<string, { matrix: boolean[][]; select?: number }> = Object.fromEntries(
  Object.entries(PRESETS_4ROW).map(([k, p]) => [k, { matrix: withRx(expandPod33(p.matrix)), select: toRow(p.select) }]),
);

const cloneMatrix = (m: boolean[][]) => m.map((row) => [...row, ...new Array(Math.max(0, OUTPUTS.length - row.length)).fill(false)]);

export class WebRouter {
  readonly container: HTMLElement;
  private audio: WebRouterAudio | null;
  private daemonUrl: string;
  private hw: HwOutputs | null = null;
  private onFlowHint?: (flowId: string) => void;
  private onOpenFlow?: (flowId: string) => void;
  private onOpenReceivers?: () => void;
  private onMeterInput?: (meter: number, input: number) => void;
  private onPlayFlow?: (flowId: string) => void;
  /** Streams the TAP has heard announced, offered on CH 8 / CH 9. */
  rxStreams: RxStream[] = [];
  /** What each receiver row is set to (stream id) and the TAP's word on it. */
  rxChoice: Record<number, string> = {};
  rxStatus: Record<number, { active: boolean; status?: string; error?: string | null; hint?: string | null; source?: string; ref?: string; channels?: number }> = {};
  /** AMS-81 fold-down per receiver slot, and which rows show their preset's mix grid */
  private ams81: Record<string, Ams81> = {};
  private amsEdit: Record<number, boolean> = {};
  private rxKey = '';

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
  /**
   * The POD-33's four rear AES outputs (CH 3-6), each with its own frequency, level and
   * channel / phase; the reference lock is the unit's, shared. pod33Config is the output
   * being played (pod33Out).
   */
  pod33Outputs: Pick<Pod33Config, 'freq' | 'freqR' | 'levelDb' | 'channelMode' | 'beep' | 'beepLeft'>[] = Array.from({ length: POD33_OUTS }, () => ({
    freq: DEFAULT_POD33_CONFIG.freq, levelDb: DEFAULT_POD33_CONFIG.levelDb, channelMode: DEFAULT_POD33_CONFIG.channelMode,
  }));
  pod33Out = 0;
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
  private rxIdle = 0;
  private kickTimers: number[] = [];
  /** Each output's last meter reading [L, R] in VU dB (the hardware tab shows HW 1 / HW 2). */
  private outDb: [number, number][] = [];
  /** Own tabs, mounted by the host: the receivers (Network, MoIP) and the hardware grid. */
  private rxEl: HTMLElement | null = null;
  private hwEl: HTMLElement | null = null;
  private tabKey = '';
  private wasExternal = false;
  private tabInfoEl: Element | null = null;
  private tabPeak = -120;
  private listeners = new Set<(router: WebRouter) => void>();
  private wireObserver: ResizeObserver | null = null;
  private cueOn = false;
  private rxStartedAt: Record<number, number> = {};
  /** Each input's own level (VU dB L, R), heard all the time: TAP flows and the sound card. */
  private srcDb: Record<number, [number, number]> = {};
  private srcAt = 0;
  private srcBusy = false;
  private scProbe: { ctx: AudioContext; an: AnalyserNode[]; stream: MediaStream; id: string } | null = null;
  private scBuf = new Float32Array(2048);
  private scOpening = false;
  private scDenied = false;
  /** CH 1: the sound card input it plays ('' = the default input), remembered per browser. */
  scDevice = '';
  private scInputs: { id: string; label: string }[] = [];
  private meterArt?: () => MeterArt | null;
  /** The host's meter, once it exists: every strip shows it in miniature. */
  private art: MeterArt | null = null;
  private artTries = 0;
  /** The host meter element the strip copies were made from (a rebuild replaces it). */
  private artSrc: Element | null = null;
  private wireFrame = 0;

  constructor(container: HTMLElement, opts: WebRouterOptions = {}) {
    this.container = container;
    this.audio = opts.audio ?? null;
    this.daemonUrl = (opts.daemonUrl ?? 'http://localhost:8467').replace(/\/$/, '');
    this.onFlowHint = opts.onFlowHint;
    this.onOpenFlow = opts.onOpenFlow;
    this.onOpenReceivers = opts.onOpenReceivers;
    this.onMeterInput = opts.onMeterInput;
    this.onPlayFlow = opts.onPlayFlow;
    this.meterArt = opts.meterArt;
    try { this.rxChoice = JSON.parse(localStorage.getItem('wr.rxChoice') || '{}') || {}; } catch { /* private window */ }
    try { this.scDevice = localStorage.getItem('wr.scDevice') || ''; } catch { /* private window */ }
    this.setMeterInputs(this.meterInputs);
    this.exclusive(PRESETS.broadcast.select); // one input per output from the start
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
    this.rxKey = '';
    this.fillArt();
    this.attachEvents();
    this.refresh();
    this.built = true;
    this.watchDaemon();
    this.renderRx();
    void this.loadSoundCards();
    if (!this.scWatch && navigator.mediaDevices?.addEventListener) {
      this.scWatch = true;
      navigator.mediaDevices.addEventListener('devicechange', () => void this.loadSoundCards());
    }
    // Wires follow the layout: fonts loading, the tab being shown, the window resizing.
    this.wireObserver?.disconnect();
    this.wireObserver = new ResizeObserver(() => this.queueWires());
    const tbl = this.container.querySelector('.wr-grid');
    if (tbl) this.wireObserver.observe(tbl);
    this.mountHw();
    return this;
  }

  /** The hardware grid (TAP outputs → sound cards) in its own tab. */
  mountHardware(el: HTMLElement): this {
    this.hwEl = el;
    el.innerHTML = `<div class="wr-rack"><div class="wr-grid-card wr-hw-card"></div></div>`;
    this.mountHw();
    return this;
  }

  private mountHw(): void {
    const card = this.hwEl?.querySelector<HTMLElement>('.wr-hw-card');
    if (!card || this.hw) return;
    this.hw = new HwOutputs(card, this.daemonUrl, (tag) =>
      tag === 'HW 1' ? this.outDb[OUT_SPEAKERS] ?? null : tag === 'HW 2' ? this.outDb[OUT_CUE] ?? null : null).mount();
  }

  /** The receivers (CH 9 Network, CH 10 MoIP) in their own tab: which flow each one listens to,
   *  an eye on its ring (drawEye from the host), and a stream entered by hand (address : port,
   *  or a pasted SDP). */
  mountReceivers(el: HTMLElement, drawEye?: (canvas: HTMLCanvasElement, flowId: string) => void): this {
    this.rxEl = el;
    const rows = Object.keys(RECEIVERS).map((k) => {
      const idx = +k;
      const c = INPUTS[idx];
      return `<tr>
        <td class="wr-rx-eye" rowspan="2">${drawEye ? `<canvas width="120" height="120" data-rx-eye="${RECEIVERS[idx].rx}" aria-label="${c.name} ring"></canvas>` : ''}</td>
        <th class="wr-rx-name" scope="row"><span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span> ${c.name}</th>
        <td>
          <select class="wr-rx-pick" data-rx-pick="${idx}" aria-label="${c.name} flow"><option value="">Choose a stream…</option></select>
          <div class="wr-rx-custom" data-rx-custom="${idx}" hidden>
            <span data-rx-ip-row><input type="text" class="wr-rx-in" data-rx-ip="${idx}" placeholder="239.1.2.3:5004" aria-label="${c.name} multicast address and port" spellcheck="false">
              <select class="wr-rx-in" data-rx-ch="${idx}" aria-label="channels">${[1, 2, 4, 8, 16].map((n) => `<option value="${n}"${n === 2 ? ' selected' : ''}>${n} ch</option>`).join('')}</select>
              <select class="wr-rx-in" data-rx-enc="${idx}" aria-label="encoding"><option>L24</option><option>L16</option></select></span>
            <textarea class="wr-rx-in wr-rx-sdp" data-rx-sdp="${idx}" rows="6" placeholder="v=0&#10;o=- 1 1 IN IP4 192.168.1.10&#10;s=My stream&#10;c=IN IP4 239.1.2.3/32&#10;t=0 0&#10;m=audio 5004 RTP/AVP 96&#10;a=rtpmap:96 L24/48000/8&#10;a=ptime:1" aria-label="${c.name} SDP" spellcheck="false"></textarea>
            <button type="button" class="wr-rx-go" data-rx-go="${idx}">Listen</button>
          </div>
        </td>
        <td class="wr-rx-addr" data-rx-addr="${idx}"></td>
        <td class="wr-strip-info wr-rx-info" data-rx-info="${idx}"></td>
      </tr>
      <tr class="wr-ams-row"><td colspan="4">
        <div class="wr-ams" data-ams="${idx}" aria-label="${c.name} AMS-81 fold-down">
          <span class="wr-ams-tag">AMS-81</span>
          <div class="rc-btn-group">${AMS_PAIRS.map((v) => `<button type="button" class="rc-btn-sel" data-ams-sel="${v}">${v}</button>`).join('')}</div>
          <div class="rc-btn-group">${[...AMS_PRESETS, 'LoRo'].map((v) => `<button type="button" class="rc-btn-sel" data-ams-sel="${v}">${v === 'LoRo' ? 'Lo/Ro' : v}</button>`).join('')}</div>
          <button type="button" class="rc-btn-sel wr-ams-edit" data-ams-edit="${idx}" title="Edit the preset's L / R mix">edit</button>
        </div>
        <div class="wr-ams-grid" data-ams-grid="${idx}" hidden></div>
      </td></tr>`;
    }).join('');
    el.innerHTML = `<div class="wr-rack"><div class="wr-grid-card wr-rx-card">
      <table class="wr-rx-table" aria-label="Receivers: the flow each one listens to">
        <thead><tr><th></th><th>RECEIVERS</th><th>flow</th><th>address</th><th>status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div></div>`;
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset?.rxPick === undefined) return;
      const idx = +t.dataset.rxPick;
      const box = el.querySelector<HTMLElement>(`[data-rx-custom="${idx}"]`);
      // "Address : port…" / "Paste an SDP…" open the entry under the picker
      if (t.value === '__ip' || t.value === '__sdp') {
        if (box) {
          box.hidden = false;
          box.querySelector<HTMLElement>('[data-rx-ip-row]')!.hidden = t.value !== '__ip';
          box.querySelector<HTMLElement>('[data-rx-sdp]')!.hidden = t.value !== '__sdp';
          box.querySelector<HTMLElement>(t.value === '__ip' ? '[data-rx-ip]' : '[data-rx-sdp]')?.focus();
        }
        return;
      }
      if (box) box.hidden = true;
      this.setReceiver(idx, t.value);
    });
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rx-go]');
      if (!b) return;
      const idx = +b.dataset.rxGo!;
      const box = el.querySelector<HTMLElement>(`[data-rx-custom="${idx}"]`)!;
      const sdpBox = box.querySelector<HTMLTextAreaElement>('[data-rx-sdp]')!;
      let ref = '';
      if (!sdpBox.hidden) ref = sdpBox.value.trim();
      else {
        const ip = box.querySelector<HTMLInputElement>('[data-rx-ip]')!.value.trim();
        const ch = box.querySelector<HTMLSelectElement>('[data-rx-ch]')!.value;
        const enc = box.querySelector<HTMLSelectElement>('[data-rx-enc]')!.value;
        if (!/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(ip)) { box.querySelector<HTMLInputElement>('[data-rx-ip]')!.setCustomValidity('address:port, e.g. 239.1.2.3:5004'); box.querySelector<HTMLInputElement>('[data-rx-ip]')!.reportValidity(); return; }
        ref = `${ip}/${ch}ch/${enc}`;
      }
      if (!ref) return;
      box.hidden = true;
      this.rxKey = '';
      this.setReceiver(idx, ref);
    });
    el.addEventListener('input', (e) => (e.target as HTMLInputElement).setCustomValidity?.(''));
    // AMS-81: a pair, a preset or Lo/Ro; "edit" opens the selected preset's mix grid
    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-ams-sel], [data-ams-edit]');
      const row = b?.closest<HTMLElement>('[data-ams]');
      if (!b || !row || b.disabled) return;
      const idx = +row.dataset.ams!;
      if (b.dataset.amsEdit !== undefined) { this.amsEdit[idx] = !this.amsEdit[idx]; this.renderAms(); return; }
      const a = this.ams81[RECEIVERS[idx].slot];
      if (a) a.select = b.dataset.amsSel!;
      this.renderAms();
      this.postAms({ slot: RECEIVERS[idx].slot, select: b.dataset.amsSel });
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset?.amsCh === undefined) return;
      const idx = +t.closest<HTMLElement>('[data-ams-grid]')!.dataset.amsGrid!;
      const a = this.ams81[RECEIVERS[idx].slot];
      const preset = amsSel(a?.select ?? '');
      if (!a?.presets[preset]) return;
      const side = t.dataset.amsSide as 'L' | 'R';
      const ch = +t.dataset.amsCh;
      const db = t.value === '' ? null : +t.value;
      a.presets[preset][side][ch - 1] = db;
      this.postAms({ slot: RECEIVERS[idx].slot, preset, side, ch, db });
    });
    if (drawEye) {
      window.setInterval(() => {
        if (el.offsetParent === null) return;
        el.querySelectorAll<HTMLCanvasElement>('[data-rx-eye]').forEach((cv) => drawEye(cv, cv.dataset.rxEye!));
      }, 100);
    }
    this.rxKey = '';
    this.renderRx();
    return this;
  }

  setAudio(audio: WebRouterAudio | null): void {
    this.audio = audio;
  }

  destroy(): void {
    this.closeProbe();
    this.wireObserver?.disconnect();
    this.wireObserver = null;
    if (this.daemonTimer !== null) window.clearInterval(this.daemonTimer);
    this.daemonTimer = null;
    this.container.innerHTML = '';
    this.built = false;
  }

  /**
   * Can `row` reach output `col`? Without the TAP the router is only the tab and the sound
   * card to the meters and speakers: no generators, receivers, cue bus or transmitters, and
   * nothing passes through the router. With it, the transmitters take only their own source.
   */
  canRoute(row: number, col: number): boolean {
    if (!this.daemonOnline && (row >= IN_POD33 || col >= OUT_CUE)) return false;
    if (this.feedback(row, col)) return false;
    if (col === OUT_POD33 || col === OUT_POD33_LOW) return isPod33Row(row);
    if (col === OUT_BITS) return row === IN_BITBUDDY;
    if (col === OUT_NET_LOOP || col === OUT_MOIP_LOOP) return row === (col === OUT_NET_LOOP ? 7 : 8); // each loop out takes its own receiver
    return true;
  }

  /**
   * A source may go to any number of outputs, but never back into itself: a sound card
   * input that is a monitor / loopback of the outputs cannot feed HW 1 / HW 2, and a receiver
   * listening to the TAP's own stream cannot go out again on the Repeater (any other received
   * stream can).
   */
  private feedback(row: number, col: number): boolean {
    if (row === IN_SOUNDCARD && (col === OUT_SPEAKERS || col === OUT_CUE)) {
      const label = this.scInputs.find((d) => d.id === this.scDevice)?.label ?? '';
      if (/monitor of|loopback|ward-beck tap/i.test(label)) return true;
    }
    if (isRxRow(row) && (col === OUT_REPEATER || col === OUT_NET_LOOP || col === OUT_MOIP_LOOP)) {
      const ref = this.rxChoice[row] ?? '';
      const s = this.rxStreams.find((x) => x.id === ref);
      const own = new Set(Object.values(this.tapTx).map((t) => t.addr));
      if ((s && own.has(s.addr)) || /ward-beck|wbs-flow|master bus/i.test(s?.name ?? ref)) return true;
    }
    return false;
  }

  /** The TAP's AES67 transmitters by flow: the name it announces (null: an older TAP that takes no
   *  names) and the multicast address it sends to. */
  private tapTx: Record<string, { name: string | null; addr: string }> = {};

  /** What feeds router input `row`, by name: the shared tab's title, the tone and level, the stream. */
  private sourceName(row: number): string {
    const hz = (f: number) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
    if (row === IN_SOUNDCARD) {
      const l = this.scInputs.find((d) => d.id === this.scDevice)?.label;
      return l ? l.replace(/^monitor of /i, '') : INPUTS[row].name;
    }
    if (row === IN_TAB) return this.tabInfo?.title || INPUTS[row].name;
    if (isPod33Row(row)) {
      const o = this.pod33Outputs[row - IN_POD33];
      const f = !o.freq ? 'silence' : o.freqR && o.freqR !== o.freq ? `${hz(o.freq)}/${hz(o.freqR)}` : hz(o.freq);
      return `${INPUTS[row].name} ${f}${o.freq && o.levelDb > -100 ? ` ${o.levelDb} dBFS` : ''}`;
    }
    if (row === IN_BITBUDDY) {
      const b = this.bitBuddyConfig;
      const what = b.pattern === 'tone' ? hz(b.tone) : b.pattern === 'file' ? (b.fileName || 'file') : b.pattern;
      return `Bit Spitter ${what}`;
    }
    if (isRxRow(row)) {
      const ref = this.rxChoice[row] ?? '';
      return this.rxStreams.find((s) => s.id === ref)?.name || INPUTS[row].name;
    }
    return INPUTS[row].name;
  }

  /** Each transmitter's name, inherited from what is routed into it (else what it carries). */
  transmitterNames(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [c, flow] of Object.entries(MXL_FLOW)) {
      const col = +c;
      const rows = INPUTS.map((_, r) => r).filter((r) => this.matrix[r][col] && this.canRoute(r, col));
      const fallback = col === OUT_POD33_LOW ? `POD-33 ${this.pod33LowHz} Hz` : col === OUT_BITS ? this.sourceName(IN_BITBUDDY) : OUTPUTS[col].name;
      let name = rows.length ? rows.map((r) => this.sourceName(r)).join(' + ') : fallback;
      if (col === OUT_POD33_LOW && rows.length) name = `${INPUTS[rows[0]].name} ${this.pod33LowHz} Hz`;
      out[flow] = name.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 64);
    }
    return out;
  }

  /** Tell the TAP any transmitter name that changed (its SDP, SAP and Bonjour follow). */
  private syncTxNames(): void {
    if (!this.daemonOnline) return;
    for (const [flow, name] of Object.entries(this.transmitterNames())) {
      const tx = this.tapTx[flow];
      if (!tx || tx.name === null || tx.name === name) continue; // an older TAP takes no names
      tx.name = name;
      this.post('/api/aes67', { flow_id: flow, name });
    }
  }

  /** The TAP went away: stop every generator, drop the routes it carried, back to tab / sound card. */
  private goOffline(): void {
    this.daemonOnline = false;
    if (this.pod33Engaged) { this.pod33Engaged = false; this.audio?.stopPod33Generator(); }
    if (this.bitBuddyEngaged) { this.bitBuddyEngaged = false; this.audio?.stopBitBuddyGenerator(); }
    this.matrix.forEach((r, i) => r.forEach((on, c) => { if (on && !this.canRoute(i, c)) r[c] = false; }));
    if (this.activeInput >= IN_POD33) this.selectInput(IN_SOUNDCARD);
    this.syncMonitor();
    this.refresh();
  }

  /** Poll the daemon's Bit Buddy so every page shows (and controls) the one shared generator. */
  private watchDaemon(): void {
    if (this.daemonTimer !== null) return;
    const poll = () => {
      fetch(`${this.daemonUrl}/api/bitbuddy`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((st: { active?: boolean; config?: { pattern?: string }; test_tone?: { active?: boolean } }) => {
          const wasOnline = this.daemonOnline;
          this.daemonOnline = true;
          if (!wasOnline) { this.syncMonitor(); this.refresh(); } // the full router (and the speakers through HW 1) come back
          // The daemon took over: silence the browser copy so it is only heard once.
          if (!wasOnline) this.audio?.stopBitBuddyGenerator();
          const pat = st.config?.pattern as BitBuddyConfig['pattern'] | undefined;
          const patChanged = !!pat && pat !== this.bitBuddyConfig.pattern;
          if (patChanged) this.bitBuddyConfig.pattern = pat!;
          if (Date.now() - this.bbLocalAt < 2000) return;
          // The daemon's tone outlives a reload: show it as engaged so it can be switched off.
          const tone = st.test_tone?.active;
          if (tone !== undefined && tone !== this.pod33Engaged) this.applyPod33(tone);
          if (!!st.active !== this.bitBuddyEngaged) this.applyBitBuddy(!!st.active);
          else if (patChanged) this.refresh();
        })
        .catch(() => {
          if (!this.daemonOnline) return;
          this.goOffline();
        });
    };
    const pollRx = () => {
      // The TAP's AES67 transmitters: their names follow what is routed into them
      fetch(`${this.daemonUrl}/api/aes67`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const txs: any[] = Array.isArray(d?.transmitters) ? d.transmitters : [];
          this.tapTx = Object.fromEntries(txs.map((t) => [String(t.flow_id), { name: typeof t.name === 'string' ? t.name : null, addr: `${t.multicast_ip}:${t.port}` }]));
          this.syncTxNames();
        })
        .catch(() => {});
      fetch(`${this.daemonUrl}/api/aoip/multicast`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const sessions: any[] = d?.sap?.sessions ?? [];
          this.rxStreams = sessions
            .filter((x) => x.multicast_ip && !x.deleted && !x.own) // never offer this TAP's own transmitters (a loop)
            .map((x) => ({ id: String(x.session_name || x.id), name: String(x.session_name || x.id), addr: `${x.multicast_ip}:${x.port}` }))
            .sort((a, b) => a.name.localeCompare(b.name));
          this.renderRx();
        })
        .catch(() => {});
      fetch(`${this.daemonUrl}/api/receiver`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          for (const [row, rx] of Object.entries(RECEIVERS)) {
            const st = d?.[rx.slot];
            const pt = st?.point;
            this.rxStatus[+row] = { active: !!st?.active, status: pt?.status, error: pt?.error, hint: pt?.hint, source: pt?.source, ref: pt?.ref != null ? String(pt.ref) : undefined, channels: typeof pt?.channel_count === 'number' ? pt.channel_count : undefined };
            if (st?.active && pt?.ref && !this.rxChoice[+row]) this.rxChoice[+row] = String(pt.ref);
            // Always listening: a chosen stream the TAP is not receiving (restart, reload) is started
            if (!st?.active && this.rxChoice[+row] && Date.now() - (this.rxStartedAt[+row] ?? 0) > 10000) {
              this.rxStartedAt[+row] = Date.now();
              this.startReceiver(+row);
            }
          }
          this.renderRx();
          this.renderAms();
        })
        .catch(() => {});
      if (this.rxEl) {
        fetch(`${this.daemonUrl}/api/ams81`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject()))
          .then((d) => { this.ams81 = d ?? {}; this.renderAms(); })
          .catch(() => {});
      }
    };
    poll();
    pollRx();
    this.daemonTimer = window.setInterval(() => { poll(); if (this.container.offsetParent !== null || this.rxEl?.offsetParent) pollRx(); else if (++this.rxIdle % 7 === 0) pollRx(); }, 1500);
  }

  // ───────────────────────────── markup ─────────────────────────────

  private renderHtml(): string {
    return `
      <div class="wr-rack">
        <div class="wr-grid-card">
          <div class="wr-wire-wrap">
          <svg class="wr-wires" aria-hidden="true"></svg>
          <table class="wr-matrix-table wr-grid" aria-label="Crosspoint matrix: inputs down, outputs across">
            <thead><tr>
              <th class="wr-grid-corner" aria-label="Inputs down, outputs across"></th>
              ${OUTPUTS.map((o, i) => this.renderOutputCell(o, i)).join('')}
            </tr></thead>
            <tbody>${INPUTS.map((c, r) => this.renderInputRow(c, r)).join('')}</tbody>
          </table>
          </div>
        </div>

      </div>`;
  }

  /** Row header = the input strip: tag · name · level, VU pair, ENGAGE. The crosspoints follow. */
  private renderInputRow(c: RouterChannel, idx: number): string {
    const cells = OUTPUTS.map((o, col) => `
      <td class="wr-td-crosspoint${col >= OUT_CUE ? ' wr-tap-only' : ''}">
        <button type="button" class="wr-matrix-btn" data-row="${idx}" data-col="${col}" title="${c.name} → ${o.name}" aria-label="${c.name} to ${o.name}">
          <span class="wr-matrix-led"></span>
        </button>
      </td>`).join('');
    return `<tr class="wr-grid-row${idx >= IN_POD33 ? ' wr-tap-only' : ''}">
      <th class="wr-grid-in" scope="row">
        <div class="wr-strip wr-in-strip" id="wrInStrip${idx}" data-in-idx="${idx}" title="${c.name} — ${c.sub}\nAlways listening: its meter shows the source. Click to play it.">
          <div class="wr-strip-top">
            ${this.art ? '' : `<span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>`}
            <span class="wr-strip-name" id="wrInName${idx}">${c.name}</span>
          </div>
          ${idx === IN_TAB ? `<div class="wr-strip-info" id="wrTabInfo"></div>` : ''}
          ${idx === IN_SOUNDCARD ? `<select class="wr-rx-pick" data-sc-pick aria-label="${c.name} device"><option value="">Default input</option></select>` : ''}
          ${isRxRow(idx) ? `<div class="wr-strip-info wr-rx-info wr-rx-open" data-rx-info="${idx}" data-rx-open="1" role="link" title="Choose the stream in the Receivers tab"></div>` : ''}
          ${this.meterPair('wrIn', idx, `<span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>`)}
        </div>
      </th>${cells}</tr>`;
  }

  /** Column head: each output's tag, name, -20 dB dim and its VU meter, above its crosspoints. */
  private renderOutputCell(c: RouterChannel, idx: number): string {
    const tag = c.pill === 'mxl'
      ? `<button type="button" class="wr-strip-tag wr-pill-mxl wr-btn-open-flow" data-open-flow="${idx}" title="Open the ${c.name} MXL transmitter">${c.tag}</button>`
      : `<span class="wr-strip-tag wr-pill-${c.pill}">${c.tag}</span>`;
    return `
      <th class="wr-grid-out-head wr-grid-out${idx >= OUT_CUE ? ' wr-tap-only' : ''}" scope="col">
        <div class="wr-strip wr-out-strip" id="wrOutStrip${idx}" title="${c.name} — ${c.sub}">
          <div class="wr-strip-top">
            ${this.art ? '' : tag}
            ${idx === OUT_POD33_LOW
              ? `<button type="button" class="wr-strip-name wr-btn-hz" data-low-hz="1" id="wrLowHz" title="Switch POD-33 400 Hz / 100 Hz">${this.pod33LowHz} Hz</button>`
              : c.pill === 'mxl'
                ? `<button type="button" class="wr-strip-name wr-btn-open-flow" data-open-flow="${idx}" title="Open the ${c.name} MXL transmitter">${SHORT_OUT[idx]}</button>`
                : `<span class="wr-strip-name">${SHORT_OUT[idx]}</span>`}
          </div>
          ${this.meterPair('wrOut', idx, tag)}
          ${idx === OUT_SPEAKERS ? `<input type="range" class="wr-level" data-out-level="${idx}" min="0" max="1" step="0.01" value="${this.speakerLevel}" title="Speaker level" aria-label="Speaker level">` : ''}
        </div>
      </th>`;
  }

  /** Put a copy of the host's meter into every strip. */
  private fillArt(): void {
    if (!this.art) return;
    const t = artTemplate(this.art);
    this.artSrc = t?.src ?? null;
    this.container.querySelectorAll('.wr-art-slot').forEach((slot) => slot.replaceChildren(...(t ? [t.tpl.cloneNode(true)] : [])));
  }

  /** The strip's meter; with the console's meter art the channel ID sits on its black bezel. */
  private meterPair(prefix: string, idx: number, tag = ''): string {
    return this.art ? renderArtMeterPair(prefix, idx, this.art, tag) : renderMeterPair(prefix, idx);
  }

  // ───────────────────────────── events ─────────────────────────────

  private attachEvents(): void {
    const root = this.container;
    // One delegated listener: every control carries a data-* attribute.
    root.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset?.outLevel !== undefined) this.setSpeakerLevel(parseFloat(t.value));
    });
    root.addEventListener('change', (e) => {
      const t = e.target as HTMLSelectElement;
      if (t.dataset?.rxPick !== undefined) this.setReceiver(+t.dataset.rxPick, t.value);
      if (t.dataset?.scPick !== undefined) this.setSoundCard(t.value);
    });
    root.addEventListener('click', (e) => {
      const el = e.target as HTMLElement;
      if (el.closest('[data-rx-open]')) { this.onOpenReceivers?.(); return; }
      // Clicking an input strip (not its picker) plays that input
      const strip = el.closest<HTMLElement>('.wr-in-strip[data-in-idx]');
      if (strip && !el.closest('select') && root.contains(strip)) {
        // Ctrl-click (⌘) CH 2: share a new tab (a plain click keeps the one shared)
        if (+strip.dataset.inIdx! === IN_TAB && (e.ctrlKey || e.metaKey)) this.audio?.connectSystemAudio('browser', true);
        this.selectInput(+strip.dataset.inIdx!);
        return;
      }
      const t = el.closest('button');
      if (!t || !root.contains(t)) return;
      const d = t.dataset;
      if (d.row !== undefined) return this.toggleCrosspoint(+d.row, +(d.col ?? 0));
      if (d.inIdx !== undefined) return this.selectInput(+d.inIdx);
      if (d.outDim !== undefined) return this.toggleOut('dim', +d.outDim);
      if (d.lowHz !== undefined) {
        this.pod33LowHz = this.pod33LowHz === 400 ? 100 : 400;
        this.post('/api/mxl/low_tone', { hz: this.pod33LowHz }); // the TAP's MXL67-3 flow follows
        const el = root.querySelector('#wrLowHz');
        if (el) el.textContent = `${this.pod33LowHz} Hz`;
        this.syncTxNames();
        return;
      }
      if (d.openFlow !== undefined) {
        const col = +d.openFlow;
        const flow = MXL_FLOW[col];
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
    // Speakers: through the TAP's HW 1 bus when it runs (the hardware tab picks the card)
    this.audio.setMonitorSink?.(this.daemonOnline);
    const a = this.activeInput;
    const on =
      this.matrix[a][OUT_SPEAKERS] ||
      (this.pod33Engaged && INPUTS.some((_, r) => isPod33Row(r) && this.matrix[r][OUT_SPEAKERS])) ||
      (this.bitBuddyEngaged && this.matrix[IN_BITBUDDY][OUT_SPEAKERS]);
    this.audio.setMonitor(on && !this.outMutes[OUT_SPEAKERS], this.monitorGain());
    // Cue / HP is its own output (the TAP's HW 2), not a second way onto the speakers
    const cue = !this.externalSource && this.matrix[a][OUT_CUE] && !this.outMutes[OUT_CUE];
    if (cue !== this.cueOn) { this.cueOn = cue; this.audio.setCue?.(cue); }
  }

  /**
   * After any route or generator change: check what the TAP is actually doing against what
   * the router asked for, and re-send whatever did not take (twice: right away and once the
   * TAP's workers have had time to start). The router's word wins here.
   */
  private kick(): void {
    for (const t of this.kickTimers) clearTimeout(t);
    this.kickTimers = [400, 1600].map((ms) => window.setTimeout(() => void this.reconcile(), ms));
  }

  private async reconcile(): Promise<void> {
    if (this.daemonOnline) {
      try {
        const st = await fetch(`${this.daemonUrl}/api/bitbuddy`, { cache: 'no-store' }).then((r) => r.json());
        const tone = st?.test_tone ?? {}, c = this.pod33Config;
        const has = (k: string) => k in tone;
        const toneWrong = !!tone.active !== this.pod33Engaged || (this.pod33Engaged && (
          (has('freq') && tone.freq !== c.freq)
          || (has('freq_r') && (tone.freq_r ?? null) !== (c.freqR ?? null))
          || (has('level_db') && tone.level_db !== c.levelDb)
          || (has('channel') && tone.channel !== c.channelMode)
          || (has('beep_hz') && tone.beep_hz !== (c.beep ?? 0))
          || (has('beep_left') && tone.beep_left !== !!c.beepLeft)));
        if (toneWrong) {
          console.info('[router] POD-33 tone out of step with the TAP: re-sent');
          this.post('/api/test_tone', { ...this.toneBody(), restart: this.pod33Engaged });
        }
        if (!!st?.active !== this.bitBuddyEngaged) {
          console.info('[router] Bit Spitter out of step with the TAP: re-sent');
          this.post('/api/bitbuddy', this.bitBuddyEngaged ? { ...this.bitBuddyPayload(), restart: true } : { active: false });
        }
        this.bbLocalAt = Date.now(); // the next poll does not undo this
      } catch { /* the poll notices the TAP going away */ }
    }
    this.syncMonitor();
    this.hintFlow();
    this.refresh();
  }

  private hintFlow(): void {
    const flow = this.bitBuddyEngaged && (this.activeInput === IN_BITBUDDY || !this.pod33Engaged)
      ? FLOW_BITS
      : this.pod33Engaged ? FLOW_TONE : FLOW_MASTER;
    this.onFlowHint?.(flow);
  }

  toggleCrosspoint(row: number, col: number): void {
    if (!this.canRoute(row, col)) return;
    if (col < METERS) {
      // A meter input takes one source: the new crosspoint replaces the old, and the
      // meter's INPUT button follows (the host assigns and plays it). Clicking the lit
      // crosspoint empties that input (the host is told row -1).
      if (this.matrix[row][col]) {
        this.matrix[row][col] = false;
        this.refresh();
        this.onMeterInput?.(col + 1, -1);
        this.kick();
        return;
      }
      this.matrix.forEach((r, i) => { r[col] = i === row; });
      this.refresh();
      this.onMeterInput?.(col + 1, row);
      this.kick();
      return;
    }
    // Exclusive 1:1 routing: an output takes one input. Clicking the lit crosspoint
    // clears the output; any other crosspoint replaces its source.
    this.route(row, col, !this.matrix[row][col]);
    // Cue / HP goes to its own bus (HW 2), not the room: making its crosspoint is the unmute
    if (col === OUT_CUE && this.matrix[row][col]) this.outMutes[OUT_CUE] = false;
    if (col === OUT_SPEAKERS || col === OUT_CUE) this.syncMonitor(); // the crosspoint is the mute
    this.refresh();
    this.kick();
  }

  /** Exclusive 1:1: putting `row` on output `col` takes every other input off it. */
  private route(row: number, col: number, on: boolean): void {
    if (on) this.matrix.forEach((r, i) => { r[col] = i === row; });
    else this.matrix[row][col] = false;
  }

  /** Presets may list several sources per output: keep one (the selected input, else the first). */
  private exclusive(prefer?: number): void {
    const cols = this.matrix[0]?.length ?? 0;
    for (let c = 0; c < cols; c++) {
      const rows = this.matrix.map((r, i) => (r[c] ? i : -1)).filter((i) => i >= 0);
      if (rows.length > 1) this.route(prefer !== undefined && rows.includes(prefer) ? prefer : rows[0], c, true);
    }
  }

  selectInput(idx: number): void {
    if (!this.daemonOnline && idx >= IN_POD33) return; // generators and receivers need the TAP
    this.activeInput = idx;
    const audio = this.audio;
    this.resumeAudio();
    // One input at a time: a generator left running would keep playing under the new input.
    if (!isPod33Row(idx) && this.pod33Engaged) this.setPod33(false, false);
    if (idx !== IN_BITBUDDY && this.bitBuddyEngaged) this.setBitBuddy(false, false);
    if (isPod33Row(idx)) { this.usePod33Output(idx - IN_POD33); this.setPod33(true, false); }
    else if (idx === IN_BITBUDDY) this.setBitBuddy(true, false);
    else if (isRxRow(idx)) this.startReceiver(idx);
    else if (audio) {
      if (idx === IN_SOUNDCARD) audio.connectSoundCard(this.scDevice || null);
      else if (idx === 1) audio.connectSystemAudio('browser');
    }
    this.syncMonitor();
    this.hintFlow();
    this.refresh();
    this.kick();
  }

  private scWatch = false;

  /** CH 1's list: every sound card input the browser offers (names appear once audio is allowed). */
  private async loadSoundCards(): Promise<void> {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.scInputs = devs
        .filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
    } catch { this.scInputs = []; }
    const sel = this.container.querySelector<HTMLSelectElement>('[data-sc-pick]');
    if (!sel || document.activeElement === sel) return;
    const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const known = this.scInputs.some((d) => d.id === this.scDevice);
    // A sound card's outputs show up as "Monitor of …" inputs: listed as outputs to tap
    const isOut = (l: string) => /^monitor of /i.test(l);
    const ins = this.scInputs.filter((d) => !isOut(d.label));
    const outs = this.scInputs.filter((d) => isOut(d.label) && !/internal/i.test(d.label)); // not the TAP's internal buses
    const opt = (d: { id: string; label: string }, label = d.label) => `<option value="${esc(d.id)}">${esc(label)}</option>`;
    sel.innerHTML = '<option value="">Default input</option>'
      + (this.scDevice && !known ? `<option value="${esc(this.scDevice)}">(not connected)</option>` : '')
      + (ins.length ? `<optgroup label="Inputs">${ins.map((d) => opt(d)).join('')}</optgroup>` : '')
      + (outs.length ? `<optgroup label="Outputs (tap what a card plays)">${outs.map((d) => opt(d, '▶ ' + d.label.replace(/^monitor of /i, ''))).join('')}</optgroup>` : '');
    sel.value = this.scDevice;
  }

  /** Choose CH 1's sound card input; it plays straight away. */
  setSoundCard(deviceId: string): void {
    this.scDevice = deviceId;
    this.scDenied = false;
    try { localStorage.setItem('wr.scDevice', deviceId); } catch { /* ignore */ }
    // A loopback / monitor input loses its routes to the outputs (no feedback)
    this.matrix.forEach((r, i) => r.forEach((on, c) => { if (on && !this.canRoute(i, c)) r[c] = false; }));
    this.selectInput(IN_SOUNDCARD);
    void this.loadSoundCards(); // names appear once the browser has been allowed the input
  }

  /** Pick the stream a receiver row listens to; a live row switches over straight away. */
  setReceiver(idx: number, streamId: string): void {
    if (!isRxRow(idx)) return;
    if (streamId) this.rxChoice[idx] = streamId; else delete this.rxChoice[idx];
    try { localStorage.setItem('wr.rxChoice', JSON.stringify(this.rxChoice)); } catch { /* ignore */ }
    // Now listening to the TAP's own stream: its Repeater route would loop
    if (this.matrix[idx][OUT_REPEATER] && !this.canRoute(idx, OUT_REPEATER)) this.matrix[idx][OUT_REPEATER] = false;
    this.refresh();
    if (!streamId) {
      this.post('/api/receiver', { slot: RECEIVERS[idx].slot, stop: true });
      this.rxStatus[idx] = { active: false };
      this.renderRx();
      return;
    }
    this.startReceiver(idx); // listening from now on, played or not
  }

  /** Have the TAP receive the row's stream, then play the receiver's MXL flow. */
  private startReceiver(idx: number): void {
    const rx = RECEIVERS[idx];
    const ref = this.rxChoice[idx];
    if (!ref) { this.renderRx(); return; }
    // Already receiving that flow (or just asked to): play it, don't restart it
    const cur = this.rxStatus[idx];
    if (cur?.active && cur.ref === ref) {
      if (this.activeInput === idx) { this.onPlayFlow?.(rx.flow); this.onFlowHint?.(rx.flow); }
      return;
    }
    const name = this.rxStreams.find((s) => s.id === ref)?.name
      ?? (ref.startsWith('v=') ? /^s=(.*)$/m.exec(ref)?.[1]?.trim() || 'custom SDP' : ref.split('/')[0]);
    this.rxStatus[idx] = { active: true, status: 'starting', ref };
    this.renderRx();
    fetch(`${this.daemonUrl}/api/receiver`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: rx.slot, kind: 'aoip', ref, label: name }),
    }).catch(() => {}).finally(() => {
      if (this.activeInput === idx) { this.onPlayFlow?.(rx.flow); this.onFlowHint?.(rx.flow); }
    });
  }

  /** Change a receiver's AMS-81 (the TAP saves it); the reply is every fold-down. */
  private postAms(body: Record<string, unknown>): void {
    fetch(`${this.daemonUrl}/api/ams81`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { if (d && !d.error) { this.ams81 = d; this.renderAms(); } })
      .catch(() => {});
  }

  /** AMS-81 rows: the lit selection, pairs past the stream's channels dark, the preset's mix grid. */
  private renderAms(): void {
    for (const k of Object.keys(RECEIVERS)) {
      const idx = +k;
      const row = this.rxEl?.querySelector<HTMLElement>(`[data-ams="${idx}"]`);
      const grid = this.rxEl?.querySelector<HTMLElement>(`[data-ams-grid="${idx}"]`);
      if (!row || !grid) continue;
      const a = this.ams81[RECEIVERS[idx].slot];
      const sel = amsSel(a?.select ?? '');
      const st = this.rxStatus[idx];
      const chs = st?.active && st.channels ? st.channels : 8;
      row.querySelectorAll<HTMLButtonElement>('[data-ams-sel]').forEach((b) => {
        const v = b.dataset.amsSel!;
        const pair = AMS_PAIRS.indexOf(v);
        b.disabled = !a || (pair >= 0 && 2 * pair + 1 > chs);
        b.classList.toggle('active', v === sel);
      });
      const mix = a?.presets[sel];
      const edit = row.querySelector<HTMLButtonElement>('[data-ams-edit]')!;
      edit.disabled = !mix;
      const open = !!mix && !!this.amsEdit[idx];
      edit.classList.toggle('active', open);
      grid.hidden = !open;
      if (!open || grid.contains(document.activeElement)) continue;
      const key = JSON.stringify([sel, mix, chs]);
      if (grid.dataset.key === key) continue;
      grid.dataset.key = key;
      const opts = (db: number | null) => `<option value=""${db == null ? ' selected' : ''}>Off</option>`
        + Array.from({ length: 31 }, (_, i) => i - 15)
          .map((g) => `<option value="${g}"${db != null && Math.round(db) === g ? ' selected' : ''}>${g > 0 ? `+${g}` : g < 0 ? `\u2212${-g}` : '0'}</option>`).join('');
      const cells = (side: 'L' | 'R') => mix![side].slice(0, 8).map((db, c) =>
        `<td><select class="wr-ams-db" data-ams-side="${side}" data-ams-ch="${c + 1}" aria-label="${sel} ${side} ch ${c + 1}"${c >= chs ? ' disabled' : ''}>${opts(db)}</select></td>`).join('');
      grid.innerHTML = `<table class="wr-ams-mix" aria-label="Preset ${sel} mix (dB)">
        <thead><tr><th>${sel}</th>${Array.from({ length: 8 }, (_, c) => `<th>${c + 1}</th>`).join('')}</tr></thead>
        <tbody><tr><th>L</th>${cells('L')}</tr><tr><th>R</th>${cells('R')}</tr></tbody></table>`;
    }
  }

  /** Receiver rows: the stream list and what the TAP says about each one. */
  private renderRx(): void {
    if (!this.built) return;
    const key = JSON.stringify([this.rxStreams, this.rxChoice]);
    const fresh = key !== this.rxKey;
    this.rxKey = key;
    for (const k of Object.keys(RECEIVERS)) {
      const idx = +k;
      const sel = this.rxEl?.querySelector<HTMLSelectElement>(`[data-rx-pick="${idx}"]`);
      const cur = this.rxChoice[idx] ?? '';
      if (sel && fresh && document.activeElement !== sel) {
        const known = this.rxStreams.some((s) => s.id === cur);
        const esc = (v: string) => v.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
        const custom = (r: string) => (r.startsWith('v=') ? `Custom SDP (${/^s=(.*)$/m.exec(r)?.[1]?.trim() || 'pasted'})` : /^\d+\.\d+\.\d+\.\d+:\d+/.test(r) ? r.replace(/\//g, ' · ') : `${r} (not heard)`);
        sel.innerHTML = `<option value="">${this.rxStreams.length ? 'Choose a stream…' : 'No streams announced'}</option>`
          + (cur && !known ? `<option value="${esc(cur)}">${esc(custom(cur))}</option>` : '')
          + this.rxStreams.map((s) => `<option value="${esc(s.id)}" title="${esc(s.addr)}">${esc(s.name)}</option>`).join('')
          + `<option value="__ip">Address : port…</option><option value="__sdp">Paste an SDP…</option>`;
        sel.value = cur;
      }
      const st = this.rxStatus[idx];
      const stream = this.rxStreams.find((s) => s.id === cur);
      const state = !st?.active ? '' : st.error ? st.error : st.status === 'waiting' && st.hint ? st.hint : st.source || st.status || '';
      const addr = this.rxEl?.querySelector(`[data-rx-addr="${idx}"]`);
      if (addr) addr.textContent = stream?.addr ?? '';
      // Receivers tab: the status; router row: the flow it listens to (picked in the Receivers tab)
      for (const root of [this.container, this.rxEl]) {
        const info = root?.querySelector(`[data-rx-info="${idx}"]`);
        if (!info) continue;
        const inTab = root === this.rxEl;
        info.textContent = inTab ? state : st?.error ? st.error : (stream?.name ?? cur) || 'no flow · receivers tab';
        info.classList.toggle('wr-rx-error', !!st?.error);
      }
    }
  }

  /** Force a source onto Monitor 1 (speakers) and unmute it. */
  routeToSpeakers(idx: number = this.activeInput): void {
    if (idx !== this.activeInput) this.selectInput(idx);
    this.route(idx, OUT_SPEAKERS, true);
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
    this.exclusive(p.select);
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
    this.bbLocalAt = Date.now();
    this.applyPod33(on, false);
    this.post('/api/test_tone', { ...this.toneBody(), restart: on });
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
    this.kick();
  }

  /** Local POD-33 state (route + browser generator), without telling the daemon. */
  private applyPod33(on: boolean, sync = true): void {
    this.pod33Engaged = on;
    this.route(IN_POD33, OUT_SPEAKERS, on);
    if (on) this.audio?.startPod33Generator(this.pod33Config);
    else this.audio?.stopPod33Generator();
    this.restartSpitterIfExt();
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  setBitBuddy(on: boolean, sync = true): void {
    this.bbLocalAt = Date.now();
    this.post('/api/bitbuddy', on ? this.bitBuddyPayload() : { active: false });
    this.applyBitBuddy(on, sync);
    this.kick();
  }

  /** Local state for the shared Bit Buddy; sound comes from the browser only when the daemon is away. */
  private applyBitBuddy(on: boolean, sync = true): void {
    this.bitBuddyEngaged = on;
    this.route(IN_BITBUDDY, OUT_SPEAKERS, on);
    if (on && !this.daemonOnline) this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
    else this.audio?.stopBitBuddyGenerator();
    // With the TAP the spitter plays there: the meters read its flow (else they hear nothing)
    if (on && this.daemonOnline && this.activeInput === IN_BITBUDDY) this.onPlayFlow?.(FLOW_BITS);
    if (sync) { this.syncMonitor(); this.hintFlow(); this.refresh(); }
  }

  private bitBuddyPayload() {
    const b = this.bitBuddyConfig;
    return {
      active: true, pattern: b.pattern, pro_mode: b.proMode, audio_data: b.audioData === 'audio', sample_rate: b.sampleRate,
      level_db: b.level, tone_hz: b.tone, ext: b.ext, ch_b: b.bOff ? 'off' : b.invert ? (b.cycle ? 'cycle_invert' : 'invert') : b.cycle ? 'cycle' : 'on',
      validity: b.invalid, fault: b.fault ?? 'clean', ext_locked: this.extRefLocked,
    };
  }

  /**
   * The Bit Spitter's looped file (WAV / MP3, decoded by the page): sent to the TAP as
   * 16-bit stereo so it plays there too, then selected as the source.
   */
  async setBitBuddyFile(name: string, l: Float32Array, r: Float32Array, rate: number): Promise<boolean> {
    let ok = true;
    if (this.daemonOnline) {
      const pcm = new Int16Array(l.length * 2);
      for (let i = 0; i < l.length; i++) {
        pcm[2 * i] = Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767)));
        pcm[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767)));
      }
      const bytes = new Uint8Array(pcm.buffer);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      ok = await fetch(`${this.daemonUrl}/api/bitbuddy/file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, rate, pcm_b64: btoa(bin) }),
      }).then((res) => res.ok, () => false);
    }
    this.setBitBuddyConfig({ pattern: 'file', fileName: name });
    return ok;
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
    if (!this.bitBuddyEngaged || !this.bitBuddyConfig.ext) return;
    // EXT follows the POD-33 reference: the TAP or the browser re-locks (or mutes)
    if (this.daemonOnline) this.post('/api/bitbuddy', { ...this.bitBuddyPayload(), restart: true });
    else this.audio?.startBitBuddyGenerator(this.spitterAudioConfig());
  }

  /** Play POD-33 output n (0-3): its own frequency, level and channel, the unit's reference. */
  private usePod33Output(n: number): void {
    this.pod33Out = Math.max(0, Math.min(POD33_OUTS - 1, n));
    Object.assign(this.pod33Config, this.pod33Outputs[this.pod33Out]);
  }

  /** The output being played, as the TAP's /api/test_tone takes it. */
  private toneBody() {
    const c = this.pod33Config;
    return { freq: c.freq, freq_r: c.freqR ?? null, level_db: c.levelDb, channel: c.channelMode, beep_hz: c.beep ?? 0, beep_left: !!c.beepLeft };
  }

  /** Update one POD-33 output (0-3); the one playing restarts with it. */
  setPod33Output(n: number, patch: Partial<Pick<Pod33Config, 'freq' | 'freqR' | 'levelDb' | 'channelMode' | 'beep' | 'beepLeft'>>): void {
    const out = this.pod33Outputs[n];
    if (!out) return;
    Object.assign(out, patch);
    if (n === this.pod33Out) {
      this.setPod33Config(patch);
      if (this.pod33Engaged) this.post('/api/test_tone', { ...this.toneBody(), restart: true });
    } else this.refresh();
  }

  /** Update POD-33 settings (restarts the generator if it is running). Frequency, level and
   *  channel apply to the output being played; the reference lock to the whole unit. */
  setPod33Config(patch: Partial<Pod33Config>): void {
    const { refClock: _ref, ...perOut } = patch;
    Object.assign(this.pod33Outputs[this.pod33Out], perOut);
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
    return this.audio?.sourceType === 'mxl' && !isRxRow(this.activeInput);
  }

  private isInputLive(i: number): boolean {
    return (i === this.activeInput && !this.externalSource) || (isPod33Row(i) && this.pod33Engaged) || (i === IN_BITBUDDY && this.bitBuddyEngaged);
  }

  /** Sync every button/LED/class to current state. Cheap; called after each change. */
  refresh(): void {
    const root = this.container;
    // Only a possible route is a button; without the TAP only the tab and sound card remain
    root.classList.toggle('wr-tap-off', !this.daemonOnline);
    root.querySelectorAll<HTMLButtonElement>('.wr-matrix-btn[data-row]').forEach((b) => {
      const ok = this.canRoute(+b.dataset.row!, +b.dataset.col!);
      b.classList.toggle('wr-na', !ok);
      b.disabled = !ok;
      b.classList.toggle('connected', ok && this.matrix[+b.dataset.row!][+b.dataset.col!]);
    });
    INPUTS.forEach((_, i) => {
      const live = this.isInputLive(i);
      root.querySelector(`#wrInStrip${i}`)?.classList.toggle('selected', live);
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

    this.queueWires();
    this.syncTxNames();
    this.listeners.forEach((cb) => cb(this));
  }

  private queueWires(): void {
    if (this.wireFrame) return;
    this.wireFrame = requestAnimationFrame(() => { this.wireFrame = 0; this.drawWires(); });
  }

  /**
   * The signal flow, drawn: each made crosspoint gets a wire from its input strip, left to
   * right along the row to the crosspoint, then up the column to the output, in the input's
   * channel colour. Wires pass behind the other crosspoints (broken around their buttons).
   */
  private drawWires(): void {
    const svg = this.container.querySelector<SVGSVGElement>('.wr-wires');
    const wrap = svg?.parentElement;
    if (!svg || !wrap) return;
    const box = wrap.getBoundingClientRect();
    if (!box.width) return; // hidden: drawn again when shown
    svg.setAttribute('width', String(wrap.scrollWidth));
    svg.setAttribute('height', String(wrap.scrollHeight));
    const rel = (r: DOMRect) => ({ l: r.left - box.left, r: r.right - box.left, t: r.top - box.top, b: r.bottom - box.top });
    const btns = new Map<string, ReturnType<typeof rel>>();
    this.container.querySelectorAll<HTMLElement>('.wr-matrix-btn[data-row]').forEach((b) => btns.set(`${b.dataset.row},${b.dataset.col}`, rel(b.getBoundingClientRect())));
    const GAP = 3;
    // A straight run from a to b on one axis, with gaps where buttons sit on it.
    const run = (fixed: number, a: number, b: number, holes: [number, number][], horiz: boolean): string => {
      const cuts = holes.filter(([h0, h1]) => h1 > a && h0 < b).sort((x, y) => x[0] - y[0]);
      let d = '', at = a;
      for (const [h0, h1] of cuts) {
        if (h0 - GAP > at) d += horiz ? `M${at},${fixed}H${h0 - GAP}` : `M${fixed},${at}V${h0 - GAP}`;
        at = Math.max(at, h1 + GAP);
      }
      if (b > at) d += horiz ? `M${at},${fixed}H${b}` : `M${fixed},${at}V${b}`;
      return d;
    };
    const paths: string[] = [];
    INPUTS.forEach((_, r) => {
      const strip = this.container.querySelector(`#wrInStrip${r}`);
      const tag = strip?.querySelector('.wr-strip-tag');
      if (!strip || !tag) return;
      const colour = getComputedStyle(tag).backgroundColor;
      const live = this.isInputLive(r);
      const s0 = rel(strip.getBoundingClientRect());
      const cols = OUTPUTS.map((_, c) => c).filter((c) => this.matrix[r][c]);
      if (!cols.length) return;
      const rowBtns = OUTPUTS.map((_, c) => btns.get(`${r},${c}`)!).filter(Boolean);
      const y = (rowBtns[0].t + rowBtns[0].b) / 2;
      const far = btns.get(`${r},${Math.max(...cols)}`)!;
      // Along the row: from the strip to the last crosspoint it makes
      let d = run(y, s0.r, far.l - GAP, rowBtns.filter((b) => b !== far).map((b) => [b.l, b.r]), true);
      for (const c of cols) {
        const b = btns.get(`${r},${c}`)!;
        const x = (b.l + b.r) / 2;
        const head = this.container.querySelector(`#wrOutStrip${c}`);
        const top = head ? rel(head.getBoundingClientRect()).b : 0;
        // Up the column: from the crosspoint to its output
        const colBtns = INPUTS.map((_, i) => btns.get(`${i},${c}`)!).filter((v) => v && v !== b);
        d += run(x, top, b.t - GAP, colBtns.map((v) => [v.t, v.b]), false);
      }
      paths.push(`<path d="${d}" stroke="${colour}" class="wr-wire${live ? ' live' : ''}"/>`);
    });
    svg.innerHTML = paths.join('');
  }

  // ───────────────────────────── metering ─────────────────────────────

  /** A POD-33 output's level (VU dB L, R) from its own settings (default: the one playing). */
  private pod33Db(n = this.pod33Out): [number, number] {
    const { levelDb, channelMode: m, freq } = this.pod33Outputs[n] ?? this.pod33Config;
    const cal = freq === 0 || levelDb <= -100 ? -60 : levelDb + 18; // dBFS → VU (0 VU = -18 dBFS)
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
    const a = this.art;
    const ang = (db: number) => (a ? a.angle(db) : vuDbToAngle(db)).toFixed(1);
    const [xl, xr, y] = a ? [a.pivot[0], a.pivot[0], a.pivot[1]] : [PIVOT_L, PIVOT_R, PIVOT_Y];
    l?.setAttribute('transform', `rotate(${ang(dbL)} ${xl} ${y})`);
    r?.setAttribute('transform', `rotate(${ang(dbR)} ${xr} ${y})`);
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

  /** TAP flows behind the inputs: POD-33 AES1-4 (ref tone), Bit Buddy, the two receivers. */
  private static readonly SRC_FLOWS: Record<string, number[]> = {
        'wbs-flow-bit-spitter': [IN_BITBUDDY],
    'wbs-network-ams81': [7],
    'wbs-moip-ams81': [8],
  };

  /** Keep every source's level fresh: TAP flow meters (5 a second) and the sound card probe. */
  private listen(): void {
    const now = performance.now();
    if (!this.srcBusy && now - this.srcAt > 200) {
      this.srcAt = now;
      this.srcBusy = true;
      const drop = () => { for (const k of Object.keys(this.srcDb)) if (+k !== IN_SOUNDCARD && +k !== IN_TAB) delete this.srcDb[+k]; };
      fetch(`${this.daemonUrl}/api/mxl/rings?bins=60`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          drop();
          for (const f of d?.flows ?? []) {
            const rows = WebRouter.SRC_FLOWS[f.flow_id];
            if (!rows) continue;
            const ch = f.channels ?? [];
            // RMS dBFS → VU (0 VU = -18 dBFS, EBU alignment)
            const vu = (c: any) => (typeof c?.rms_db === 'number' && c.rms_db > -100 ? c.rms_db + 18 : -60);
            const db: [number, number] = [vu(ch[0]), vu(ch[1] ?? ch[0])];
            rows.forEach((r) => { this.srcDb[r] = db; });
          }
        })
        .catch(drop)
        .finally(() => { this.srcBusy = false; });
    }
    this.probeSoundCard();
    this.probeTab();
  }

  /** CH 2 keeps listening to the shared tab while another input plays (the share stays open). */
  private tabProbe: { ctx: AudioContext; an: AnalyserNode[]; stream: MediaStream } | null = null;
  private probeTab(): void {
    const stream = this.audio?.tabStream?.() ?? null;
    if (this.tabProbe && this.tabProbe.stream !== stream) {
      void this.tabProbe.ctx.close();
      this.tabProbe = null;
      delete this.srcDb[IN_TAB];
    }
    if (!stream) return;
    if (!this.tabProbe) {
      const ctx = new AudioContext();
      const split = ctx.createChannelSplitter(2);
      ctx.createMediaStreamSource(stream).connect(split);
      const an = [0, 1].map((c) => { const a = ctx.createAnalyser(); a.fftSize = 2048; split.connect(a, c); return a; });
      this.tabProbe = { ctx, an, stream };
    }
    const rms = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(this.scBuf);
      let sum = 0;
      for (let i = 0; i < this.scBuf.length; i++) sum += this.scBuf[i] * this.scBuf[i];
      const r = Math.sqrt(sum / this.scBuf.length);
      return r > 1e-5 ? 20 * Math.log10(r) + 18 : -60;
    };
    const prev = this.srcDb[IN_TAB] ?? [-60, -60];
    const k = 0.12;
    const [l, r] = this.tabProbe.an;
    this.srcDb[IN_TAB] = [prev[0] + (rms(l) - prev[0]) * k, prev[1] + (rms(r) - prev[1]) * k];
  }

  /** CH 1 listens to its sound card all the time (its own small analyser, not the meter's input). */
  private probeSoundCard(): void {
    const id = this.scDevice || 'default';
    if (this.scProbe && this.scProbe.id !== id) this.closeProbe();
    if (!this.scProbe) {
      if (this.scOpening || this.scDenied || !navigator.mediaDevices?.getUserMedia) return;
      this.scOpening = true;
      navigator.mediaDevices.getUserMedia({ audio: { deviceId: this.scDevice ? { exact: this.scDevice } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 } })
        .then((stream) => {
          const ctx = new AudioContext();
          const src = ctx.createMediaStreamSource(stream);
          const split = ctx.createChannelSplitter(2);
          src.connect(split);
          const an = [0, 1].map((c) => { const a = ctx.createAnalyser(); a.fftSize = 2048; split.connect(a, c); return a; });
          this.scProbe = { ctx, an, stream, id };
          void this.loadSoundCards(); // names are readable now
        })
        .catch(() => { this.scDenied = true; })
        .finally(() => { this.scOpening = false; });
      return;
    }
    const rms = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(this.scBuf);
      let sum = 0;
      for (let i = 0; i < this.scBuf.length; i++) sum += this.scBuf[i] * this.scBuf[i];
      const r = Math.sqrt(sum / this.scBuf.length);
      return r > 1e-5 ? 20 * Math.log10(r) + 18 : -60; // dBFS → VU, 0 VU = -18 dBFS
    };
    const [l, r] = this.scProbe.an;
    const prev = this.srcDb[IN_SOUNDCARD] ?? [-60, -60];
    const k = 0.12; // ~300 ms VU ballistics at 60 fps
    this.srcDb[IN_SOUNDCARD] = [prev[0] + (rms(l) - prev[0]) * k, prev[1] + (rms(r) - prev[1]) * k];
  }

  private closeProbe(): void {
    this.scProbe?.stream.getTracks().forEach((t) => t.stop());
    void this.scProbe?.ctx.close();
    this.scProbe = null;
    delete this.srcDb[IN_SOUNDCARD];
  }

  /** Per-frame hook: move needles from the host's live levels. */
  render(levels?: WebRouterLevels | null): void {
    if (!this.built || !this.container.isConnected || this.container.offsetParent === null) return;
    // The host's meter is built after the router: once it exists, redraw the strips with it.
    if (this.meterArt && this.artTries++ % 30 === 0) {
      if (!this.art) {
        const art = this.meterArt();
        if (art) { this.art = art; this.mount(); return; }
      } else if (document.getElementById(this.art.href) !== this.artSrc) {
        this.fillArt(); // the host rebuilt its meter (power, lamp, style, theme): copy it again
      }
    }
    const vuL = levels?.vuDb ? levels.vuDb[0] : -60;
    const vuR = levels?.vuDb ? levels.vuDb[1] : -60;
    const n = this.needles;
    if (this.externalSource !== this.wasExternal) { this.wasExternal = this.externalSource; this.refresh(); }
    this.renderTabStrip(levels);

    // Each input's own level: generators from their settings, the playing source from the engine.
    this.listen();
    // Every input is always listening: its own level, whether it is playing or not.
    const rowDb = INPUTS.map((_, i): [number, number] => {
      // A POD-33 output has signal only while the POD-33 runs (if it glows it goes)
      if (isPod33Row(i)) return this.pod33Engaged ? this.pod33Db(i - IN_POD33) : [-60, -60];
      if (this.srcDb[i]) return this.srcDb[i];
      if (i === IN_BITBUDDY && this.bitBuddyEngaged) return this.bitBuddyDb();
      if (i === this.activeInput && !this.externalSource && (i !== IN_TAB || this.tabInfo)) return [vuL, vuR];
      return [-60, -60];
    });
    rowDb.forEach((db, i) => this.setMeter(n.inL[i], n.inR[i], db[0], db[1]));
    // An output hears the power sum of the inputs routed to it, so each meter shows its own inputs.
    const sumDb = (dbs: number[]) => {
      const p = dbs.reduce((a, d) => a + (d > -60 ? Math.pow(10, d / 10) : 0), 0);
      return p > 0 ? 10 * Math.log10(p) : -60;
    };

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
        else {
          const routed = INPUTS.map((_, r) => r).filter((r) => this.matrix[r][o] && this.isInputLive(r));
          if (routed.length) db = [sumDb(routed.map((r) => rowDb[r][0])), sumDb(routed.map((r) => rowDb[r][1]))];
          else if (this.externalSource && o < METERS) db = [vuL, vuR]; // an MXL flow drives the meters directly
        }
        db = [clampDb(db[0] + dim), clampDb(db[1] + dim)];
      }
      this.outDb[o] = db;
      this.setMeter(n.outL[o], n.outR[o], db[0], db[1]);
    });
  }
}
