// The web build's one interpolator (core/audio/resampler.js), ported, and the
// worklet's read cursor over it (core/worklet/taud-processor.js, the shared
// ring's consume loop: a whole frame and a fraction kept apart, so the
// rounding — and the samples — do not depend on how far into the stream
// playback started): the engine renders at 48 kHz, as it does in the browser, and a
// device at another rate hears it through the same Kaiser-windowed sinc —
// β 8, 512 phases, 8…24 half-taps with the cutoff following the ratio, each
// phase row DC-normalised, the two rows bracketing the true phase blended.
//
// So a device change never touches the engine: no rebuild, no song uploaded
// again, playback carries on.
#pragma once

#include <cstdint>
#include <vector>

namespace microtone {

struct KaiserKernel {
  int phases = 512;
  int halfWidth = 0, nTaps = 0;
  int history = 0;  // taps before the read position's frame
  int lead = 0;     // frames past it that must already be there
  double step = 1.0;
  std::vector<double> rows;    // (phases + 1) rows of nTaps
  std::vector<double> deltas;  // phases rows: rows[p + 1] - rows[p]
};

/** resampler.js kaiserKernel(srcRate, dstRate). */
KaiserKernel kaiserKernel(double srcRate, double dstRate);

/**
 * The read cursor: engine frames go into a ring, the device's frames come out
 * through the kernel. Not thread-safe; the host calls it under its engine lock.
 */
class RingResampler {
 public:
  /** Equal rates: inactive, and the host writes the engine's frames straight
   *  through. Allocates: never on the audio thread. */
  void configure(unsigned srcRate, unsigned dstRate);
  bool active() const { return active_; }

  /** Engine frames to push before `frames` device frames can be read. */
  int framesWanted(int frames) const;
  /** Interleaved stereo engine frames (null: silence). */
  void push(const float *interleaved, int n);
  /** `frames` device frames, interleaved stereo. */
  void read(float *out, int frames);
  /** A transport jump: drop the buffered tail, and let no tap reach back
   *  across the cut (taud-processor.js flushRing). */
  void flush();

 private:
  static constexpr int kRingFrames = 16384;  // power of two
  bool active_ = false;
  KaiserKernel k_;
  std::vector<float> L_, R_;
  int64_t write_ = 0;
  int64_t floor_ = 0;  // the oldest frame a tap may read (the last jump)
  int64_t base_ = 0;   // the read position: a whole frame…
  double frac_ = 0.0;  // …and how far past it, in [0, 1)
};

}  // namespace microtone
