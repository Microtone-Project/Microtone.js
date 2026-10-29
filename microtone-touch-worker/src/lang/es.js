// Spanish — translated from en.js (the reference list) with the Microtone
// translation workbench (microtone.cc/translation). Keys missing here fall
// back to English automatically. Register "es" in LANGS (i18n.js) to offer it.

export default {
  // ── the start veil ──
  "veil.loading": "Cargando…",

  // ── the transport bar ──
  "app.sketch": "Maqueta",
  "app.aboutOpen": "Acerca de Microtone Touch",
  "transport.record": "Grabar",
  "transport.song": "Canción",
  "transport.menu": "Menú",

  // ── the song pane ──
  "sections.label": "Secciones",
  "sections.add": "Añadir una sección (copia de esta)",
  "grid.label": "Patrón",
  "edit.label": "Editando",
  "edit.fxTitle": "Efecto en la celda",
  "edit.undo": "Deshacer",
  "edit.redo": "Rehacer",

  // ── the splitter ──
  "split.handLeft": "Teclado a la izquierda (zurdo)",
  "split.handRight": "Teclado a la derecha (diestro)",

  // ── the keyboard pane ──
  "keys.label": "Teclado",
  "keys.canvas": "Teclado isomórfico",
  "keys.smaller": "Teclas más pequeñas",
  "keys.larger": "Teclas más grandes",
  "keys.lane": "Pista {n}",

  // ── keyboard layouts (lattice.js LAYOUTS) — the name, and the picker's short form ──
  "layout.wicki": "Wicki–Hayden",
  "layout.wicki.short": "Wicki",
  "layout.bosanquet": "Bosanquet–Wilson",
  "layout.bosanquet.short": "Bosanquet",
  "layout.harmonic.short": "Harmónico",

  // ── tunings (sketch.js TUNINGS) ──
  "tuning.bp": "Bohlen–Pierce",

  // ── the instrument pack (core/sketch/pack.js) — the name, and the grid header's short form ──
  "preset.piano": "Piano",
  "preset.epiano": "Piano eléctrico",
  "preset.bass": "Bajo",
  "preset.organ": "Órgano",

  // ── effects (sketch.js FX) ──
  "fx.vibrato": "Vibrato",

  // ── sheets ──
  "sheet.done": "Hecho",
  "sheet.cancel": "Cancelar",
  "sheet.close": "Cerrar",
  "lane.title": "Pista {n}",
  "section.title": "Sección {name}",
  "section.delete": "Borrar",
  "fx.title": "Effecto en {note}",
  "tempo.title": "Tempo",
  "tuning.title": "Temperamento",
  "theme.system": "Sistema",
  "theme.dark": "Oscuro",
  "theme.light": "Claro",
  "lang.title": "Idioma",
  "lang.system": "Sistema",

  // ── the menu ──
  "menu.tuning": "Temperamento…",
  "menu.new": "Nueva maqueta",
  "menu.save": "Guardar",
  "menu.saveAs": "Guardar como…",
  "menu.load": "Cargar…",
  "menu.files": "Archivos…",
  "menu.lang": "Idioma…",
  "menu.about": "Acerca de…",
  "menu.capNowhere": "{name} — aún no guardado",
  "menu.capLocal": "{name} — en este teléfono",
  "menu.capOnline": "{name} — en línea",
  "menu.capLocalUnsaved": "{name} — en este teléfono, cambios sin guardar",
  "menu.capOnlineUnsaved": "{name} — en línea, cambios sin guardar",

  // ── a new sketch ──
  "sketch.untitled": "Maqueta",

  // ── saving (saving.js) ──
  "err.offline": "Sin conexión. Prueba de nuevo cuando vuelvas a estar en línea.",
  "err.too-large": "La maqueta es más grande de lo posible para una maqueta en línea.",
  "err.bad-name": "Ese nombre no puede ser usado.",
  "err.not-found": "La maqueta ya no está ahí.",
  "save.failed": "Sin guardar",
  "save.savedLocal": "Guardado “{name}” en este teléfono.",
  "save.saving": "Guardando en línea…",
  "save.savedOnline": "Guardado en línea.",
  "save.savedOnlineAs": "Guardado “{name}” en línea.",
  "conflict.saveNew": "Guardar como una nueva maqueta",
  "conflict.copyName": "{name} (teléfono)",
  "saveAs.title": "Guardar como",
  "saveAs.name": "Nombre",
  "saveAs.local": "En este teléfono",
  "saveAs.online": "En línea",
  "saveAs.share": "Compartir…",
  "saveAs.download": "Descargar",
  "signIn.unavailableTitle": "No disponible",
  "unsaved.title": "Cambios sin guardar",
  "unsaved.body": "“{name}” tiene cambios sin guardar.",
  "unsaved.bodyNowhere": "“{name}” tiene cambios sin guardar en ningún sitio aún.",
  "unsaved.save": "Guardar",
  "unsaved.discard": "No guardar",

  // ── Files, and the Load… sheet (files.js) ──
  "files.title": "Archivos",
  "files.back": "Volver a la maqueta",
  "files.new": "Nueva maqueta",
  "files.local": "En este teléfono",
  "files.online": "En línea",
  "files.bytes": "{n} bytes",
  "files.kb": "{n} KB",
  "files.sections.one": "{n} sección",
  "files.sections.other": "{n} secciones",
  "files.openUnsaved": "Abierto, cambios sin guardar",
  "files.more": "{name}: más",
  "files.opening": "Abriendo “{name}”…",
  "files.openBtn": "Abrir",
  "files.rename": "Renombrar…",
  "files.copyOnline": "Copiar en línea",
  "files.copyLocal": "Copiar a este teléfono",
  "files.delete": "Borrar…",
  "rename.title": "Renombrar",
  "rename.rename": "Renombrar",
  "copy.copying": "Copiando…",
  "copy.failed": "No copiado",
  "copy.takenOnline": "Ya tienes una maqueta en línea llamada “{name}”. Renombra una de las dos primero.",
  "copy.takenLocal": "Ya hay una maqueta llamada “{name}” en este teléfono. Renombra una de las dos primero.",
  "copy.copiedOnline": "Copiado “{name}” en línea.",
  "copy.copiedLocal": "Copiado “{name}” a este teléfono.",
  "delete.delete": "Borrar",
  "load.title": "Cargar",

  // ── About (about.js) ──
  "about.version": "Versión {version}",
  "about.why": "¿Por qué Microtone?",
  "about.donate": "Donar",
  "about.sponsor": "Patrocinador",
};
