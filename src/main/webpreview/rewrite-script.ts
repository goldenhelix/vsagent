// In-page URL-rewriting script injected into proxied HTML responses. The
// browser is loading content from `/__orca/webpreview/<sessionId>/<path>`,
// but the page believes it's at the target origin. Without this script,
// any `fetch('/api/foo')` would hit the gateway's `/api/foo` (404), and any
// absolute `https://example.com/...` would skip the proxy entirely.
//
// This script overrides the common DOM/JS network surfaces so every URL the
// page constructs at runtime is rerouted through the proxy. Pattern is
// lifted directly from MidTerm's WebPreviewProxyMiddleware: rewrite fetch,
// XHR, sendBeacon, src/href/srcset/action setters, setAttribute, window.open,
// WebSocket / EventSource / Worker constructors. The implementation here is
// trimmed down — no service-worker shim, no cookie-refresh choreography,
// no storage scoping — and aimed at "make typical SPA dev servers load
// cleanly inside an iframe", not "behave exactly like the origin".
//
// The script is parameterised by:
//   __orcaProxyPrefix   — e.g. "/__orca/webpreview/<sessionId>"
//   __orcaTargetOrigin  — e.g. "http://localhost:3000"
//
// Both are stamped in by `buildRewriteScript()` below.

export function buildRewriteScript(opts: { prefix: string; targetOrigin: string }): string {
  // Why: serialize-with-JSON-stringify so any double-quote / backslash in the
  // values is safely escaped. Values are then read by the page script as
  // string literals.
  const prefix = JSON.stringify(opts.prefix)
  const targetOrigin = JSON.stringify(opts.targetOrigin)
  return /* js */ `
;(function(){
  if (window.__orcaProxy) return;
  window.__orcaProxy = 1;
  var P = ${prefix};
  var TO = ${targetOrigin};
  var E = P + '/_ext?u=';
  window.__orcaTargetOrigin = TO;

  // Why: capture the real parent BEFORE cloaking. The cloak below overrides
  // window.parent so SPAs that gate on "window.top === window" don't bail out
  // inside the iframe, but we still need a working reference to the renderer
  // so postNav() can deliver nav events to the address bar.
  var realParent = window.parent;

  // Cloak iframe presence so SPAs that check window.top === window pass.
  try { Object.defineProperty(window, 'top', { get: function () { return window }, configurable: true }) } catch (e) {}
  try { Object.defineProperty(window, 'parent', { get: function () { return window }, configurable: true }) } catch (e) {}
  try { Object.defineProperty(window, 'frameElement', { get: function () { return null }, configurable: true }) } catch (e) {}

  // Why: r(url) is the central rewriter. It maps any URL the page constructs
  // back into the proxy's path space. data:/blob:/about:/javascript:/# stay
  // alone. Relative URLs resolve against document.baseURI before rewriting.
  // Same-origin absolute URLs (i.e. the target origin) are stripped to a
  // proxy-relative path. Cross-origin URLs go through /_ext?u=<encoded> so
  // the proxy can stream a different origin without leaving the iframe.
  function r(u) {
    if (typeof u !== 'string') return u;
    if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('about:') ||
        u.startsWith('javascript:') || u.startsWith('#')) return u;
    if (u.startsWith(P + '/') || u.startsWith(P + '?') || u === P) return u;
    if (!u.includes('://') && !u.startsWith('/') && !u.startsWith('//')) {
      try { return r(new URL(u, document.baseURI).toString()) } catch (e) {}
    }
    if (u.startsWith('//')) u = location.protocol + u;
    if (u.startsWith('/')) return P + u;
    if (u.startsWith('http://') || u.startsWith('https://') || u.startsWith('ws://') || u.startsWith('wss://')) {
      try {
        var parsed = new URL(u);
        var targetParsed = new URL(TO);
        // Why: ws:// and wss:// URLs have a ws-scheme origin, so they never
        // === an http(s) origin even when they point at the same server. The
        // gateway tunnels WS by host:port, so match on host for ws/wss.
        var isWs = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
        if (parsed.origin === targetParsed.origin || (isWs && parsed.host === targetParsed.host)) {
          return P + parsed.pathname + parsed.search + parsed.hash;
        }
        // Why: the iframe's document origin IS the gateway, so pages that
        // build URLs from location.origin come out gateway-origin. Route those
        // to a proxy path (not _ext, which would recursively serve the renderer
        // app). Strip an existing proxy prefix first to avoid a <P>/<P> double.
        if (parsed.origin === location.origin || (isWs && parsed.host === location.host)) {
          var pn = parsed.pathname;
          if (pn === P || pn.startsWith(P + '/')) {
            return pn + parsed.search + parsed.hash;
          }
          return P + pn + parsed.search + parsed.hash;
        }
        return E + encodeURIComponent(u);
      } catch (e) {}
    }
    return u;
  }

  // === Network APIs ===
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      if (typeof input === 'string') return origFetch.call(this, r(input), init);
      if (input && typeof input === 'object' && input.url) {
        var newInit = { method: input.method, headers: input.headers, mode: input.mode,
          credentials: input.credentials, cache: input.cache, redirect: input.redirect,
          referrer: input.referrer, referrerPolicy: input.referrerPolicy,
          integrity: input.integrity, keepalive: input.keepalive, signal: input.signal };
        if (init) for (var k in init) newInit[k] = init[k];
        return origFetch.call(this, r(input.url), newInit);
      }
      return origFetch.call(this, input, init);
    };
  }

  if (window.XMLHttpRequest) {
    var Xopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      var args = [].slice.call(arguments);
      if (typeof u === 'string') args[1] = r(u);
      return Xopen.apply(this, args);
    };
  }

  if (navigator.sendBeacon) {
    var origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (u, d) { return origBeacon(r(u), d); };
  }

  // === Element setters ===
  // .src on tags that load resources
  ['HTMLScriptElement','HTMLImageElement','HTMLIFrameElement','HTMLSourceElement',
   'HTMLEmbedElement','HTMLVideoElement','HTMLAudioElement','HTMLTrackElement'].forEach(function (n) {
    var p = window[n] && window[n].prototype;
    if (!p) return;
    var d = Object.getOwnPropertyDescriptor(p, 'src');
    if (!d || !d.set) return;
    Object.defineProperty(p, 'src', {
      set: function (v) { d.set.call(this, r(v)); },
      get: d.get, configurable: true, enumerable: true
    });
  });

  function wrapHref(ctor) {
    var p = window[ctor] && window[ctor].prototype;
    if (!p) return;
    var d = Object.getOwnPropertyDescriptor(p, 'href');
    if (!d || !d.set) return;
    Object.defineProperty(p, 'href', {
      set: function (v) { d.set.call(this, r(v)); },
      get: d.get, configurable: true, enumerable: true
    });
  }
  wrapHref('HTMLLinkElement');
  wrapHref('HTMLAnchorElement');
  // <area> elements (image maps)
  wrapHref('HTMLAreaElement');

  // .action on form
  (function () {
    var p = HTMLFormElement.prototype;
    var d = Object.getOwnPropertyDescriptor(p, 'action');
    if (!d || !d.set) return;
    Object.defineProperty(p, 'action', {
      set: function (v) { d.set.call(this, r(v)); },
      get: d.get, configurable: true, enumerable: true
    });
  })();

  // .data on <object>
  (function () {
    var p = HTMLObjectElement && HTMLObjectElement.prototype;
    if (!p) return;
    var d = Object.getOwnPropertyDescriptor(p, 'data');
    if (!d || !d.set) return;
    Object.defineProperty(p, 'data', {
      set: function (v) { d.set.call(this, r(v)); },
      get: d.get, configurable: true, enumerable: true
    });
  })();

  // srcset (img/source) — comma-separated list of url+descriptor pairs
  function rss(v) {
    if (typeof v !== 'string') return v;
    return v.replace(/(^|,\\s*)([^\\s,]+)/g, function (m, pre, url) { return pre + r(url); });
  }
  ['HTMLImageElement','HTMLSourceElement'].forEach(function (n) {
    var p = window[n] && window[n].prototype;
    if (!p) return;
    var d = Object.getOwnPropertyDescriptor(p, 'srcset');
    if (!d || !d.set) return;
    Object.defineProperty(p, 'srcset', {
      set: function (v) { d.set.call(this, rss(v)); },
      get: d.get, configurable: true, enumerable: true
    });
  });

  // setAttribute for any URL-bearing attribute we know about
  var origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof value === 'string') {
      if (/^(src|href|action|poster|data|formaction)$/i.test(name)) value = r(value);
      else if (/^srcset$/i.test(name)) value = rss(value);
    }
    return origSetAttr.call(this, name, value);
  };

  // === Location navigation ===
  // Why: pages frequently call \`location.href = '/foo'\`, \`location.assign('/foo')\`,
  // or \`location.replace('/foo')\`. These bypass every element/setAttribute/fetch
  // override above — the browser resolves the URL against the document origin
  // (which is the GATEWAY, not the target) and navigates the iframe to e.g.
  // http://<gateway>/foo. Without this section, the iframe lands on the
  // gateway's index.html (the renderer app) and renders the full app inside
  // itself. Patch Location.prototype so every assign / replace / href set
  // goes through r().
  try {
    var locProto = Location.prototype;
    var origAssign = locProto.assign;
    var origReplace = locProto.replace;
    locProto.assign = function (u) { return origAssign.call(this, r(u)); };
    locProto.replace = function (u) { return origReplace.call(this, r(u)); };
    var hrefDesc = Object.getOwnPropertyDescriptor(locProto, 'href');
    if (hrefDesc && hrefDesc.set) {
      Object.defineProperty(locProto, 'href', {
        get: hrefDesc.get,
        set: function (v) { hrefDesc.set.call(this, r(v)); },
        configurable: true,
        enumerable: true
      });
    }
  } catch (e) {}

  // === Constructors ===
  var origOpen = window.open;
  window.open = function (u) {
    var args = [].slice.call(arguments);
    if (typeof u === 'string') args[0] = r(u);
    return origOpen.apply(this, args);
  };

  // WebSocket / EventSource — route URLs through r() so ws://target/...
  // becomes a proxy-relative /__orca/webpreview/<sessionId>/... path. The
  // gateway's upgrade handler tunnels these to the session's upstream
  // (handleWebPreviewUpgrade), so e.g. KasmVNC's VNC stream works.
  if (window.WebSocket && window.Proxy) {
    try {
      var OWS = window.WebSocket;
      window.WebSocket = new Proxy(OWS, {
        construct: function (T, a) { if (a && a.length > 0) a[0] = r(a[0]); return Reflect.construct(T, a); }
      });
    } catch (e) {}
  }
  if (window.EventSource && window.Proxy) {
    try {
      var OES = window.EventSource;
      window.EventSource = new Proxy(OES, {
        construct: function (T, a) { if (a && a.length > 0) a[0] = r(a[0]); return Reflect.construct(T, a); }
      });
    } catch (e) {}
  }

  // Workers
  if (window.Worker) {
    var OW = window.Worker;
    var WW = function (u, o) { return new OW(r(u), o); };
    WW.prototype = OW.prototype;
    window.Worker = WW;
  }

  // Notify the parent frame of navigations so the address bar updates.
  function getUpstreamUrl() {
    if (location.pathname === P + '/_ext') {
      try { var ext = new URLSearchParams(location.search).get('u'); if (ext) return ext; } catch (e) {}
    }
    var path = location.pathname;
    if (path.indexOf(P + '/') === 0) path = path.substring(P.length);
    else if (path === P) path = '/';
    return TO + path + location.search + location.hash;
  }
  function postNav() {
    try {
      // Why: use realParent (captured pre-cloak). window.parent is now a
      // self-reference, so posting there would never reach the renderer.
      realParent.postMessage({
        type: 'orca-webpreview-nav',
        href: location.href,
        upstreamUrl: getUpstreamUrl()
      }, '*');
    } catch (e) {}
  }
  postNav();
  window.addEventListener('hashchange', postNav);
  window.addEventListener('popstate', postNav);

  // Why: static cross-origin <a href> clicks (e.g. a link to github.com from
  // another site) otherwise navigate the iframe STRAIGHT to that origin —
  // server rewriting only touches root-relative paths, so the browser follows
  // the raw absolute href, skipping the proxy. The unproxied page then has no
  // rewriter, emits no nav ping (address bar freezes), and the target's
  // X-Frame-Options can block it ("refused to connect"). Intercept plain
  // cross-origin link clicks and hand them to the renderer, which retargets
  // the proxy session — same effect as typing the new address.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var a = t && t.closest ? t.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#') return;
    var abs;
    try { abs = new URL(href, document.baseURI); } catch (e2) { return; }
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
    var to;
    try { to = new URL(TO); } catch (e3) { return; }
    // Same-origin (target) and gateway-origin links already resolve to proxy
    // paths via server/runtime rewriting — let the browser navigate them.
    if (abs.origin === to.origin || abs.origin === location.origin) return;
    e.preventDefault();
    try { realParent.postMessage({ type: 'orca-webpreview-navigate', url: abs.toString() }, '*'); } catch (e4) {}
  }, true);
  // history.pushState / replaceState don't fire popstate — patch them.
  // Why: SPA routers (VitePress, etc.) push BASE-RELATIVE urls like
  // "/foo" that omit our proxy prefix. r() governs every other URL the page
  // builds, but NOT the History API — so without rewriting the url arg here
  // the live location drops to a bare gateway path, and the next reload /
  // document fetch misses /__orca/webpreview/<id> and the gateway's SPA
  // fallback serves the renderer INTO this iframe (page-in-page recursion).
  // Re-prefix the url (r() is idempotent on already-prefixed urls).
  function patchHistory(orig) {
    return function (state, title, url) {
      var args = [].slice.call(arguments);
      if (typeof url === 'string') args[2] = r(url);
      var ret = orig.apply(this, args);
      postNav();
      return ret;
    };
  }
  history.pushState = patchHistory(history.pushState);
  history.replaceState = patchHistory(history.replaceState);
})();
`
}
