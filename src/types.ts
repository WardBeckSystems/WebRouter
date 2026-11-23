/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/** Web Router public types. The router imports nothing from its host. */

export interface Pod33Config {
  freq: number;            // 100, 400, 1000, 0 (silence)
  levelDb: number;         // 0 … -40, -100 = off
  refClock: 'video' | 'aes' | 'int48' | 'int96';
  channelMode: 'stereo' | 'left' | 'right' | 'invert';
}

export interface BitBuddyConfig {
  pattern: 'tone' | 'walk1s' | 'prbs' | 'minmax';
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
};

/** The audio engine surface the router drives. Any engine with these methods works. */
export interface WebRouterAudio {
  ctx?: { state: string; resume(): Promise<void> } | null;
  setMonitor(enabled: boolean, volume?: number | null): void;
  setMonitorVolume(volume: number): void;
  connectSoundCard(): unknown;
  connectSystemAudio(surface: 'browser'): unknown;
  startPod33Generator(config: Pod33Config): void;
  stopPod33Generator(): void;
  startBitBuddyGenerator(config: BitBuddyConfig): void;
  stopBitBuddyGenerator(): void;
  startTestGenerator(type: string): void;
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
}

export interface RouterChannel {
  tag: string;
  name: string;
  sub: string;
  pill: string;
}
