/*
 * cloudflare-stats-worker beacon (V2)
 *
 * Drop-in pageview tracker. Sends the current path + document.referrer to the
 * worker's /api/collect endpoint. Everything else (OS, browser, device,
 * country, visitor id) is derived server-side. Cookieless. No dependencies.
 *
 * Usage — add to your site's <head> (or before </body>):
 *   <script defer src="https://stats.example.com/beacon.js"
 *           data-endpoint="https://stats.example.com/api/collect"></script>
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
          return new URL("/api/collect", el.src).toString();
        } catch (e) {
          /* fall through */
        }
      }
    }
    return "/api/collect";
  }

  function send() {
    var endpoint = resolveEndpoint();
    var body = JSON.stringify({
      path: location.pathname,
      referrer: document.referrer || "",
    });

    // sendBeacon is fire-and-forget and survives page unload. It sends the body
    // as text/plain; the worker parses it as JSON regardless of content type.
    if (navigator.sendBeacon) {
      try {
        navigator.sendBeacon(endpoint, body);
        return;
      } catch (e) {
        /* fall back to fetch */
      }
    }
    try {
      fetch(endpoint, { method: "POST", body: body, keepalive: true, mode: "cors" });
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
