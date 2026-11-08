/*
 * cloudflare-stats-worker beacon (V2)
 *
 * Drop-in pageview tracker. Sends the current path + document.referrer to the
 * worker's /api/send endpoint. Everything else (OS, browser, device,
 * country, visitor id) is derived server-side. Cookieless. No dependencies.
 *
 * Usage — add to your site's <head> (or before </body>):
 *   <script defer src="https://stats.example.com/report.js"
 *           data-endpoint="https://stats.example.com/api/send"></script>
 *
 * If data-endpoint is omitted, the script infers it from its own src origin.
 */
(function () {
  "use strict";

  function resolveEndpoint() {
    var el = document.currentScript;
    if (el) {
      var explicit = el.getAttribute("data-endpoint");
      if (explicit) return explicit;
      if (el.src) {
        try {
          return new URL("/api/send", el.src).toString();
        } catch (e) {
          /* fall through */
        }
      }
    }
    return "/api/send";
  }

  // document.currentScript is only set while the script first executes; it is
  // null by the time the delayed send fires (timer / promise / pagehide), which
  // used to fall back to the host site's own /api/send. Resolve it once, here.
  var ENDPOINT = resolveEndpoint();

  function is404() {
    // Navigation Timing L2 reports the page's own response status. Not yet
    // supported in Safari, where responseStatus stays 0 — in that case we
    // can't tell, so we don't block the send.
    try {
      var nav = performance.getEntriesByType("navigation")[0];
      return !!nav && nav.responseStatus === 404;
    } catch (e) {
      return false;
    }
  }

  // Chromium freezes the User-Agent string (Android reports "Android 10; K",
  // Windows 11 reports "NT 10.0", macOS "10_15_7"), so the real OS version and
  // device model only exist as User-Agent Client Hints. The model and platform
  // version are high-entropy hints, available asynchronously from this API.
  // Resolves with undefined where unsupported (Firefox, Safari) or refused.
  function clientHints() {
    var uad = navigator.userAgentData;
    if (!uad || typeof uad.getHighEntropyValues !== "function") {
      return Promise.resolve(undefined);
    }
    return uad.getHighEntropyValues(["model", "platformVersion"]).then(
      function (high) {
        return {
          platform: uad.platform,
          mobile: uad.mobile,
          model: high.model,
          platformVersion: high.platformVersion,
        };
      },
      function () {
        return undefined;
      }
    );
  }

  function send() {
    if (is404()) return;

    // Hints are a nicety, the pageview is not: wait for them only briefly, and
    // never past the moment the visitor leaves. `sent` makes the hint promise,
    // the timer and the page-hide listeners race to exactly one request.
    var sent = false;
    var timer;
    function deliver(uach) {
      if (sent) return;
      sent = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      removeEventListener("pagehide", onLeave);
      post(uach);
    }
    function onLeave() {
      deliver();
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") deliver();
    }
    timer = setTimeout(onLeave, 300);
    document.addEventListener("visibilitychange", onVisibility);
    addEventListener("pagehide", onLeave);
    clientHints().then(deliver);
  }

  function post(uach) {
    var endpoint = ENDPOINT;
    var payload = {
      path: location.pathname,
      referrer: document.referrer || "",
    };
    if (uach) payload.uach = uach;
    var body = JSON.stringify(payload);

    // Deliver via XMLHttpRequest only. sendBeacon is deliberately avoided: it
    // returns true once the request is merely queued, so a blocker extension
    // that neuters it looks like success and the pageview is silently lost.
    // A single transport also makes double-counting structurally impossible.
    // The body is sent as text/plain (default for a string) to stay a "simple"
    // CORS request with no preflight; the worker parses it as JSON regardless
    // of Content-Type.
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("POST", endpoint, true);
      xhr.send(body);
    } catch (e) {
      /* ignore — analytics must never break the page */
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    send();
  } else {
    document.addEventListener("DOMContentLoaded", send, { once: true });
  }
})();
