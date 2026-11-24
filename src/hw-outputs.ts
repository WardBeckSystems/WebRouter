/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/**
 * Hardware outputs: every sound card output on the host (PipeWire sinks, from the TAP's
 * GET /api/hw), and what each one listens to. Rows are the TAP's outputs to hardware (HW 1
 * Speakers, HW 2 Cue/HP: the router's HW columns) and the hardware inputs,
 * columns are the hardware outputs; each lit crosspoint is a real PipeWire loopback that the
 * TAP makes or breaks (POST /api/hw). Same grid look as the main matrix.
 */

interface HwOutput { name: string; label: string; card?: string; card_name?: string; state: string; virtual: boolean; default: boolean }
interface HwSource { name: string; label: string; tag?: string; card?: string; card_name?: string; detail?: string; kind: 'out' | 'bus' | 'input' }
interface HwLink { module: string; source: string; sink: string; tap: boolean }
interface HwStatus { outputs: HwOutput[]; sources: HwSource[]; links: HwLink[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** "GP104 High Definition Audio Controller Digital Stereo (HDMI 2)" → "HDMI 2" */
function shortOut(o: HwOutput): string {
  const paren = o.label.match(/\(([^)]+)\)\s*$/);
  if (paren) return paren[1];
  return o.label.replace(/\b(High Definition Audio Controller|Analog Stereo|Digital Stereo)\b/g, '').replace(/\s+/g, ' ').trim() || o.name;
}

/** Sound card name as ALSA lists it ("HDA NVidia"); the port is added only when a card has several. */
function cardName(o: HwOutput | HwSource, all: (HwOutput | HwSource)[]): string {
  if (!o.card_name) return o.label;
  const shared = all.filter((x) => x.card === o.card).length > 1;
  return shared ? `${o.card_name} · ${shortOut(o as HwOutput)}` : o.card_name;
}

export class HwOutputs {
  private status: HwStatus | null = null;
  private key = '';
  private timer: number | undefined;
  private busy = false;

  private meterTimer: number | undefined;

  /** levelOf("HW 1") → [L, R] in VU dB (0 VU = −18 dBFS): the router's own HW 1 / HW 2 meters. */
  constructor(private el: HTMLElement, private daemonUrl: string, private levelOf?: (tag: string) => [number, number] | null) {}

  /** HW 1 / HW 2 rows carry a small meter pair, fed from the router's output meters. */
  private meterTick(): void {
    if (!this.levelOf || this.el.offsetParent === null) return;
    this.el.querySelectorAll<HTMLElement>('[data-hw-bar]').forEach((bar) => {
      const db = this.levelOf!(bar.dataset.hwBar!);
      bar.querySelectorAll<HTMLElement>('i').forEach((seg, c) => {
        const v = db ? db[c] : -60;
        seg.style.width = `${Math.max(0, Math.min(100, ((v + 40) / 43) * 100))}%`; // −40 … +3 VU
        seg.classList.toggle('hot', v > 0);
      });
    });
  }

  mount(): this {
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-hw-src]');
      if (b) this.toggle(b.dataset.hwSrc!, b.dataset.hwSink!, !b.classList.contains('connected'));
    });
    // Poll only while the router is on screen (the grid itself is hidden until it has content)
    const poll = () => { if ((this.el.parentElement as HTMLElement | null)?.offsetParent !== null) this.load(); };
    poll();
    this.timer = window.setInterval(poll, 2500);
    this.meterTimer = window.setInterval(() => this.meterTick(), 33);
    return this;
  }

  destroy(): void { clearInterval(this.timer); clearInterval(this.meterTimer); }

  private load(): void {
    if (this.busy) return;
    fetch(`${this.daemonUrl}/api/hw`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((st: HwStatus) => this.show(st))
      .catch(() => this.show(null));
  }

  private toggle(source: string, sink: string, on: boolean): void {
    this.busy = true;
    fetch(`${this.daemonUrl}/api/hw`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, sink, on }),
    })
      .then((r) => r.json())
      .then((st: HwStatus) => { if (st && st.outputs) this.show(st); })
      .catch(() => {})
      .finally(() => { this.busy = false; });
  }

  private show(st: HwStatus | null): void {
    const key = JSON.stringify(st);
    if (key === this.key) return;
    this.key = key;
    this.status = st;
    if (!st) {
      this.el.innerHTML = `<div class="wr-hw-off">Hardware outputs appear when the TAP is running (localhost:8467).</div>`;
      return;
    }
    const linked = (src: string, sink: string) => st.links.find((l) => l.source === src && l.sink === sink);
    const head = st.outputs.map((o, i) => `
      <th class="wr-grid-out-head wr-hw-out" scope="col" title="${esc(o.label)}\n${esc(o.name)}${o.default ? '\nDefault output' : ''}">
        <div class="wr-strip wr-out-strip${o.state === 'RUNNING' ? ' selected' : ''}">
          <div class="wr-strip-top">
            <span class="wr-strip-tag wr-pill-out">${o.card ? `card ${esc(o.card)}` : `HW ${i + 1}`}</span>
            <span class="wr-strip-name">${esc(o.card_name ? cardName(o, st.outputs) : shortOut(o))}</span>
            <span class="wr-hw-led${o.state === 'RUNNING' ? ' on' : ''}" aria-label="${o.state}"></span>
          </div>
        </div>
      </th>`).join('');
    const rows = st.sources.map((s) => `
      <tr class="wr-grid-row">
        <th class="wr-grid-in wr-hw-src" scope="row" title="${esc(s.label)}${s.detail ? '\n' + esc(s.detail) : ''}\n${esc(s.name)}">
          <span class="wr-strip-tag wr-pill-${s.kind === 'out' ? 'hw' : s.kind === 'bus' ? 'sys' : 'mic'}">${s.kind === 'out' ? esc(s.tag || 'HW') : s.kind === 'bus' ? 'BUS' : s.card ? `card ${esc(s.card)}` : 'IN'}</span>
          <span class="wr-strip-name">${esc(s.kind === 'input' ? cardName(s, st.sources) : s.label)}</span>
          ${s.kind === 'out' && this.levelOf ? `<span class="wr-hw-bar" data-hw-bar="${esc(s.tag || '')}" aria-hidden="true"><i></i><i></i></span>` : ''}
        </th>
        ${st.outputs.map((o) => {
          const l = linked(s.name, o.name);
          // A sound card never receives itself (that is a feedback loop): no crosspoint
          if (s.kind === 'input' && s.card && s.card === o.card) return '<td class="wr-td-crosspoint"></td>';
          return `<td class="wr-td-crosspoint"><button type="button" class="wr-matrix-btn${l ? ' connected' : ''}"
            data-hw-src="${esc(s.name)}" data-hw-sink="${esc(o.name)}"
            title="${esc(s.label)} → ${esc((o.card_name ? cardName(o, st.outputs) : shortOut(o)))}${l?.tap ? ' (TAP speaker leg)' : ''}"
            aria-label="${esc(s.label)} to ${esc((o.card_name ? cardName(o, st.outputs) : shortOut(o)))}" aria-pressed="${l ? 'true' : 'false'}"><span class="wr-matrix-led"></span></button></td>`;
        }).join('')}
      </tr>`).join('');
    this.el.innerHTML = `
      <table class="wr-matrix-table wr-grid wr-hw-grid" aria-label="Hardware outputs: sources down, sound card outputs across">
        <thead><tr><th class="wr-grid-corner wr-hw-corner">HARDWARE</th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}
