// Which ASIO driver the app takes when none is named, and which it never
// offers. Windows' own order means nothing: on a friend's machine the first
// registered driver was Cubase's old "Generic Low Latency ASIO Driver"
// (asioglld.dll), and opening ASIO on the default device crashed the app — the
// driver calls address 0 from inside the host's call into it (the minidump of
// 2026-11-19; the one host callback that is null is RtAudio's
// bufferSwitchTimeInfo, which the host is entitled to leave out). So drivers
// are ranked, from the last resort up:
//
//   blocked         known to crash the app: left out of the list, never opened
//   hardware-avoid  hardware drivers known to be poor: anything ASUS (and its
//                   Xonar line), Realtek's, the generic "USB Audio CODEC"
//   generic-avoid   ASIO4ALL (FlexASIO does the same job better)
//   steinberg       "Steinberg built-in ASIO Driver", what Cubase itself uses
//                   when there is no ASIO hardware
//   generic         wrappers over the system's own audio: FlexASIO, ASIO2WASAPI
//   hardware        everything else: an interface's own driver
//
// The default is the first driver of the best tier, in the system's order.
// Names are matched ignoring case; "asus" and "xonar" only as the start of a
// word ("Pegasus" is not ASUS). Plain C++, so tools/asio-probe.cpp ranks them
// alike.
#pragma once

#include <cctype>
#include <string>

namespace microtone::asio {

enum class Tier : int { Blocked = -1, HardwareAvoid = 0, GenericAvoid = 1, Steinberg = 2, Generic = 3, Hardware = 4 };

inline std::string lowered(std::string s) {
  for (char &c : s) c = char(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

inline Tier tierOf(const std::string &name) {
  const std::string n = lowered(name);
  const auto has = [&n](const char *part) { return n.find(part) != std::string::npos; };
  // …as a word of its own beginning: not inside another word.
  const auto word = [&n](const std::string &part) {
    for (size_t at = n.find(part); at != std::string::npos; at = n.find(part, at + 1)) {
      if (at == 0 || !std::isalnum(static_cast<unsigned char>(n[at - 1]))) return true;
    }
    return false;
  };
  if (has("generic low latency asio driver") || has("asio directx full duplex driver") || has("asio multimedia driver") || has("magix low latency")) return Tier::Blocked;
  if (word("asus") || word("xonar") || has("realtek") || has("usb audio codec")) return Tier::HardwareAvoid;
  if (has("asio4all") || word("generic") || word("latency")) return Tier::GenericAvoid;
  if (has("steinberg built-in asio driver")) return Tier::Steinberg;
  if (has("flexasio") || has("asio2wasapi")) return Tier::Generic;
  return Tier::Hardware;

  // TODO: out-of-process testing. If they die of access violation and other shit, remove them from the app
}

inline const char *tierName(Tier t) {
  switch (t) {
    case Tier::Blocked: return "blocked: known to crash, never opened by the app";
    case Tier::HardwareAvoid: return "hardware, avoided";
    case Tier::GenericAvoid: return "generic, avoided";
    case Tier::Steinberg: return "Steinberg's built-in";
    case Tier::Generic: return "generic";
    case Tier::Hardware: return "hardware";
  }
  return "";
}

}  // namespace microtone::asio
