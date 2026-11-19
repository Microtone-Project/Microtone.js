// Which ASIO driver the app takes when none is named, and which it never
// offers. Windows' own order means nothing: on a friend's machine the first
// registered driver was Cubase's old "Generic Low Latency ASIO Driver"
// (asioglld.dll), and opening ASIO on the default device crashed the app — the
// driver calls address 0 from inside the host's call into it (the minidump of
// 2026-11-19; the one host callback that was null is RtAudio's
// bufferSwitchTimeInfo, which a host is entitled to leave out — and which,
// since, forwards to bufferSwitch: vendor/VENDOR-VERSIONS.md, patch 2). So
// drivers are ranked, from the last resort up:
//
//   blocked         known to crash the app: Cubase's "Generic Low Latency ASIO
//                   Driver", the old "ASIO DirectX Full Duplex" and "ASIO
//                   Multimedia" drivers, MAGIX's "Low Latency" — never loaded
//   hardware-avoid  hardware drivers known to be poor: anything ASUS (and its
//                   Xonar line), Realtek's, the generic "USB Audio CODEC"
//   generic-avoid   ASIO4ALL (FlexASIO does the same job better), and any
//                   driver calling itself "generic" or "latency" (a wrapper)
//   steinberg       "Steinberg built-in ASIO Driver", what Cubase itself uses
//                   when there is no ASIO hardware
//   generic         wrappers over the system's own audio: FlexASIO, ASIO2WASAPI
//   hardware        everything else: an interface's own driver
//
// The default is the first driver of the best tier, in the system's order.
// Names are matched ignoring case; "asus", "xonar", "generic" and "latency"
// only as the start of a word ("Pegasus" is not ASUS).
//
// A list can only hold the drivers someone has met. Every other driver is
// tried before the app loads it (TODO 349, src/asiocheck.cpp): `asio-probe
// check "<name>"` loads it ALONE in a process of its own, opens it, runs a
// second of silence through it and closes it, and says how it went in its
// exit code (below). One that crashed or hung there is refused — never listed,
// never loaded (RtAudio's driver filter: vendor/VENDOR-VERSIONS.md) — until
// its DLL changes. Plain C++, so tools/asio-probe.cpp ranks and reports alike.
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

// ── a driver tried in a process of its own ──

/** `asio-probe check "<name>"`'s exit codes. Anything else — an exception's
 *  code (0xC0000005 …), abort()'s 3, std::terminate's — is a crash. */
enum CheckExit : int {
  kCheckOk = 0,         // opened, started, called back, stopped, closed
  kCheckQuiet = 10,     // opened and started, but no callback in a second
  kCheckUnopened = 11,  // would not open or start (busy, unplugged, refused)
  kCheckNotFound = 12,  // not listed: would not load or answer RtAudio's probe
};

/** What the check found. A driver that crashed or hung is refused; one that
 *  merely would not open (its device busy) or was quiet is not punished. */
enum class Verdict { Unchecked, Ok, Quiet, Unopened, Crashed, Hung };

/** `crashed`: the process ended abnormally as the system tells it apart (a
 *  signal; on Windows a crash is an ordinary exit with the exception's code,
 *  0xC0000005, which the default case takes). */
inline Verdict verdictOf(unsigned long exitCode, bool crashed, bool timedOut) {
  if (timedOut) return Verdict::Hung;
  if (crashed) return Verdict::Crashed;
  switch (exitCode) {
    case kCheckOk: return Verdict::Ok;
    case kCheckQuiet: return Verdict::Quiet;
    case kCheckUnopened:
    case kCheckNotFound: return Verdict::Unopened;
    default: return Verdict::Crashed;
  }
}

inline bool refuses(Verdict v) { return v == Verdict::Crashed || v == Verdict::Hung; }

inline const char *verdictName(Verdict v) {
  switch (v) {
    case Verdict::Unchecked: return "unchecked";
    case Verdict::Ok: return "ok";
    case Verdict::Quiet: return "quiet";
    case Verdict::Unopened: return "unopened";
    case Verdict::Crashed: return "crashed";
    case Verdict::Hung: return "hung";
  }
  return "unchecked";
}

inline Verdict verdictNamed(const std::string &name) {
  for (Verdict v : {Verdict::Ok, Verdict::Quiet, Verdict::Unopened, Verdict::Crashed, Verdict::Hung}) {
    if (name == verdictName(v)) return v;
  }
  return Verdict::Unchecked;
}

}  // namespace microtone::asio
