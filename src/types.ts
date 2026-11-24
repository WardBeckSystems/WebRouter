/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/** Web Router public types. The router imports nothing from its host. */

export interface Pod33Config {
  freq: number;            // 100, 400, 1000, 0 (silence)
  /** Split tone: the right channel's own frequency (e.g. 1 kHz left / 4 kHz right); null = same as left. */
  freqR?: number | null;
  levelDb: number;         // 0 … -40, -100 = off
  refClock: 'video' | 'aes' | 'int48' | 'int96';
  channelMode: 'stereo' | 'left' | 'right' | 'invert';
}

export interface BitBuddyConfig {
  /** Source: tone, noise, test patterns or a looped WAV / MP3 file. */
  pattern: 'tone' | 'pink' | 'white' | 'brown' | 'walk1s' | 'prbs' | 'minmax' | 'file';
  sampleRate: 48000 | 44100 | 32000 | 96000;
  proMode: boolean;            // true = Professional AES3, false = Consumer S/PDIF
  audioData: 'audio' | 'data'; // PCM audio or non-audio bitstream
  /* ABS-1 Bit Spitter front panel (abs1v103.asm PROCESS) */
  level: 0 | -12 | -20 | null; // AUDIO LEVEL lamps: 0 / -12 / -20 dBFS, null = OFF
  tone: 1000 | 400;            // TONE: 1KHz / 400Hz
  ext: boolean;                // SAMPLE RATE stepped to EXT (lock to an AES reference)
  cycle: boolean;              // CHB CYCLE: channel B on/off every ~0.5 s
  invert: boolean;             // CHB INVERT: channel B out of phase
  bOff: boolean;               // CHB OFF: channel B muted
  invalid: boolean;            // INVALID: validity bit set on the AES stream
  /** A fault on the AES3 line (what the receiver hears). */
  fault: 'clean' | 'noise' | 'badeq' | 'jitter' | 'drop' | 'slip' | 'biphase' | 'noclock';
  /** The looped file's name (pattern 'file'). */
  fileName?: string;
}

export const DEFAULT_POD33_CONFIG: Pod33Config = {
  freq: 1000,
  levelDb: -18, // Ward-Beck EBU 0 VU calibration
  refClock: 'int48',
  channelMode: 'stereo',
};

export const DEFAULT_BITBUDDY_CONFIG: BitBuddyConfig = {
  pattern: 'tone',
  sampleRate: 48000,
  proMode: true,
  audioData: 'audio',
  level: -20,
  tone: 1000,
  ext: false,
  cycle: false,
  invert: false,
  bOff: false,
  invalid: false,
  fault: 'clean',
};

/** What the user shared through getDisplayMedia (CH 2). */
export interface BrowserTabInfo {
  title: string;            // tab / window title, or a fallback when the browser hides it
  surface: string;          // 'browser' (tab) | 'window' | 'monitor'
  origin?: string;          // tab origin via Capture Handle, when the page exposes it
  audioLabel?: string;
  sampleRate?: number;
  channelCount?: number;
  width?: number;
  height?: number;
  startedAt: number;
  live: boolean;
}

/** The audio engine surface the router drives. Any engine with these methods works. */
export interface WebRouterAudio {
  ctx?: { state: string; resume(): Promise<void> } | null;
  setMonitor(enabled: boolean, volume?: number | null): void;
  setMonitorVolume(volume: number): void;
  /** Cue / HP output on or off (XTM: plays into the TAP's HW 2 bus). */
  setCue?(enabled: boolean): unknown;
  /** Sound card input; deviceId from enumerateDevices (null = the default input). */
  connectSoundCard(deviceId?: string | null): unknown;
  connectSystemAudio(surface: 'browser'): unknown;
  startPod33Generator(config: Pod33Config): void;
  stopPod33Generator(): void;
  startBitBuddyGenerator(config: BitBuddyConfig): void;
  stopBitBuddyGenerator(): void;
  startTestGenerator(type: string): void;
  /** Current meter source kind; 'mxl' means an MXL flow (picked outside the router) owns the meters. */
  sourceType?: string;
  /** The shared tab / window behind CH 2, if any. */
  tabInfo?: BrowserTabInfo | null;
}

/** Per-frame meter levels (dB per channel, L then R). */
export interface WebRouterLevels {
  vuDb?: ArrayLike<number>;
  dbfs?: ArrayLike<number>;
}

export interface WebRouterOptions {
  /** Audio engine to drive. Without one the router still renders but routes nothing. */
  audio?: WebRouterAudio | null;
  /** Base URL of the ward-beck-audio-tab.py daemon. */
  daemonUrl?: string;
  /** Called when the router wants a different MXL flow shown (e.g. POD-33 engaged → ref tone flow). */
  onFlowHint?: (flowId: string) => void;
  /** Clicking an MXL transmitter column opens that flow (XTM: the Transmitters tab). */
  onOpenFlow?: (flowId: string) => void;
  /** Open the receivers (CH 9 / CH 10's stream name was clicked). */
  onOpenReceivers?: () => void;
  /**
   * A crosspoint on a Meter Input column was made: router input `input` now feeds the
   * meter's INPUT button `meter` (1-4). XTM: assigns that button and plays it.
   */
  onMeterInput?: (meter: number, input: number) => void;
  /**
   * A receiver row (CH 9 Network / CH 10 MoIP) was engaged: play the TAP's MXL flow `flowId`
   * (XTM: puts that flow on the meters).
   */
  onPlayFlow?: (flowId: string) => void;
  /**
   * The host's VU meter to show in miniature on every strip (bezel and all); null until it
   * exists. Without it the router draws its own small meter.
   */
  meterArt?: () => import('./vu-meter').MeterArt | null;
}

export interface RouterChannel {
  tag: string;
  name: string;
  sub: string;
  pill: string;
}
