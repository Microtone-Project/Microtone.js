# Microtone design system

Microtone is a music tracker for the notes a piano cannot play, and Microtone Touch is its pocket sketchpad. Their interface is a working instrument panel: dense, flat, hairline-ruled, lit by a few saturated inks that each mean one thing. Build anything new for them so that it looks like the tracker, never like a landing page.

This directory is the system's home. Start here, whether you are a person or a program.

| What | Where | For |
|---|---|---|
| This guide | `README.md` | the rules and the reasons |
| Interactive docs | `docs/index.html` | every token, face, rule and component, live, in every theme |
| Tokens | `tokens.json` | every colour (per theme), contrast pair, face, text style, radius and weight — GENERATED |
| Token notes | `notes.json` | the curated half of `tokens.json`: what each token is for, the text styles |
| Components and rules | `components.json` | the component library and the rules, machine-readable |
| Component library | `components/` → `microtone-worker/src/ui/components/` | the reusable components themselves |
| Typefaces | `fonts/` | Motif, built from Chivo Mono (its own README) |

The stylesheet `microtone-worker/css/microtone.css` is the source of truth for every value; `tokens.json` is copied out of it by `node tools/design-tokens.js` (from the repo root) and pinned to it by `microtone-worker/test/node/design-system.test.js`.

## Viewing the docs

Published at [microtone.cc/design-system](https://microtone.cc/design-system/): the deploy lays the page and its four data files (`README.md`, `tokens.json`, `components.json`, `notes.json`) in beside the tracker, with their paths rewritten for the site's layout (`tools/stage-site.js`, `--design-system`). Edit the sources under `design-system/`, never the staged copy.

Locally, serve the REPO ROOT and open `design-system/docs/`:

```sh
python3 microtone-worker/tools/test-server.py     # from the repo root; port 8932
# → http://localhost:8932/design-system/docs/
```

The page loads the app's own stylesheet and imports the real components, so what it shows is what the app draws. It does not work from `file://` (ES modules, `fetch`).

## Rules

### Dialog actions: Cancel left, Proceed right

Every dialog's button row is built by `actionRow()` (`components/actions.js`); nothing else makes a `.modal-buttons` row or a Cancel button.

```
[Cancel]                                   [alternative …] [Proceed]
```

- **Cancel** abandons the dialog: nothing it was about to do happens. Always the **left end**, so it is in the same place every time. Esc does the same.
- **Proceed** does what the dialog is for — Apply, Create, Import, Delete, Save. Always the **right end**. At most one. Enter does the same where the dialog has typed fields.
- **Alternatives** are other actions that do not cancel — Preview, Record, Import as new, Clear. They are **prepended to Proceed**: immediately left of it, in the order given.
- **Dismiss**: a dialog with nothing to commit and nothing to abandon — About, a notice, a finished log, a panel whose edits apply live — has **one** button, at the right end, and neither Cancel nor Proceed. Use `showNotice()` for a message someone only has to read; never a Cancel/OK pair where both do the same thing.
- Something that is not a button but belongs with the actions — a status line, an option that changes what Proceed does — goes in `extras`, just before the alternatives.
- The DOM order is the visual order and the Tab order. Never reorder with CSS.

The one exception is the Analogue Warmth Edition's splash, a parody advert with its own centred button.

Microtone Touch follows the same order in its sheets by hand: `<div class="row actions">`, the Cancel first with `.cancel`, the primary last.

### Proceed is the one coloured, heavier button

The Proceed button (`button.proceed`; Touch's `.tbtn.primary`) is filled with the theme's accent — `proceed-bg` behind `proceed-fg` — because the accent already means "this one", and its label is set at `weight-proceed`, **at least 200 heavier** than `weight-button`, the weight of every other button. Nothing else is filled with the accent or bold for emphasis; the armed Record toggle wears its own red, and a flip switch's track fills with the accent while it is ON, because those are states, not actions.

### Every colour is a token

Every colour, DOM and canvas alike, is a custom property on `:root` in `microtone.css`, declared once per theme. Canvas views read them through `src/ui/theme.js`. Never hard-code a colour in a view, a popup or an inline style: reuse a token, or add one — in all four themes, with a note in `notes.json` (or a trailing comment beside it in the CSS) — and run `node tools/design-tokens.js`.

Native checkboxes, radios, sliders and progress bars are themed once, by `:root { accent-color: var(--accent) }`. Never restate `accent-color` on a widget; a control that cannot be native — a canvas fader, a flip switch — paints itself from `var(--accent)`.

### One meaning per hue

- `accent` (amber; burnt orange on light grounds) — focus, hover, "this one is active", and Proceed.
- `accent-2` (cyan) — instruments, links, selection.
- `meter` (green) — level and liveness.
- `rec-fg` — record armed.

Don't borrow one for decoration. Colours that must be told apart differ in lightness, not in hue alone.

### Panels fold to their titlebar

A panel built as a titlebar over a body — a rack unit, an inspector section — folds with `makeFoldable()` (`components/fold.js`), never with a hand-made toggle. A caret twisty sits at the left end of the titlebar, pointing down while open and right while shut, and the panel's name beside it toggles too (the twisty alone is in the Tab order). Only the body folds: the titlebar's own switch, Mix slider or readout keeps working while the panel is shut. Folding is never an undo step. Where it is kept depends on what the panel shows: when that is saved in the project and the format has a place for the fold — a mixing chain's equipment has a *folded* flag beside its bypass — it is saved there (pass `get`/`set`), so the file reopens as it was left and everyone on that chain sees it alike; otherwise it is the viewer's, in `localStorage` per kind of panel (pass `key`). A panel nobody has touched takes its caller's default: open what is in use, shut what is not.

### Few choices are pushbuttons, not dropdowns

A choice among two to about six named options that someone flips while listening — Cut or Boost, Pre or Post, which band to edit — is a **segmented row of pushbuttons** (`.mst-seg`, the chosen one `.active`), not a dropdown: every option stays in sight and one press changes it. An on/off of a part is a **toggle pushbutton** (`button.toggle` with `aria-pressed`), which wears the same lit look while it is in. When each button of a row picks an item that has its own on/off — a band of a compressor or a dynamic EQ — each carries a **lamp** (`.seg-lamp`, green when that item is on), so what you are editing and what is sounding read at once; the lamp pushbutton beside the row switches the item selected.

### On the instrument panels, an on/off is a lamp pushbutton or a flip switch

A checkbox is too small a target for something pressed while listening, on a touchscreen as often as with a mouse, so the instrument panels — Mixing, Mastering, the instrument editor, the keymap, the chord and notation makers, the panner, the sample editor, the top bar's Follow — have none.

- An **option** — Sync, True peak, an envelope's Loop, a chain's On, one note of a chord — is a **lamp pushbutton** (`lampButton()`, `components/lampbutton.js`). The whole button is the target; the lamp at its left (`.seg-lamp`, lit in `meter` green, a trough while off) says whether it is on, and the label stays the option's name. Where the row already names the option, the button says its state instead: *On* / *Off*.
- Putting a **piece of equipment**, or one band of it, **in circuit or bypassing it** is a **flip switch** (`flipSwitch()`, `components/flipswitch.js`), at the right end of the piece's titlebar, opposite the fold twisty. ON parks the knob at the right and fills the track with `accent`; OFF parks it at the left in `dim` ink and fills nothing. It is a button with `role="switch"`, so Tab, Space and Enter work it, and it stays live while the piece is folded.

Both keep their state with the caller: `setOn()` shows a state without reporting it (a view's refresh after an undo), a press flips it and reports the new one through `onChange`, and neither writes the DOM unless the state moved. Dialog forms keep their native checkboxes (`showModal`'s checkbox field, an import list): a form is filled in once and committed, not played.

### Write the DOM only on change

The frame loop visits every open view 60 times a second. Compare before writing `textContent`, never read layout after a write in the same frame, and repaint a canvas when what it shows changes, not on a schedule.

## Visual foundations

### Themes

Four themes, switched by `data-theme` on `<html>` and cycled by the theme button in order of ground lightness: **dark → dim → light**. `dim` is the one the app boots into; `dark` is what `:root` declares. `warmth` (the Analogue Warmth Edition) joins the cycle only while it is in season and is never saved. `dark` and `dim` put light ink on dark grounds; `light` and `warmth` reverse the ramp, so their accents are darker re-mixes.

### Colour

- **Grounds:** `bg` under the views, `panel` for every bar, menu and modal, `panel-2` for a raised control on a panel. Rule them apart with `border` hairlines, never with shadows.
- **Ink:** `fg` for primary text, `dim` for secondary text and empty cells, `fg2` for key-offs.
- **Status pairs:** `ok-fg` on `ok-bg`, `err-fg` on `err-bg`, `rec-fg` on `rec-bg` with `rec-border`.
- **Canvas inks** (`cv-*`) belong to the pattern grids, waveforms, envelopes and memory views. The register ramp (`cv-oct-red` → `cv-oct-blue`) is ordered by hue alone and only ever paints a 2 px stripe.
- **Contrast:** `fg` clears 7:1 on every ground in every theme. `dim` misses 4.5:1 on `panel-2`, so keep dim text to `bg` and `panel`; `border` is a hairline under 3:1, so carry every state with `accent`, not with `border`. `tokens.json` → `contrast` has the ratios for every theme.

### Type

- **Open Sans** sets all chrome, narrowed (`"wdth" 86.67`) with tabular figures so numbers never jitter; compact strips (status bar, palette, hints) open it to `"wdth" 96`.
- **Geist** 900 oblique is for the wordmark only.
- **Motif** (`fonts/`) is every monospace, always through its token, never by name:
  - `--cv-font` **Motif Grid** — the grids, the chord and notation makers, the keymap, and every note written as a symbol (`noteGlyph()`).
  - `--mono-font` **Motif Mono** — what someone types or reads as a value: hex and number fields, indexes, readouts, key names, canvas labels.
  - `--transport-font` **Motif Transport** — the transport readouts, 10% narrower.
  - `--code-font` **Motif Code** — the Motif editor and the manual's code.
- Sizes are rem-based and small: buttons 0.95rem, compact strips 0.85rem, hints 0.82rem, tabs and labels 0.8rem, menu captions 0.72rem.

### Shape, space and depth

- `radius-sm` (4px) for inputs and badges, `radius-md` (6px) for buttons, value controls and menu cells, `radius-lg` (8px) for modals, menus and canvas frames. Tabs round only their top corners.
- Spacing is in rem and tight: bars pad 0.4rem × 0.8rem, buttons 0.2rem × 0.6rem, modals 1rem × 1.4rem, an action row's buttons sit 0.5rem apart.
- Depth is almost absent: a faint halo on buttons, a shadow on the floating context menu, `scrim` behind a modal.
- Every viewport-unit length is divided by the UI zoom: `calc(100vh / var(--ui-zoom, 1))`.

### States and motion

- **Hover** turns a control's border to `accent`; Proceed's fill steps to `proceed-hover`.
- **Active/selected** sets text and border to `accent`, or, for a tab, fills it with `bg`.
- **Disabled** fades to 0.35–0.5.
- **Focus** in a value control lights the group's border; a menu shows exactly one highlighted cell, never a separate hover and focus.
- Motion is brief and functional, and stops under `prefers-reduced-motion`.

## Iconography

- **Button icons** (`BTN_ICON` in `src/ui/icons.js`) are inline SVG on a 24×24 grid in `currentColor`: solid fills for transport, 2px round-capped strokes for everything else. They sit at 1em with `.btn-ico`, before the label (`btn-ico after` for a trailing arrow). An action-row spec takes one as `icon`.
- **Menu icons** (`ICON`) are drawn for the 30px context-menu cells: 1.6px strokes, filled bars for things that exist, dashed outlines for the slot an action makes.
- Unicode symbols (▶ ■ ⏺ ↶ ↷ ◐) are never labels: several are missing from stock phone fonts.
- The app mark is an oblique M in a brand-red gradient on a slate tile (`microtone-worker/favicon.svg`); the wordmark is typeset, not an image.

## Words

- Plain, exact British English: colour, centre, behaviour. Say what a control does in the fewest words that stay true.
- Second person, sparingly; no exclamation marks, no emoji.
- Sentence case for buttons, menus and dialog titles; uppercase only in tab labels.
- An ellipsis (`…`, one character) on a label means a dialog follows.
- Explain what happened, not what to do.
- Tracker vocabulary is kept as is: pattern, cue, row, effect column, sample, instrument, TET. One of the parts a song is written on is a **lane** — never a channel or a voice in prose. Hex values are written `$FF`; an effect code is written `S $7300` in backticks, with a no-break space before the dollar sign.

## Components

The library is `microtone-worker/src/ui/components/`, linked here as `components/`. Import a component by its real path (`../components/actions.js` from `src/ui/popups/`): a module loaded through the link resolves its own imports against the link and breaks.

| Component | Module | What it is |
|---|---|---|
| ActionRow | `actions.js` | a dialog's button row, laid out by role |
| Modal | `modal.js` | `showModal` form dialogs from field specs; `showNotice` for a one-button message |
| ValueControl | `spinner.js` | every number field and dropdown as a − value + group, applied automatically |
| ContextMenu | `contextmenu.js` | the icon-cell menu pinned to the pointer |
| DragGrip | `dragsort.js` | a handle that reorders rows, by pointer or ↑ ↓ |
| Fold | `fold.js` | folds a titlebar-over-body panel shut, remembered per viewer |
| LampButton | `lampbutton.js` | an option's on/off: a pushbutton whose lamp says whether it is on |
| FlipSwitch | `flipswitch.js` | a piece of equipment, or a band of it, in circuit or bypassed |
| NoteGlyph | `noteglyph.js` | a note spelled as the grids spell it, as text |

Pure-CSS components — Button, Badge, Tabs, Toolbar, Pushbuttons, Wordmark — are classes in `microtone.css`; `components.json` names them and `docs/` shows them.

A new reusable piece goes into `components/` as its own module, gets an entry in `components.json` (exports, classes, tokens, rules) and a live demo in `docs/`; the test fails until the manifest lists it.

## Keeping it true

- `node tools/design-tokens.js` after touching a token; `--check` says whether `tokens.json` is current.
- `node --test test/node/design-system.test.js` (from `microtone-worker/`) pins `tokens.json` to the CSS, `components.json` to the library, every dialog row to `actionRow()`, Touch's sheets to the same order, and Proceed's weight and contrast.
- `node tools/browser-smoke.js test/browser/actions-smoke.html` checks the geometry and computed styles of an action row in all four themes, and the dialog helpers end to end.

This system began as an extraction published as a claude.ai Design System artifact (https://claude.ai/artifact/TVa47tRfESBBrX9acd4iZv). This directory supersedes it; the artifact is a published mirror, re-synced from here by hand.
