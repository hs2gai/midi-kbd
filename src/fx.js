// Effect chain equivalent to sforzando's "Ambience".
//
//   input ─┬─ dry ────────────────────────────────────┐
//          └─ send → predelay → convolver → damp ─────┴→ loShelf → hiShelf → master → out
//
// The impulse response is synthesized from the parameters each time instead of using an external IR file.
// This lets Decay / Size / Diffusion / Width be changed in real time.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Early reflection taps. Times stretch with room size; later taps are quieter. */
function earlyTaps(size) {
  const base = [0.0043, 0.0215, 0.0225, 0.0268, 0.027, 0.0298, 0.0458, 0.0485, 0.0572, 0.0125];
  return base.map((t, i) => [t * size, (1 - i / base.length) * 0.55]);
}

/**
 * Synthesizes the IR.
 * decay  : length in seconds, roughly RT60
 * size   : room size (early reflection spacing and build-up length)
 * diffusion: density of reflection grains. Low = grainy, high = smooth
 * width  : 0 = L/R fully correlated (mono), 1 = uncorrelated (wide)
 */
function buildImpulse(ctx, { decay, size, diffusion, width }) {
  const length = Math.max(1, Math.round(ctx.sampleRate * decay));
  const ir = ctx.createBuffer(2, length, ctx.sampleRate);
  const buildup = Math.max(1, Math.round(ctx.sampleRate * 0.006 * size));
  const density = 0.03 + 0.97 * clamp01(diffusion);
  const taps = earlyTaps(size);

  const left = ir.getChannelData(0);
  const right = ir.getChannelData(1);

  for (const channel of [left, right]) {
    for (let i = 0; i < length; i++) {
      const t = i / length;
      // Exponential-like decay. Remaining time to the power of 2.5 gives a natural tail
      const envelope = (1 - t) ** 2.5;
      const grain = Math.random() < density ? Math.random() * 2 - 1 : 0;
      const fadeIn = i < buildup ? i / buildup : 1;
      channel[i] = grain * envelope * fadeIn;
    }
    for (const [time, gain] of taps) {
      const index = Math.round(time * ctx.sampleRate);
      if (index < length) channel[index] += (Math.random() * 2 - 1) * gain;
    }
  }

  // width: mixing L/R raises correlation and narrows the image
  const cross = (1 - clamp01(width)) * 0.5;
  if (cross > 0) {
    for (let i = 0; i < length; i++) {
      const l = left[i];
      const r = right[i];
      left[i] = l * (1 - cross) + r * cross;
      right[i] = r * (1 - cross) + l * cross;
    }
  }

  // Normalize by RMS so the volume doesn't jump when parameters change
  let sum = 0;
  for (let i = 0; i < length; i++) sum += left[i] * left[i] + right[i] * right[i];
  const norm = Math.sqrt(length / Math.max(sum, 1e-9)) * 0.06;
  for (let i = 0; i < length; i++) {
    left[i] *= norm;
    right[i] *= norm;
  }
  return ir;
}

export class FxChain {
  constructor(ctx) {
    this.ctx = ctx;
    this.params = {
      send: 0.06,
      decay: 1.2,
      size: 1.0,
      predelay: 0.02,
      diffusion: 0.75,
      width: 1.0,
      damping: 6000,
      loFreq: 180,
      loGain: 0,
      hiFreq: 4500,
      hiGain: 0,
      master: 0.8,
    };

    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.send = ctx.createGain();
    this.predelay = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false; // Normalization is done in buildImpulse
    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.loShelf = ctx.createBiquadFilter();
    this.loShelf.type = "lowshelf";
    this.hiShelf = ctx.createBiquadFilter();
    this.hiShelf.type = "highshelf";
    this.master = ctx.createGain();

    this.input.connect(this.dry).connect(this.loShelf);
    this.input.connect(this.send).connect(this.predelay);
    this.predelay.connect(this.convolver).connect(this.damp).connect(this.loShelf);
    this.loShelf.connect(this.hiShelf).connect(this.master).connect(ctx.destination);

    this.#applyParams({ immediate: true });
    this.rebuildImpulse();
  }

  /**
   * Changes from the UI are ramped smoothly to avoid noise. Initialization and restored settings apply immediately.
   * While the AudioContext is suspended (waiting for a gesture due to autoplay restrictions), currentTime doesn't
   * advance, so smooth ramps never finish. The first note after resuming played with send still at its default of 1
   * (about 16x the intended value), producing a loud sound mixed with reverb noise.
   */
  #applyParams({ immediate = false } = {}) {
    const p = this.params;
    const now = this.ctx.currentTime;
    const apply = (param, value) => {
      param.cancelScheduledValues(now);
      if (immediate) param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, 0.02);
    };
    // Lower dry slightly according to the send amount to keep the overall level
    apply(this.dry.gain, 1 - p.send * 0.3);
    apply(this.send.gain, p.send);
    apply(this.predelay.delayTime, p.predelay);
    apply(this.damp.frequency, p.damping);
    this.loShelf.frequency.value = p.loFreq;
    apply(this.loShelf.gain, p.loGain);
    this.hiShelf.frequency.value = p.hiFreq;
    apply(this.hiShelf.gain, p.hiGain);
    apply(this.master.gain, p.master);
  }

  rebuildImpulse() {
    this.convolver.buffer = buildImpulse(this.ctx, this.params);
  }

  /** Applies saved settings in one go, rebuilding the IR only once. */
  setAll(params) {
    Object.assign(this.params, params);
    this.#applyParams({ immediate: true });
    this.rebuildImpulse();
  }

  /** Called from the UI. Re-synthesizes the IR only for parameters that require it. */
  set(name, value) {
    this.params[name] = value;
    this.#applyParams();
    if (["decay", "size", "diffusion", "width"].includes(name)) {
      clearTimeout(this.#rebuildTimer);
      this.#rebuildTimer = setTimeout(() => this.rebuildImpulse(), 120);
    }
  }

  #rebuildTimer = 0;
}
