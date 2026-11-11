// Device capability detection → a quality profile every realm reads to scale its workload.
// Override with ?q=low|mid|high|ultra. Dynamic resolution (see App) trims the last few percent at runtime.

const TIERS = {
  //            max DPR  msaa  particle  ray-march  shadow   bloom   dynamic
  low:   { pixelRatio: 1.0,  msaa: 0, particles: 0.12, steps: 0.45, shadowMap: 1024, bloomMips: 5, dynamicRes: false, minScale: 0.5 },
  mid:   { pixelRatio: 2.0,  msaa: 2, particles: 0.35, steps: 0.65, shadowMap: 2048, bloomMips: 6, dynamicRes: true,  minScale: 0.55 },
  high:  { pixelRatio: 2.0,  msaa: 4, particles: 1.0,  steps: 1.0,  shadowMap: 2048, bloomMips: 7, dynamicRes: true,  minScale: 0.6 },
  ultra: { pixelRatio: 3.0,  msaa: 4, particles: 2.0,  steps: 1.35, shadowMap: 4096, bloomMips: 8, dynamicRes: true,  minScale: 0.7 },
};

export function detectQuality(gl) {
  const params = new URLSearchParams(location.search);
  let gpu = '';
  try {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
  } catch { /* privacy settings may block this */ }

  const software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(gpu);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const touch = (navigator.maxTouchPoints || 0) > 0;
  const small = Math.min(screen.width, screen.height) < 820;
  const mobile = coarse && touch && (small || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
  const mem = navigator.deviceMemory || (mobile ? 4 : 8);
  const cores = navigator.hardwareConcurrency || 4;

  let tier;
  if (software) tier = 'low';
  else if (mobile) {
    // recent flagship phones/tablets handle 'mid' comfortably; Apple GPUs and Adreno 7xx+/Mali-G7xx+ are strong
    tier = mem <= 3 || cores <= 4 ? 'low' : 'mid';
    if (/Apple GPU|Apple M\d/i.test(gpu) && Math.max(screen.width, screen.height) >= 1000) tier = 'high'; // iPad-class
  } else {
    const strong = /(RTX|GTX 1[06-9]|GTX 9[78]|RX [5-9]\d{3}|RX \d{3}|Arc|Apple M\d|Apple GPU|Radeon Pro|Quadro|Titan)/i.test(gpu);
    const weak = /(Intel\(R\) (U?HD|Iris)|HD Graphics|Mali|Adreno|PowerVR|Iris\(R\) Xe)/i.test(gpu);
    tier = strong ? 'ultra' : weak ? 'high' : 'high';
    if (weak && cores <= 4) tier = 'mid';
  }
  const forced = params.get('q');
  if (forced && TIERS[forced]) tier = forced;

  const q = { tier, gpu, software, mobile, touch, ...TIERS[tier] };
  q.pixelRatio = Math.min(q.pixelRatio, Math.max(1, window.devicePixelRatio || 1));
  if (params.has('dpr')) q.pixelRatio = Math.max(0.25, Number(params.get('dpr')) || 1);
  if (params.has('msaa')) q.msaa = Number(params.get('msaa')) | 0;
  if (software || params.get('dyn') === '0') q.dynamicRes = false;
  q.maxSamples = gl.getParameter(gl.MAX_SAMPLES) | 0;
  q.msaa = Math.min(q.msaa, q.maxSamples);
  q.floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  q.halfFloatTargets = q.floatTargets || !!gl.getExtension('EXT_color_buffer_half_float');
  q.floatBlend = !!gl.getExtension('EXT_float_blend');
  q.floatLinear = !!gl.getExtension('OES_texture_float_linear');
  q.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) | 0;
  return q;
}
