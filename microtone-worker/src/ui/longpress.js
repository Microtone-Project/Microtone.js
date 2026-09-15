// Long-press → context menu, for the three tracker grids (item 190.1).
//
// A touch screen has no second mouse button, so every menu in the grids would
// otherwise be unreachable on a tablet. The \ key opens the same menu from the
// keyboard (item 190); this is the other half — press and hold, and the menu
// opens where your finger is.
//
// It is deliberately NOT a mouse gesture. With a mouse the second button is
// right there, and turning a held click into a menu would fight the drag that
// starts a block selection. So the press is armed only for touch and pen, which
// is also why the drag it might turn into is allowed to start normally: moving
// more than a finger's slop cancels the press and the drag simply continues.
//
// THE GAUGE is the other half of the bargain. A hold that gives no sign it has
// started is a hold you abandon too early, so the press draws a ring around the
// target it would act on — the selection when the finger came down inside one,
// otherwise the single cell under it — travelling once round the perimeter over
// the hold. That makes the wait legible AND shows what the menu will be about
// before it opens, which the right-click menu never had to say out loud.

/** How long a press has to be held, in ms. Long enough not to fire on a tap
 *  that drifts, short enough that nobody lets go first — the same ballpark as
 *  the platform's own press-and-hold. */
export const LONGPRESS_MS = 500;

/** Slop, in CSS px. A finger never holds perfectly still; past this the press
 *  was a drag all along. */
export const LONGPRESS_SLOP = 10;

/**
 * Pointer types the gesture is armed for: a finger and a pen, and nothing else.
 *
 * Named positively rather than as "anything but a mouse". A PointerEvent that
 * was not made by a real pointing device reports its type as the EMPTY STRING —
 * synthetic events, and some assistive tech — and "not a mouse" arms the
 * gesture for every one of those, which is how a scripted click ends up holding
 * a menu open.
 */
export const longPressable = (e) => e?.pointerType === "touch" || e?.pointerType === "pen";

/**
 * A press in flight. One per grid; `start` replaces any previous one, so a
 * second finger cannot leave a timer running behind the first.
 *
 * `onFire(press)` is called once, with the press, when the hold completes.
 * `onPaint()` is called when the ring needs redrawing — the view's invalidate.
 */
export class LongPress {
  constructor({ onFire, onPaint, now = () => Date.now() }) {
    this.onFire = onFire;
    this.onPaint = onPaint;
    this.now = now;
    /** {pointerId, x, y, clientX, clientY, t0, rect} while a press is in
     *  flight, else null. `rect` is what the gauge is drawn around, in canvas
     *  coordinates — null draws no ring, which is what a press on empty space
     *  gets. */
    this.press = null;
    this._timer = null;
  }

  /** Arm a press at canvas (x, y). `rect` is the gauge's target. */
  start(e, x, y, rect = null) {
    this.cancel();
    this.press = {
      pointerId: e.pointerId, x, y,
      clientX: e.clientX, clientY: e.clientY,
      t0: this.now(), rect,
    };
    this._timer = setTimeout(() => {
      const press = this.press;
      // Clear FIRST: the menu is modal and awaits, and a press left in flight
      // would go on painting its ring underneath it for as long as it is open.
      this.press = null;
      this._timer = null;
      this.onPaint?.();
      if (press) this.onFire(press);
    }, LONGPRESS_MS);
  }

  /** Feed a pointermove. Returns true when the move cancelled the press. */
  moved(e, x, y) {
    const p = this.press;
    if (!p || e.pointerId !== p.pointerId) return false;
    if (Math.abs(x - p.x) <= LONGPRESS_SLOP && Math.abs(y - p.y) <= LONGPRESS_SLOP) return false;
    this.cancel();
    return true;
  }

  /** Lift, cancel, or anything else that ends the gesture early. */
  cancel() {
    if (this._timer !== null) { clearTimeout(this._timer); this._timer = null; }
    if (this.press !== null) { this.press = null; this.onPaint?.(); }
  }

  /** 0…1 through the hold, or 0 when nothing is in flight. */
  progress() {
    if (!this.press) return 0;
    const p = (this.now() - this.press.t0) / LONGPRESS_MS;
    return p < 0 ? 0 : p > 1 ? 1 : p;
  }

  /** Is a press in flight? The grids' frame() asks, to keep repainting. */
  get active() { return this.press !== null; }
}

/**
 * Draw the gauge: a ring round `rect` filled in clockwise from its top-left
 * corner, `progress` of the way round.
 *
 * A dashed stroke on a rectangle whose dash is the drawn length and whose gap
 * is the whole perimeter gives exactly one travelling arc, with no arithmetic
 * per corner — the corners come free from the path. The faint full outline
 * underneath is what makes a quarter-filled ring read as "a quarter of the way"
 * rather than as a stray mark in the corner.
 */
export function paintPerimeterGauge(ctx, rect, progress, colour, dim) {
  if (!rect || progress <= 0) return;
  const { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) return;
  const perimeter = 2 * (w + h);
  ctx.save();
  ctx.lineWidth = 2;
  ctx.lineCap = "butt";
  ctx.setLineDash([]);
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = dim ?? colour;
  ctx.strokeRect(x, y, w, h);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colour;
  ctx.setLineDash([perimeter * progress, perimeter]);
  ctx.strokeRect(x, y, w, h);
  ctx.restore();
}
