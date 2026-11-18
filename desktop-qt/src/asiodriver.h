// What RtAudio does not ask an ASIO driver, asked through the SDK's own calls
// (vendor/rtaudio/include): the buffer sizes it allows, and its settings
// panel. Both go to the driver RtAudio has loaded, which it loads when a
// stream opens and unloads when it closes — so they answer only while an ASIO
// stream is open. Windows only (MICROTONE_ASIO).
#pragma once

namespace microtone::asio {

/** ASIOGetBufferSize: sizes in frames. `granularity` -1 = powers of two
 *  between min and max, 0 = `preferred` only, n = steps of n. */
struct BufferLimits {
  long min = 0, max = 0, preferred = 0, granularity = 0;
};

/** False when no driver is loaded or it would not say. */
bool bufferLimits(BufferLimits *out);

/** The driver's own settings window (its buffer, its clock, its routing).
 *  Some drivers return at once and some only when it closes; a change made
 *  there arrives as the driver's reset request. */
bool controlPanel();

}  // namespace microtone::asio
