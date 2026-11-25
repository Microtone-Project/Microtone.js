// The public key every update must be signed with (minisign.h): the Tauri
// build's updater key (its tauri.conf.json's plugins.updater.pubkey), so one
// key signs both apps' updates and the Tauri updater installs this app on the
// copies it still runs on. test/node/desktop-update.test.js pins it. The
// private key is the repository's TAURI_SIGNING_PRIVATE_KEY secret, with its
// password in TAURI_SIGNING_PRIVATE_KEY_PASSWORD (.github/workflows/desktop-qt.yml).
#pragma once

inline constexpr char kUpdateKey[] =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxMThGMkQ0MzdEODVDNTAKUldSUVhOZzMxUElZc1VnWm0zM215SWxiNGpnSjNaWnR6cCtRR2VCWkU0Sm15SWNPQWloQytYZ0sK";
