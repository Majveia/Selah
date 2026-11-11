import { buildField } from './field.js';
self.onmessage = (e) => {
  const { M, seed, opts } = e.data;
  const f = buildField(M, seed, opts);
  self.postMessage(f, [f.psi.buffer, f.t0.buffer, f.t1.buffer, f.t2.buffer]);
};
