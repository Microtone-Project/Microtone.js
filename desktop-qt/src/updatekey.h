// The public key every update must be signed with (minisign.h): the Tauri
// build's updater key, exactly as desktop/tauri.conf.json has it
// (plugins.updater.pubkey), so one key signs both apps' updates and the Tauri
// updater can install this app. test/node/desktop-update.test.js keeps the two
// equal. The private key is the repository's TAURI_SIGNING_PRIVATE_KEY
// secret (desktop/README.md, "Releasing").
#pragma once

inline constexpr char kUpdateKey[] =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEIxMThGMkQ0MzdEODVDNTAKUldSUVhOZzMxUElZc1VnWm0zM215SWxiNGpnSjNaWnR6cCtRR2VCWkU0Sm15SWNPQWloQytYZ0sK";
