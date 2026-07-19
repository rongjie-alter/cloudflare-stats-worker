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

  function send() {
    var endpoint = resolveEndpoint();
    var body = JSON.stringify({
      path: location.pathname,
      referrer: document.referrer || "",
    });

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
