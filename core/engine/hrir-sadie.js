// GENERATED FILE — do not edit. Rebuild with: node tools/make-hrir-table.js
//
// GoogleVR / SADIE spherical-harmonic HRIR set, order 3 (16 ambisonic
// channels), 256 taps at 48000 Hz, as taken from Google Omnitone
// (src/resources/sh_hrir_order_3.wav, md5 310d2836b94909a9b49a84c2ebbf3552).
//
// Copyright (c) 2017 Google Inc. and (c) 2017 University of York, licensed
// under the Apache License 2.0 — see vendor/VENDOR-VERSIONS.md. The
// measurements are the SADIE project's Google/VR binaural filter set:
// https://www.york.ac.uk/sadie-project/GoogleVRSADIE.html
//
// ── What these numbers ARE ──
// Channel k is the LEFT ear's impulse response for ambisonic channel k in ACN
// order, SN3D normalised. Decoding an ambisonic scene to headphones is then one
// convolution per channel and a sum — no per-source filtering, no head model to
// tune — and the right ear comes free: mirroring a listener left↔right flips the
// sign of every harmonic with m < 0 and leaves the rest alone, so
// L = Σ_{m≥0} + Σ_{m<0} and R = Σ_{m≥0} − Σ_{m<0}. The set already carries the
// max-rE weighting Google baked in, which is why the decoder applies no shelf,
// no near-field compensation and no gain of its own beyond one calibration
// scalar (see binaural.js).
//
// Stored channel-major as int16 little-endian, base64'd: the layout the
// convolver reads, so decodeShHrir() is a scale and a copy.

/** Ambisonic order the set decodes, and the channel count that implies. */
export const HRIR_ORDER = 3;
export const HRIR_CHANNELS = 16;
/** Taps per channel, and the rate they were measured at. */
export const HRIR_LENGTH = 256;
export const HRIR_RATE = 48000;

const HRIR_BASE64 = [
  "/v/z//3/AgD//wYAAAAKAN7/sv9RAHUBe/4//LsDzQQV/736/PfwAXT/MvkAAnADoAfjDQcNWAHw/UECSv7RA4UECAoGCPf8",
  "d//p+Rz8L/4x/1cBx//6AHf8ggHhAEQAMwFM/SD/9/sq/xv++/3f/z/9kf+N/f3+uv6c/vv+Vf6C/3P9yf4Y/sb+L/92/pr+",
  "rv2y/ur9N//M/p7+5P7+/fL+gf4V/5T+6f6b/lT+/v5b/iH/wP70/r3+tP7P/rD+Lf+F/g//vv7P/gv/2P4h//P+HP/L/h7/",
  "7P4M/0L/6P5R/y3/Rf9E/1P/N/9M/23/Lv9o/yb/Qf9Q/0D/Vf9b/2H/Sv9+/1n/d/99/2j/hP9v/3n/c/+K/3n/if+D/3j/",
  "mv99/47/iP+K/43/jP+Q/5b/o/+g/8L/qP+2/8b/q//A/8P/xf/R/9L/v//R/8b/vP/d/8H/0P/b/8T/1//e/83/3P/h/8j/",
  "4f/Y/8n/4//S/9H/4v/S/9L/4//R/9f/5P/P/9z/4P/Q/9//3//S/+D/3P/S/+L/2v/W/+T/2P/Z/+T/2P/c/+T/2P/g/+P/",
  "2f/i/+L/2v/l/+H/3P/m/+D/3//m/+D/4f/n/+D/4//n/+D/5f/m/+D/5v/l/+L/5//k/+H/5f/h/+H/5P/h/+T/5v/n/+r/",
  "7f/v//P/9f8EABgACgAAAAIA8//x/+//e//T/vAAEwWT/LT1wAdmCNj7+fNB75wLvwYu9AID4AYNEdkQ8RVfELP6HwcyBkoB",
  "lf9Y+9f7j/mX/wr7FP14/+f8PftR90/8cfgf+WH5cvli/Hf6V/4L/Zj+xPxC/Nr/AP6S/rr8rP3Q/MH8WP3D/XX/xP17/1L+",
  "IP/Y/9T+6v+d/1wAQ//p/3H/2/98ADX/SADA/zUATgCHAF0AMgCTAOj/xQBJAIsApAAkAFQAUwB1ABQApwA6AFoAfwAjAK4A",
  "ZABEADEATgAKADAANwDm/0EA+v8uAEcAEQATADUAHQAIAEUA9f8tACsACwA+ABMABQAbAB4AAgA8ABEA/v8gAPT/FwAXAA8A",
  "FQAYAPH/EQAnAPD/HwD1//v/JQDp/wAAJAD+/xkASwAOAC0APAAXAEcAOAAuAEgANwAxAEsAMAAuAEYAFQAmACwAAwAZABIA",
  "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",
  "tQdUAl32jP49AOUEOgG7+tkFQP1Z/ecCCgZpALrwjwIICXED3ACf+dz7dftwA94EygJyA4r9a/2K/MoBVANKAJ7/JP3t/sD/",
  "FwIFATYAiP+2/bD/nP9OAlsBMgDh/xr+DgB3ADEBSQAhAIH/Ev+wAOn/wgBlAAIA9f+O/zQARAB+AAQAfQAgAPT/cQAEAGUA",
  "PQAKAMP//f/t/+D/OwC6/wcABQDb/xIAGgAkADoAHwDZ/zUA+v/3/zcAz//l////2//z/xkA4f/5/wIA3P8bAPf/7P8QAPz/",
  "9/8WAAkA/f8hAPH/9/8KAOX//P8EAOv///8EAOj/DwABAOz/CQDp/+v/EAD+/+3/CgD1//v/EwDt/wkACQDj/wcADQDu//7/",
  "/v/3/xAA/P/5/wMA6v/6/wYA9f8EAAgA8P8CAAEA7/8FAPX/7v8CAPP/9v8EAPb//P8FAPL//v8EAPP/AwAAAPP/AgD9//X/",
  "AwD8//f/BgD7//v/BgD6////BAD5////AgD4/wEAAQD5/wIA///6/wMA/f/7/wMA/P/8/wMA+//+/wIA+v///wAA+v8BAAAA",
  "+/8BAP///P8CAP3//f8BAP3//v8AAPz//v////3///////7////+//7////////////8//3///8AAAIAAgAIAEEAnABv/wH9",
  "XgGiBJn8nf75BKoCXQJv+936+gKd+un1HQOxApv29vmQ/8X+tgBs/xX+vwUhC04Eg/+fAh0BjQKxBr8CpAJH/477///m/5cC",
  "rQIFANAA3/+GAEUALQFOAAoAyv8m/fL+XP9TAE8AOf9a/+f+z//j/6YAw//m/zYAKf9ZAB0ANAAgAAEA7v/m/zwA0P9IANb/",
  "GwAxALL/EwACAAsAGQBWANv/8f8DAMv/NgD4//j/4v/S/9j/HAAMANj/DACY/9//FADv/wIA1P/K/97/9v/G/+3/5//r/y4A",
  "+f8HABIABgAlADIABQAWADAACAAsABcAAAAYAAkABQAVAAIA9f8RAO3//f8cAPT/EAAfAPr/DwARAOn/FwAEANH/DAD1/9T/",
  "BADp/9b/CgDm/+D/FADv//7/GAD1/wsAEgD6/xYAEgD3/xEAAgD3/xQA///+/xIA/f8AABEA+f8DAA8A9/8EAAUA9P8GAAMA",
  "9v8HAP7/9v8IAPv/+f8HAPn/+/8FAPf//v8EAPf/AQACAPj/AgAAAPn/BAD+//r/BAD8//z/BAD8//7/AwD7////AgD7/wEA",
  "AQD7/wIA///8/wMA///9/wIA/f/+/wMA/f8AAAEA/f8AAAAA/f8AAAAA//8AAAAA//8AAAAAAAD///3///8AAAAAAgD//wQA",
  "//8FAAcA+P8ZABQABwAF/w0A9gHW/93/TP/A/6f+W/3CBO8AbP5jAB0BnQOK+sQANgLY9vYAUAgUACb8/wGB+4/9iQag/nED",
  "KQKq+87+gQAjAiQARwH9/WX+JgFBAD8CSAA1AL3+l/9HAEEA6QHO/00A5v6T/0EAQwA2Aav/TwBb/wQAhwANADcAzv/v/2b/",
  "IADE/2IASwBX/9f/hP/6/wwAHwCN/8L/5/+j/2UAyf8eAFYANwBRAEkAJwABAFgA4f9MADYA3P82APr/CAAoADYA9v8oAP3/",
  "5/81AOD/DgALAO//DwAqAPf/+/8bAM7/HAAUAOn/CADx/+z/CQAIAOn/HADz//D/GADn//z/DADx//j/DwDo/wIADADl/w4A",
  "9//v/wsA9f/v/w0A+P/s/wwA7f/v//7/9v/4//P/+v/w//H/+f/2//f/BQD5//L/CQD2//v/CQDx//v/AgDz//3/AgDw////",
  "/v/w/wMA/P/3/wYA+//4/wUA+f/7/wcA9//+/wUA9/8BAAIA+P8CAAAA9/8DAP7/+f8EAPz/+/8DAPv//P8CAPn//v8BAPn/",
  "//8AAPn/AAD///r/AQD9//v/AQD9//3/AQD9//3/AQD8////AAD8/wAA///9/////v/+//////////////////7/+f/7////",
  "//8FAAgABwB5AA4BAf/V+iECtght+/L7WQNPCY4LJe8v85oELQBC/grwb/8e/ELraQUp+c3xGQieDBsYoRT3BxEDZwE+AxkC",
  "6gYuBsUBE/09+2n9Uv3rA9YBbv7+/Zf8FwBZ/lwBHQFE/hj+ovp4/Zb+l/6Y/uT9lv5v/uL/GwBCALL/8v+0/z//mgBbAJwA",
  "/P8jADkAKgDTAJAA4QAsAF0ATQAtAJIAZwCMAD8AgQANABAANgAOAEgA4v/n/9z/EAAIACoAIwDf/xcA2v8NAAEA9P8AABkA",
  "RwBLAH8ANABIADcAKgBbACUAFgAQACQAAwARAA0A+v8fAA8AIwAgABkAGgAaAAcACAAYAAAAIQAOAAcAIgAGAAYAGgAKABIA",
  "GQDr/xsAHADn/wsA/v/0//b/6P/j/9j/5v8EAAsAGgAjABAALAAkABcAMQAhABwAIgATAA4AFQAKAA8AFQAEAA8ACAABAA0A",
  "CAAFAAkAAAD8/wcA/f/9/wUA+P/+/wAA9///////9/8AAPz/9/8CAPv/+v8CAPr//P8BAPr//v8CAPr/AAABAPv/AQAAAPz/",
  "AwAAAP3/AwD///7/AwD+////AgD9/wAAAgD8/wEAAQD9/wEAAAD9/wIA///+/wIA//8AAAIAAAAAAAEAAAAAAAAAAAAAAAAA",
  "//////7/AAD//wEAAgACAEwAowBC/0L8sABABZ7/TABcAEcEoAQP8az1j/4/+z/+CAAuCgULXgafAlH8N/6zAQkDngG7AskA",
  "qf3Z/78AUAHNARQAMvuK+gv8IP0VALP/3f7F/Zj9of60/1YBMAGaAJ3/GgBqAQkCWwIRAmwBFwABAA4A/f8OAKv/fP8+/07/",
  "bv/Z//j/AADi/4v/w//M//T/GgAiAAsA/v/b/8n/DQDg//v/AwDp/wwACgAgACgAHgD3//r/6f/n/xQA7P/c/93/0P/a/+b/",
  "1v/m//D/3f8GAAYA/v8SAAQA/f/9//D/6v/1/+P/6//4/+X/9P/3/+3/+P/5//f/AQD4//X/AwD0//j/+v/p//L/9f/1//j/",
  "9f/3/wUABwDw//T//f/s/+//+v/0/wIACwD//wgA/v/3//7/8P/1//z/6//w//j/7v/9/wEA8P/9//v/7/8BAPv/8/8BAPf/",
  "9f8DAPj/+/8GAPf///8FAPn/BAAFAPz/BgADAPv/BwABAP3/CAD+//7/BQD8////BQD7/wAAAwD6/wEAAQD7/wIA///7/wIA",
  "/v/8/wMA/f/9/wIA/P///wIA/P8AAAEA/f8BAAAA/f8CAP///f8CAP7//v8BAP7//v8BAP3///8AAP7/AAAAAP7/AAD/////",
  "//////////8AAAAAAAAAAP//AAD+/wAA/f8BAAMA9/8QAA0A/v8u/w0AoAHg/8//Wf/L/xH/Ov1gA2cCWP72/ioCHQOb/LD+",
  "iP0T/rQD/wCzAncA/f22/tr/ZgIUAWYBkf70/vn/e//CAUwATACx/qD+gv8nAGcBCAC/AGj/Yf/F/63/qQD9/0EAVv8p/0f/",
  "8P8/AN7/NABp/wsA/f8OAFsAGgADAM7/PwDJ/yAA+P/c/0QA8P8pABUALwAbADsA7f/e/yAAwf8xABAA7f8DAPD/4v/3/wkA",
  "z/8XAM//0P/9/8n/+////+v/8f8hAPf/DQAQANr/GwABAPT/BADy/+b/CQAAAO//GADs/wcAGwD1/wQAAADs//7/CQDp/wsA",
  "/v/p/w0A9v/4/wgA9v/1/wsA9P/8/wkA5/8GAAUA8P8FAAMA9P8CAP7/8P8FAPX/9/8GAPb//P8AAPr/AQAHAPz/BAADAPj/",
  "BgD+//v/BAD7//v/AwD8//7/BgD8/wIABQD6/wMAAgD7/wMAAAD6/wIA/v/7/wMA/P/8/wIA+//+/wIA+////wEA+/8AAAAA",
  "+/8BAP///P8CAP7//f8CAP7//v8CAP7///8BAP3/AAABAP3/AQAAAP7/AQD///7/AQD///7/AQD+////AAD+////AAD+////",
  "AAD//wAA/////////////////////wAA//8BAP//BgA4AIIAb/8T/a0AswPw/kcBiQNtAA7/aPlI+V//tvpF9pQFCww8BnEF",
  "pP2W/lUDmAJKACL/8ALQ/r7/JwG4/ckA//+g/ksAdgDg/rz9lP3y/sb+kv6//9X99f7V/0UArQAiAD4BBgB1AK4AJwGEAekA",
  "9wCr/yIABQBkAIYALQANAHf/AQBZ/9j/x/97/6z/ev/d/5X/+f+r/+//6v++/zUAyP8IANb/9//1/wcAHgDz/y0A1v8cAPv/",
  "AwA7ABcABwDl/wcA0/8eAP//3v8CANH////7/wIA+/8WAPL//P8ZANz/GAD+/wMAGAAAAAMACgAPAPj/EwDw//z/DAD0/xAA",
  "BgD+/wMACwD0/wcABQDv/w0A/P/+/wMA9f/w/wAA8//k/wkA+f/6/w0A//8CABAAAgD7/woA9//+//7/7f/5//j/9//6//r/",
  "+f////r/9/////X/+f/9//X/+P/9//j//f////f/AAD9//n/AgD9//z/AgD9//3/AwD9/wAABQD//wMABAD+/wMAAwD+/wMA",
  "AQD9/wIA///9/wIA/v/+/wIA/f///wEA/f8AAAAA/f8AAAAA/f8BAP///v8BAP///v8BAP7///8BAP7///8AAP7/AAAAAP7/",
  "AAD///7/AAD/////AAD/////AAD/////AAAAAAAA/////////////////P8BAPz/AQD5/ygAcQCq/+z9ZP9RBCQAIvzSAsD/",
  "af4JBI/+zvrR/PABXgW//+H9YANrA2UBXwN+AG/+mgBK/2j/4QBZ/rL8xP1P/sv/hQDW/wv/hP74/nz/VwC0/4r/3v8y/5T/",
  "q/8TAPH/xf8QAK3/nv+H/7r/wv/g/6//sv/v/7T/NAD2/9//OQAtADIAHwA2ACMAQQAYAC4AVAAAACEAHAAIACQAPQAXABYA",
  "GgAAADQAFAAFACUAFwAcAEAAJwAJACcABwAhABsA5/8OAA4A//8aACMAEAAzAC0ADgAmAAUAAAAiAAkAAgAdAAUAAgALAO//",
  "AAAFAPL/BgAGAPD/BgAIAPH/DwAGAP3/GgAHAP7/EAAIAAUAEAAEAAgACQADAA0A///+/woABQAEAAYABwAKAAwADAAQAAgA",
  "DAAOAAUADwALAAEACAAEAP//CQACAP7/CAD//wEACQD+/wMACQD+/wMABwD9/wUABQD+/wcAAwD+/wYAAgD//wcAAAAAAAYA",
  "/v8BAAUA/v8CAAQA/v8DAAMA/v8DAAIA//8EAAEA//8EAAAAAAAEAP//AQADAP//AgADAP//AgACAAAAAwABAAAAAwABAAAA",
  "AgAAAAEAAgAAAAEAAQAAAAEAAQAAAAEAAQAAAAAAAAAAAAEAAAD//////v/9////+/////3/9f8CAB0AWQCV/5j+aP+1AwEC",
  "4PgJAZoG+fz8/an8ywDzA8r8cgD6Aa4CSf4t/SYFuP/f/eP/EAAnAln/rv4NAHn/4P4iALsAtf8O/7v+IP/EAFoBtP9V/yj/",
  "j/8kAGYArgDV/5v/9f6g/ygA/v87AIH/if9q//P/HwBCAFkAy/8oAMn/DgA1ABEACwDn/ysACQBHACMAWQB3AB8AIAD4/+T/",
  "7v9BAPn/6f/l/8X/DwDk/+v/6P/n/9H/8P8IAO3/KADx//P/CAD5/wMA8P/M/83//f/Y/wIACwDt/xkACgAOABoADwAAABMA",
  "BQAIACMA//8PAA8A/f8LAAYA8v/8//r/6v8IAPj/9v8IAPX//v8KAP//9v8KAAUAAgAKAP//AgAHAAMABQAVAAoABwAPAAYA",
  "DwAJAAkADwAIAAkACQAFAAcABgABAAYAAgAAAAQA//8CAAYAAQACAAQA//8BAAMA/v8DAAEA/v8DAAEA//8DAAEA//8DAP//",
  "AAADAP//AQADAP//AQACAP//AgABAP//AwABAP//AwABAAAABAAAAAEAAwAAAAEAAwAAAAIAAgAAAAIAAgAAAAIAAQAAAAIA",
  "AQAAAAIAAAABAAIAAAABAAEAAAABAAEAAAABAAEAAAABAAAAAAAAAAAAAAAAAAAA/////wIA+f8GAPj///8PANX/EwABATYA",
  "kfp4AX0IU/pF/84BX/p/BRoC4/4K/Aj+IQRz/lQEof7E/KL/WwAACkT/8voj/nj+MQMoApcAkP5U/0j+4P89AZr/DgDj/Wb+",
  "Vv5vAGAAqv/6ALb+HgCg/wYAlAAAALwAkP9HAAEARAA1AO3/JQDE/z8Axv9rAFMALAAiALL/DAAXAG8A7f/2/+3/4f/z/6H/",
  "CQD6/xAA8//l/9L/3P8WAOz/FgDt//D/5//n//b//v8TAOb/DADq/woAKwALABUADgAdAAwAGgDy//P/BAD1/xsA9v/t/wIA",
  "AAD5/wsAAQD5/xUA9v8CAAEA8P8AAPr/7//4//z/8P8JAPj/8P8KAPj/+f8HAAUA9v8JAAQA9/8NAAIA+f8EAAIA+v8IAP//",
  "/P8FAPT/AQAIAPv/+/////7/AgALAP7/BQAIAPv/BAAAAPf/AQD+//X////6//f/AwD6//r/AgD5//z/AgD5//7/AQD5////",
  "AAD4/wEAAAD7/wMA/v/8/wQA/v/+/wMA/f///wQA/P8AAAIA/P8BAAEA/f8CAAAA/f8CAP///f8CAP7///8BAP7///8BAP7/",
  "//8AAP3/AAAAAP7/AQD///7/AQD/////AQD/////AAD//wAAAAD//wAAAAAAAAAA////////AAAAAAAAAAABAP//AgAAAP7/",
  "AQA9AEcAXv8g/8L/NgGtAQD++QA9B0n85PW0BAkA1/LzAXoHHAHTBGwFkQRRAMn8xvx6ADwBoPxM/yf98P1gAYj/UQEqABQB",
  "7v92APIB7/5/AEj/z/9w/3L/MgE7/6AAof/T/4IABgByAJH/4P8r/zcAFAAkAM8A4f9zADUAhwAvAEwAEwDg/1gAkv9VABIA",
  "BwAkAOT/CADy/y4Ayf9CAOb/3/8pALj/DwDt/+7/2P8GANj/8/8kALn/GgDZ/9z/BQDe/9z/AAAfAAgAXgAhADMASQAKAC8A",
  "CQDs//P/EADm/wUABQDj/yUA9f/+/xEA8//1/wYA7f/o/wwA5v8IAAYA8P8UAAMAAAAOAAAA9f8TAPL/9v8dAO//+f8SAPP/",
  "5/8DAPT/8f8IAPP/AgAGAPf/AAAEAPj///8CAPL/AgD7//b/AwD5//z/AQD7//z/BAD3////AwD1/wMA///4/wMA/v/4/wMA",
  "/f/4/wUA+f/6/wQA+P/9/wMA+P/+/wMA+P8BAAEA+P8CAP//+v8DAP7/+/8DAP3//f8DAPz//v8DAPz/AAABAPv/AQAAAPv/",
  "AQD///z/AQD+//3/AQD9//3/AQD8//7/AAD8///////9/wAA///+/wAA//////////////////8=",
].join("");

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Base64 → bytes. Hand-rolled because `atob` is a window/worker global that
 * AudioWorkletGlobalScope does not carry, and this module runs there.
 */
function b64Bytes(s) {
  const lut = new Int32Array(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i++) lut[B64_ALPHABET.charCodeAt(i)] = i;
  let len = s.length;
  while (len > 0 && s.charCodeAt(len - 1) === 61) len--; // '='
  const out = new Uint8Array((len * 3) >> 2);
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 6) | lut[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  return out;
}

/**
 * The set as one channel-major Float64Array of HRIR_CHANNELS × HRIR_LENGTH,
 * scaled to ±1. Built once per call — binaural.js caches the rate-converted
 * table it derives from this.
 */
export function decodeShHrir() {
  const bytes = b64Bytes(HRIR_BASE64);
  const out = new Float64Array(HRIR_CHANNELS * HRIR_LENGTH);
  for (let i = 0; i < out.length; i++) {
    const lo = bytes[i * 2];
    const hi = bytes[i * 2 + 1];
    const v = (hi << 8) | lo;
    out[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768.0;
  }
  return out;
}
