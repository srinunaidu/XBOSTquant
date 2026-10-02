/* OPTION DISCOVERY Web Worker — loads discovery-engine.js via importScripts.
   Receives {type:'run', text, cfg}; streams {type:'log'|'progress'} and posts
   {type:'done', result} or {type:'error'}. Independent of futures engine. */
try { importScripts('discovery-engine.js'); } catch (e) {}

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;
  const E = self.XBOST_DISCOVERY;
  if (!E) {
    self.postMessage({ type: 'error', message: 'XBOST_DISCOVERY missing (discovery-engine.js failed to load)' });
    return;
  }
  try {
    const t0 = Date.now();
    const result = E.run(msg.text, msg.cfg || {},
      line => self.postMessage({ type: 'log', line }),
      (p, stage) => self.postMessage({ type: 'progress', p, stage }));
    result.wallMs = Date.now() - t0;
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err).slice(0, 800),
      log: (err && err.log) || [], finalStatus: (err && err.finalStatus) || 'BLOCKED_DATA' });
  }
};
