import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUserAgent, sanitizeHints } from "./ua.ts";

const ANDROID_FROZEN =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const WINDOWS_FROZEN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const MAC_FROZEN =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

test("frozen Android UA without hints keeps the placeholder values", () => {
  const ua = parseUserAgent(ANDROID_FROZEN);
  assert.equal(ua.os.name, "Android");
  assert.equal(ua.os.version, "10");
  assert.equal(ua.device.model, "K");
  assert.equal(ua.browser.name, "Mobile Chrome");
  assert.equal(ua.browser.version, "130");
});

test("Android hints replace the frozen version and model", () => {
  const ua = parseUserAgent(ANDROID_FROZEN, {
    platform: "Android",
    platformVersion: "14.0.0",
    model: "SM-S918B",
    mobile: true,
  });
  assert.equal(ua.os.name, "Android");
  assert.equal(ua.os.version, "14");
  assert.equal(ua.device.model, "SM-S918B");
  assert.equal(ua.device.vendor, "Samsung");
  assert.equal(ua.device.type, "mobile");
  assert.equal(ua.browser.version, "130");
});

test("Windows platformVersion >= 13 is Windows 11", () => {
  const ua = parseUserAgent(WINDOWS_FROZEN, { platform: "Windows", platformVersion: "15.0.0", model: "", mobile: false });
  assert.equal(ua.os.name, "Windows");
  assert.equal(ua.os.version, "11");
  assert.equal(ua.device.type, "desktop");
});

test("macOS gets its real major version", () => {
  const ua = parseUserAgent(MAC_FROZEN, { platform: "macOS", platformVersion: "14.5.0", mobile: false });
  assert.equal(ua.os.name, "macOS");
  assert.equal(ua.os.version, "14");
});

test("empty, missing or garbage hints change nothing", () => {
  const base = parseUserAgent(ANDROID_FROZEN);
  for (const hints of [undefined, null, "x", 42, [], {}, { model: "", platformVersion: "" }, { model: 5, mobile: "yes" }]) {
    assert.deepEqual(parseUserAgent(ANDROID_FROZEN, hints), base);
  }
});

test("hints are validated: unknown platform, non-numeric version and odd models are dropped", () => {
  assert.deepEqual(sanitizeHints({ platform: "EvilOS", platformVersion: "99; DROP", model: "a\nb", mobile: true }), {
    mobile: true,
  });
  assert.deepEqual(sanitizeHints({ model: '"quoted"' }), {});
  assert.deepEqual(sanitizeHints({ platform: "Android", platformVersion: " 14.0.0 ", model: " SM-S918B " }), {
    platform: "Android",
    platformVersion: "14.0.0",
    model: "SM-S918B",
  });
});

test("model is capped at 20 characters", () => {
  assert.equal(sanitizeHints({ model: "Pixel 7 Pro Max XL Fold Ultra" }).model?.length, 20);
  const ua = parseUserAgent(ANDROID_FROZEN, { platform: "Android", platformVersion: "14.0.0", model: "x".repeat(200) });
  assert.equal(ua.device.model, "x".repeat(20));
});

test("forged hints cannot invent OS names, versions or models", () => {
  const ua = parseUserAgent(WINDOWS_FROZEN, { platform: "EvilOS", platformVersion: "98765.1", model: "junk", mobile: true });
  assert.equal(ua.os.name, "Windows");
  assert.equal(ua.os.version, "10");
  assert.equal(ua.device.model, "Unknown");
  assert.equal(ua.device.type, "desktop");
});

test("hints that disagree with the UA's OS are ignored", () => {
  const base = parseUserAgent(WINDOWS_FROZEN);
  assert.deepEqual(parseUserAgent(WINDOWS_FROZEN, { platform: "Android", platformVersion: "14.0.0", model: "X", mobile: false }), base);
  assert.deepEqual(parseUserAgent(MAC_FROZEN, { platform: "Windows", platformVersion: "15.0.0" }), parseUserAgent(MAC_FROZEN));
});

test("Linux hints never overwrite UA-derived names such as Ubuntu", () => {
  const UBUNTU = "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
  const base = parseUserAgent(UBUNTU);
  assert.equal(base.os.name, "Ubuntu");
  assert.deepEqual(parseUserAgent(UBUNTU, { platform: "Linux", platformVersion: "6.5.0", mobile: false }), base);
});

test("a device model is only taken on Android", () => {
  const ua = parseUserAgent(WINDOWS_FROZEN, { platform: "Windows", platformVersion: "15.0.0", model: "Surface" });
  assert.equal(ua.device.model, "Unknown");
});
