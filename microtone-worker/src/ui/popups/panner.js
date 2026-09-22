// Spatial panner (#998.6) — the visualiser/editor for surround and spatial
// songs. Two dials: a TOP view (azimuth, the full circle) and, for a spatial
// song, a SIDE view (elevation in the vertical plane through that azimuth).
//
// It does two jobs at once:
//   * watch — every sounding lane is drawn where the engine actually has it
//     (snapshot fields SNAP_V_AZIMUTH / SNAP_V_ELEVATION), so a Z slide is
//     visible while it runs;
//   * write — drag the handle and the buttons put the exact command into the
//     cursor's cell: X (place), 4 (slide target) or Z (start the slide).
//
// The angle ↔ argument codec lives in the engine (spatial.js), the same one the
// effects read, so what you drag and what plays can never disagree.

import {
  AZIMUTH_TURN, ELEVATION_QUARTER, SURROUND_SPATIAL,
  wrapAzimuth, anglesFromSpatialArg, spatialArgFromAngles,
} from "../../engine/spatial.js";
import { EffectOp } from "../../engine/tables.js";
import { themeColors } from "../theme.js";
import { paintSpatialDot } from "../spatialdot.js";
import { azimuthLabel, elevationLabel } from "../units.js";
import { t } from "../i18n.js";
import { localPoint } from "../zoom.js";

const DIAL = 210;        // dial canvas size (CSS px)
const MAX_VOICES = 64;

// ── pure geometry (unit-tested in test/node/panner.test.js) ───────────────
// Screen convention, top view: front is UP, right is RIGHT, so the azimuth
// grows clockwise on screen exactly as it does around the listener.

/** Canvas offset (dx, dy) from the dial centre → azimuth units. */
export function pointerAzimuth(dx, dy) {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return wrapAzimuth(128 + (deg * AZIMUTH_TURN) / 360);
}

/** Azimuth units → unit offset [x, y] from the dial centre. */
export function azimuthOffset(az, out) {
  const rad = ((az - 128) * 2 * Math.PI) / AZIMUTH_TURN;
  out[0] = Math.sin(rad);
  out[1] = -Math.cos(rad);
  return out;
}

/** Side dial: (dx, dy) → elevation units. The dial is a half-circle facing the
 *  current azimuth, so the left half mirrors onto the right rather than
 *  flipping the source round to the back. */
export function pointerElevation(dx, dy) {
  const deg = (Math.atan2(-dy, Math.abs(dx)) * 180) / Math.PI;
  const el = (deg * ELEVATION_QUARTER) / 90;
  return el < -ELEVATION_QUARTER ? -ELEVATION_QUARTER
    : el > ELEVATION_QUARTER - 1 ? ELEVATION_QUARTER - 1 : el;
}

/** Elevation units → unit offset [x, y] on the side dial. */
export function elevationOffset(el, out) {
  const rad = (el * Math.PI) / (2 * ELEVATION_QUARTER);
  out[0] = Math.cos(rad);
  out[1] = -Math.sin(rad);
  return out;
}

// (azimuthLabel / elevationLabel live in ../units.js — the Instruments view's
// default-position fields name the same directions.)

// ── the popup ────────────────────────────────────────────────────────────

/**
 * @param store  UI store (doc, audio, songIndex)
 * @param target {channel, rowLabel, cell, apply(fields)} | null — the cursor's
 *               cell; null when no grid view is focused (watch-only mode).
 */
export function showPanner(store, target) {
  return new Promise((resolve) => {
    const song = store.doc?.songs[store.songIndex];
    const spatial = (song?.surroundModel ?? 0) === SURROUND_SPATIAL;
    const scratch = new Float64Array(2);
    const off = new Float64Array(2);

    // Handle position: picked up from the cell's own X / 4 when it has one.
    let az = 128;
    let el = 0;
    let zSpeed = 0x040;
    const cell = target?.cell ?? null;
    if (cell && (cell.effect === EffectOp.OP_X || cell.effect === EffectOp.OP_4)) {
      anglesFromSpatialArg(cell.effectArg, scratch);
      az = scratch[0];
      el = spatial ? scratch[1] : 0;
    } else if (cell && store.doc?.wideCells && cell.panEff === 0 &&
               (cell.azimuth !== 0 || cell.elevation !== 0)) {
      // A wide cell can carry the position in its panning COLUMN — pick the
      // handle up from there too, so reopening the dialog shows where the
      // source already is however it was written.
      az = cell.azimuth;
      el = spatial ? cell.elevation : 0;
    } else if (cell && cell.effect === EffectOp.OP_Z && (cell.effectArg & 0xfff) !== 0) {
      zSpeed = cell.effectArg & 0xfff;
    }

    const dlg = document.createElement("dialog");
    dlg.className = "modal panner";
    const h = document.createElement("h3");
    h.textContent = t("panner.title");
    const info = document.createElement("p");
    info.className = "dim";

    const dials = document.createElement("div");
    dials.className = "panner-dials";
    const topCv = document.createElement("canvas");
    const sideCv = document.createElement("canvas");
    for (const cv of [topCv, sideCv]) {
      cv.width = DIAL;
      cv.height = DIAL;
      cv.style.width = `${DIAL}px`;
      cv.style.height = `${DIAL}px`;
      cv.className = "panner-dial";
    }
    dials.append(topCv);
    if (spatial) dials.append(sideCv);

    // ── numeric fields ──
    const fields = document.createElement("div");
    fields.className = "panner-fields";
    const mkNum = (labelKey, value, min, max, onInput) => {
      const lab = document.createElement("label");
      lab.className = "modal-field";
      lab.append(t(labelKey) + " ");
      const inp = document.createElement("input");
      inp.type = "number";
      inp.min = min;
      inp.max = max;
      inp.step = 1;
      inp.value = Math.round(value);
      inp.addEventListener("input", () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) { onInput(v); refresh(false); }
      });
      lab.appendChild(inp);
      const read = document.createElement("span");
      read.className = "dim panner-read";
      lab.appendChild(read);
      fields.appendChild(lab);
      return { inp, read };
    };
    const azField = mkNum("panner.azimuth", az, 0, AZIMUTH_TURN - 1, (v) => { az = wrapAzimuth(v); });
    const elField = spatial
      ? mkNum("panner.elevation", el, -ELEVATION_QUARTER, ELEVATION_QUARTER - 1,
        (v) => { el = Math.max(-ELEVATION_QUARTER, Math.min(ELEVATION_QUARTER - 1, v)); })
      : null;

    // ── command buttons ──
    const cmds = document.createElement("div");
    cmds.className = "panner-cmds";
    const mkBtn = (labelKey, titleKey, onClick) => {
      const b = document.createElement("button");
      b.textContent = t(labelKey);
      b.title = t(titleKey);
      b.disabled = target === null;
      b.addEventListener("click", (e) => { e.preventDefault(); onClick(); refresh(false); });
      cmds.appendChild(b);
      return b;
    };

    // Format v3 (§5.5) gives the panning COLUMN the same reach as effect X — a
    // 9-bit azimuth and a signed elevation — so a wide project can place the
    // source without spending its effect slot at all. The button only exists
    // where the column can hold a position.
    const columnBtn = store.doc?.wideCells
      ? mkBtn("panner.column", "panner.columnTitle", () => {
        if (!target) return;
        target.apply({
          azimuth: Math.round(wrapAzimuth(az)) & 0x1ff,
          elevation: spatial ? Math.max(-128, Math.min(127, Math.round(el))) : 0,
          panEff: 0, // SET
        });
      })
      : null;
    const placeBtn = mkBtn("panner.place", "panner.placeTitle",
      () => write(EffectOp.OP_X, spatialArgFromAngles(az, spatial ? el : 0)));
    const targetBtn = mkBtn("panner.target", "panner.targetTitle",
      () => write(EffectOp.OP_4, spatialArgFromAngles(az, spatial ? el : 0)));

    const zLab = document.createElement("label");
    zLab.className = "modal-field";
    zLab.append(t("panner.speed") + " ");
    const zInp = document.createElement("input");
    zInp.type = "text";
    zInp.size = 4;
    zInp.value = zSpeed.toString(16).toUpperCase().padStart(3, "0");
    zInp.addEventListener("input", () => {
      const v = parseInt(zInp.value, 16);
      zSpeed = Number.isFinite(v) ? Math.max(0, Math.min(0xfff, v)) : 0;
      refresh(false);
    });
    zLab.appendChild(zInp);
    cmds.appendChild(zLab);
    const slideBtn = mkBtn("panner.slide", "panner.slideTitle",
      () => write(EffectOp.OP_Z, zSpeed & 0xfff));

    // ── view options (#998.8) ──
    // A busy song puts a dot on every sounding lane, which is the point when
    // you are watching and in the way when you are placing one source. The
    // choice is remembered for the session, like the other view toggles.
    const viewOpts = document.createElement("div");
    viewOpts.className = "panner-opts";
    const onlyLab = document.createElement("label");
    const onlyBox = document.createElement("input");
    onlyBox.type = "checkbox";
    onlyBox.checked = store.pannerOwnOnly === true;
    onlyBox.disabled = target === null; // nothing to single out in watch-only mode
    onlyBox.addEventListener("change", () => {
      store.pannerOwnOnly = onlyBox.checked;
      refresh(false);
    });
    onlyLab.append(onlyBox, t("panner.onlyThis"));
    onlyLab.title = t("panner.onlyThisTitle");
    viewOpts.appendChild(onlyLab);

    const btnRow = document.createElement("div");
    btnRow.className = "modal-buttons";
    const closeBtn = document.createElement("button");
    closeBtn.textContent = t("common.close");
    btnRow.appendChild(closeBtn);

    dlg.append(h, info, dials, fields, cmds, viewOpts, btnRow);
    document.body.appendChild(dlg);

    function write(effect, effectArg) {
      if (!target) return;
      target.apply({ effect, effectArg });
    }

    // ── painting ──
    function paintTop(cv) {
      const ctx = cv.getContext("2d");
      const c = themeColors();
      const r = DIAL / 2 - 22;
      const cx = DIAL / 2;
      const cy = DIAL / 2;
      ctx.clearRect(0, 0, DIAL, DIAL);
      ctx.fillStyle = c.cvBg;
      ctx.fillRect(0, 0, DIAL, DIAL);

      // rings + cardinal ticks
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 1;
      for (const f of [1, 0.66, 0.33]) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * f, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();
      // Cardinal labels are anchored to the CANVAS edges, not to the ring, so
      // no translation can push one off the side.
      ctx.fillStyle = c.dim;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(t("dir.front"), cx, 2);
      ctx.textBaseline = "bottom";
      ctx.fillText(t("dir.back"), cx, DIAL - 2);
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      ctx.fillText(t("dir.left"), 2, cy);
      ctx.textAlign = "right";
      ctx.fillText(t("dir.right"), DIAL - 2, cy);
      ctx.textAlign = "center";
      // The listener.
      ctx.fillStyle = c.fg2;
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();

      paintLiveVoices(ctx, cx, cy, r, (a, e, o) => {
        azimuthOffset(a, o);
        // Height shrinks the radius, so an overhead source sits at the centre —
        // the same collapse the stereo downmix does.
        const k = Math.cos((e * Math.PI) / (2 * ELEVATION_QUARTER));
        o[0] *= k; o[1] *= k;
      });

      // the handle
      azimuthOffset(az, off);
      const k = Math.cos((el * Math.PI) / (2 * ELEVATION_QUARTER));
      const hx = cx + off[0] * r * k;
      const hy = cy + off[1] * r * k;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      if (spatial) {
        paintSpatialDot(ctx, hx, hy, el, r, 7, c.accent);
      } else {
        ctx.fillStyle = c.accent;
        ctx.beginPath();
        ctx.arc(hx, hy, 7, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function paintSide(cv) {
      const ctx = cv.getContext("2d");
      const c = themeColors();
      const r = DIAL / 2 - 22;
      const cx = DIAL / 2 - r / 2;
      const cy = DIAL / 2;
      ctx.clearRect(0, 0, DIAL, DIAL);
      ctx.fillStyle = c.cvBg;
      ctx.fillRect(0, 0, DIAL, DIAL);
      ctx.strokeStyle = c.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.moveTo(cx, cy); ctx.lineTo(cx + r, cy);
      ctx.stroke();
      ctx.fillStyle = c.dim;
      ctx.font = "11px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(t("panner.up"), cx + 6, 2);
      ctx.textBaseline = "bottom";
      ctx.fillText(t("panner.down"), cx + 6, DIAL - 2);
      ctx.textBaseline = "bottom";
      ctx.textAlign = "right";
      ctx.fillText(t("panner.ear"), DIAL - 2, cy - 3);
      ctx.textAlign = "left";

      elevationOffset(el, off);
      const hx = cx + off[0] * r;
      const hy = cy + off[1] * r;
      ctx.strokeStyle = c.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = c.accent;
      ctx.beginPath();
      ctx.arc(hx, hy, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    /** Dots for every sounding lane, from the engine's own snapshot. `r` is
     *  the dial radius — the height cue's shadow is measured in those units. */
    function paintLiveVoices(ctx, cx, cy, r, place) {
      const audio = store.audio;
      if (!audio) return;
      const c = themeColors();
      const chans = store.doc?.channelCount ?? 32;
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const ownOnly = store.pannerOwnOnly === true && target !== null;
      for (let ch = 0; ch < Math.min(chans, MAX_VOICES); ch++) {
        if (ownOnly && ch !== target.channel) continue;
        if (!audio.getVoiceActive(ch)) continue;
        const vol = audio.getVoiceEffectiveVolume(ch);
        if (vol <= 0.002) continue;
        place(audio.getVoiceAzimuth(ch), audio.getVoiceElevation(ch), off);
        const x = cx + off[0] * r;
        const y = cy + off[1] * r;
        const isCursor = target !== null && ch === target.channel;
        const fill = isCursor ? c.accent2 : c.live;
        const dotR = 4 + 5 * Math.min(vol * 2, 1);
        ctx.globalAlpha = 0.35 + 0.65 * Math.min(vol * 2, 1);
        if (spatial) {
          paintSpatialDot(ctx, x, y, audio.getVoiceElevation(ch), r, dotR, fill);
        } else {
          ctx.fillStyle = fill;
          ctx.beginPath();
          ctx.arc(x, y, dotR, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.fg;
        ctx.fillText(String(ch + 1), x, y - 15);
      }
    }

    // ── interaction ──
    const drag = (cv, onMove) => {
      const move = (e) => {
        const p = localPoint(cv, e);
        onMove(p.x - DIAL / 2, p.y - DIAL / 2);
        refresh(false);
      };
      cv.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
        move(e);
        const up = () => {
          cv.removeEventListener("pointermove", move);
          cv.removeEventListener("pointerup", up);
        };
        cv.addEventListener("pointermove", move);
        cv.addEventListener("pointerup", up);
      });
    };
    drag(topCv, (dx, dy) => { az = pointerAzimuth(dx, dy); });
    if (spatial) {
      drag(sideCv, (dx, dy) => { el = pointerElevation(dx, dy - 0); });
    }

    /** Repaint; `live` = a frame of the animation loop (leaves fields alone
     *  while they are being typed into). */
    function refresh(live) {
      paintTop(topCv);
      if (spatial) paintSide(sideCv);
      if (!live || document.activeElement !== azField.inp) {
        azField.inp.value = String(Math.round(az));
      }
      azField.read.textContent = azimuthLabel(az);
      if (elField) {
        if (!live || document.activeElement !== elField.inp) {
          elField.inp.value = String(Math.round(el));
        }
        elField.read.textContent = elevationLabel(el);
      }
      const arg = spatialArgFromAngles(az, spatial ? el : 0);
      const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, "0");
      placeBtn.textContent = `${t("panner.place")}  X $${hex(arg, 4)}`;
      targetBtn.textContent = `${t("panner.target")}  4 $${hex(arg, 4)}`;
      slideBtn.textContent = `${t("panner.slide")}  Z $${hex(zSpeed & 0xfff, 4)}`;
      if (columnBtn) {
        const azi = Math.round(wrapAzimuth(az)) & 0x1ff;
        const elv = (spatial ? Math.max(-128, Math.min(127, Math.round(el))) : 0) & 0xff;
        columnBtn.textContent = `${t("panner.column")}  ${hex(elv, 2)} ${hex(azi, 3)}`;
      }
      info.textContent = target
        ? t("panner.writesTo", { ch: target.channel + 1, row: target.rowLabel })
        : t("panner.watchOnly");
    }

    let raf = 0;
    const tick = () => {
      refresh(true);
      raf = requestAnimationFrame(tick);
    };

    const finish = () => {
      cancelAnimationFrame(raf);
      dlg.close();
      dlg.remove();
      resolve();
    };
    closeBtn.addEventListener("click", (e) => { e.preventDefault(); finish(); });
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); finish(); });
    // Keep the grid's key handling out of the dialog (as every other popup does).
    dlg.addEventListener("keydown", (e) => e.stopPropagation());

    dlg.showModal();
    refresh(false);
    raf = requestAnimationFrame(tick);
    dlg.__panner = { // test hook: the smoke drives these instead of real drags
      setAngles: (a, e) => { az = wrapAzimuth(a); el = e; refresh(false); },
      onlyThis: (on) => { onlyBox.checked = on; onlyBox.dispatchEvent(new Event("change")); },
      place: () => placeBtn.click(),
      target: () => targetBtn.click(),
      slide: () => slideBtn.click(),
      close: finish,
    };
  });
}
