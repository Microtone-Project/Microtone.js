// Where a link goes. In a browser the app is a tab: target=_blank opens
// another tab, and Back comes home. A desktop window has neither, so
//
//   docs.html (the manual, the patch notes)  → the docs window
//   any other page of the app                → the main window
//   http(s) and mailto                       → the system's browser
//
// and the window the link was clicked in stays on its page. That last part is
// what matters: the main window must never navigate away from an open
// project. (The Tauri shell's links.rs, ported.)
#pragma once

class QUrl;

namespace microtone {

enum class Destination {
  Docs,     // the app's docs.html
  App,      // any other page of the app
  Outside,  // the system's browser
  InPlace,  // not a page: blob:, data:, about:blank — left alone
  Nowhere,  // file:, javascript:, anything else — refused
};

Destination classify(const QUrl &url);

}  // namespace microtone
