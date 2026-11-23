/*! Copyright (c) 2026 Ward-Beck Systems (Ward-Beck.ca). All rights reserved. */
/** Standalone demo: a logging stub engine and a sine-wobble level source. */
import { WebRouter, type WebRouterAudio } from '../src';
import '../src/web-router.css';

const log = (name: string) => (...args: unknown[]) => console.log(`[audio] ${name}`, ...args);
const audio: WebRouterAudio = {
  setMonitor: log('setMonitor'),
  setMonitorVolume: log('setMonitorVolume'),
  connectSoundCard: log('connectSoundCard'),
  connectSystemAudio: log('connectSystemAudio'),
  startPod33Generator: log('startPod33Generator'),
  stopPod33Generator: log('stopPod33Generator'),
  startBitBuddyGenerator: log('startBitBuddyGenerator'),
  stopBitBuddyGenerator: log('stopBitBuddyGenerator'),
  startTestGenerator: log('startTestGenerator'),
};

const router = new WebRouter(document.getElementById('router')!, {
  audio,
  onFlowHint: (f) => console.log('[flow]', f),
}).mount();

const tick = () => {
  const t = performance.now() / 1000;
  router.render({ vuDb: [-12 + 6 * Math.sin(t * 2.1), -12 + 6 * Math.sin(t * 1.7)] });
  requestAnimationFrame(tick);
};
tick();
