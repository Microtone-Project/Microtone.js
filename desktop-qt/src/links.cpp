#include "links.h"

#include <QUrl>

#include "appserver.h"

namespace microtone {

Destination classify(const QUrl &url) {
  const QString scheme = url.scheme();
  if (scheme == u"http" && url.host() == QLatin1String(kAppHost) && url.port(-1) == -1)
    return url.path() == u"/docs.html" ? Destination::Docs : Destination::App;
  if (scheme == u"http" || scheme == u"https" || scheme == u"mailto") return Destination::Outside;
  if (scheme == u"blob" || scheme == u"data" || scheme == u"about") return Destination::InPlace;
  return Destination::Nowhere;
}

}  // namespace microtone
