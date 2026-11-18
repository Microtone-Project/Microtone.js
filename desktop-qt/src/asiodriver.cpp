#include "asiodriver.h"

// The SDK's C-style entry points (asio.cpp) talk to the driver RtAudio loaded.
// The thiscall shim must follow asio.h; on x64 it is empty.
#include "asiosys.h"
#include "asio.h"
#include "iasiothiscallresolver.h"

namespace microtone::asio {

bool bufferLimits(BufferLimits *out) {
  long min = 0, max = 0, preferred = 0, granularity = 0;
  if (ASIOGetBufferSize(&min, &max, &preferred, &granularity) != ASE_OK) return false;
  if (min <= 0 || max < min) return false;
  out->min = min;
  out->max = max;
  out->preferred = preferred;
  out->granularity = granularity;
  return true;
}

bool controlPanel() { return ASIOControlPanel() == ASE_OK; }

}  // namespace microtone::asio
