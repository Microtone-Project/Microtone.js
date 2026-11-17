#include "resampler.h"

#include <algorithm>
#include <cmath>

namespace microtone {

namespace {

constexpr double kBeta = 8.0;  // RESAMP_BETA
constexpr double kPi = 3.141592653589793;  // Math.PI

double besselI0(double x) {
  double s = 1.0, t = 1.0;
  for (int k = 1;; k++) {
    t *= (x * x) / (4.0 * k * k);
    s += t;
    if (t < 1e-12 * s) return s;
  }
}

/** resampHalfWidth: 12 either side, widened as a downsample narrows the
 *  transition band, capped at 24. Math.round, for the positive values here. */
int halfWidthFor(double ratio) {
  return std::max(8, std::min(24, int(std::floor(12.0 / std::min(1.0, ratio) + 0.5))));
}

}  // namespace

KaiserKernel kaiserKernel(double srcRate, double dstRate) {
  KaiserKernel k;
  const double ratio = dstRate / srcRate;
  const double cutoff = 0.5 * std::min(1.0, ratio);
  k.halfWidth = halfWidthFor(ratio);
  k.nTaps = 2 * k.halfWidth;
  k.history = k.halfWidth - 1;
  k.lead = k.halfWidth;
  k.step = srcRate / dstRate;
  const int n = k.nTaps;
  const double invI0 = 1.0 / besselI0(kBeta);
  k.rows.assign(size_t(k.phases + 1) * size_t(n), 0.0);
  for (int p = 0; p <= k.phases; p++) {
    const double frac = double(p) / k.phases;
    double *row = k.rows.data() + size_t(p) * size_t(n);
    double s = 0.0;
    for (int t = 0; t < n; t++) {
      const double x = double(t - (k.halfWidth - 1)) - frac;
      const double a = 2.0 * cutoff * x;
      const double sinc = a == 0.0 ? 1.0 : std::sin(kPi * a) / (kPi * a);
      const double r = x / k.halfWidth;
      const double win = besselI0(kBeta * std::sqrt(std::max(0.0, 1.0 - r * r))) * invI0;
      row[t] = sinc * win;
      s += row[t];
    }
    const double inv = s != 0.0 ? 1.0 / s : 1.0;
    for (int t = 0; t < n; t++) row[t] *= inv;
  }
  k.deltas.assign(size_t(k.phases) * size_t(n), 0.0);
  for (int p = 0; p < k.phases; p++) {
    for (int t = 0; t < n; t++) {
      k.deltas[size_t(p) * size_t(n) + size_t(t)] =
          k.rows[size_t(p + 1) * size_t(n) + size_t(t)] - k.rows[size_t(p) * size_t(n) + size_t(t)];
    }
  }
  return k;
}

void RingResampler::configure(unsigned srcRate, unsigned dstRate) {
  active_ = srcRate != dstRate && srcRate > 0 && dstRate > 0;
  if (!active_) return;
  k_ = kaiserKernel(double(srcRate), double(dstRate));
  L_.assign(kRingFrames, 0.0f);
  R_.assign(kRingFrames, 0.0f);
  write_ = floor_ = base_ = 0;
  frac_ = 0.0;
}

int RingResampler::framesWanted(int frames) const {
  // The last output frame's newest tap sits `lead` frames past its cursor
  // (renderAndPlay's `+ 2` included).
  const int64_t want = base_ + int64_t(std::ceil(frac_ + frames * k_.step)) + (k_.lead + 2) - write_;
  return want > 0 ? int(std::min<int64_t>(want, kRingFrames / 2)) : 0;
}

void RingResampler::push(const float *interleaved, int n) {
  const int64_t mask = kRingFrames - 1;
  for (int i = 0; i < n; i++) {
    const int64_t w = (write_ + i) & mask;
    L_[size_t(w)] = interleaved ? interleaved[i * 2] : 0.0f;
    R_[size_t(w)] = interleaved ? interleaved[i * 2 + 1] : 0.0f;
  }
  write_ += n;
}

void RingResampler::read(float *out, int frames) {
  const int64_t mask = kRingFrames - 1;
  const int n = k_.nTaps;
  for (int f = 0; f < frames; f++) {
    const double fp = frac_ * k_.phases;
    const int p = int(fp);
    const double g = fp - p;
    const double *row = k_.rows.data() + size_t(p) * size_t(n);
    const double *dRow = k_.deltas.data() + size_t(p) * size_t(n);
    const int64_t first = base_ - k_.history;
    double l = 0.0, r = 0.0;
    for (int t = 0; t < n; t++) {
      const int64_t src = first + t;
      const size_t a = size_t((src < floor_ ? floor_ : src) & mask);
      const double w = row[t] + dRow[t] * g;
      l += double(L_[a]) * w;
      r += double(R_[a]) * w;
    }
    out[f * 2] = float(l);
    out[f * 2 + 1] = float(r);
    frac_ += k_.step;
    while (frac_ >= 1.0) {
      frac_ -= 1.0;
      base_++;
    }
  }
}

void RingResampler::flush() {
  base_ = floor_ = write_;
  frac_ = 0.0;
}

}  // namespace microtone
