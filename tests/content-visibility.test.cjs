"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

// Execute the complete production script. Only its browser boundary is mocked;
// polling, candidate stability, retry accounting and verification remain real.
const source = readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
const manifest = JSON.parse(readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8"));

function harness({ visibility = "visible", endOnClick = false, skipDisabled = false } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const clicks = [];
  const audioRequests = [];
  const audioChanges = [];
  const mediaWrites = [];
  let tabMuted = false;
  let runtimeListener;
  let context;

  function timer(callback, delay, interval = 0) {
    const id = ++timerId;
    timers.set(id, { callback, due: now + delay, interval });
    return id;
  }
  async function settle() {
    // The script's audio Promise.then/catch/finally chain can schedule a scan.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  async function advance(milliseconds) {
    const until = now + milliseconds;
    let ticks = 0;
    while (true) {
      const next = [...timers].filter(([, t]) => t.due <= until)
        .sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
      if (!next) break;
      assert.ok(++ticks < 10000, "fake timers must make progress");
      const [id, t] = next;
      now = t.due;
      if (t.interval) t.due += t.interval;
      else timers.delete(id);
      t.callback();
      await settle();
    }
    now = until;
    await settle();
  }

  class Element extends EventTarget {
    constructor(classes = []) {
      super();
      this.classList = new Set(classes);
      this.classList.contains = this.classList.has;
      this.attributes = new Map();
      this.parentElement = null;
      this.isConnected = true;
      this.hidden = false;
      this.style = { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" };
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    getBoundingClientRect() { return { left: 20, top: 20, right: 120, bottom: 60, width: 100, height: 40 }; }
    matches(selector) {
      if (selector === ":disabled") return this.hasAttribute("disabled");
      if (selector === "a") return false;
      return false;
    }
    closest(selector) {
      for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node;
      return null;
    }
    contains(other) {
      for (let node = other; node; node = node.parentElement) if (node === this) return true;
      return false;
    }
    querySelectorAll() { return []; }
  }
  class HTMLButtonElement extends Element {}
  const media = { currentSrc: "https://example.test/same-ad", currentTime: 10 };
  for (const [name, initial] of [["muted", false], ["volume", 0.37]]) {
    let value = initial;
    Object.defineProperty(media, name, {
      get: () => value,
      set: next => { mediaWrites.push({ name, value: next }); value = next; }
    });
  }
  const player = new Element(["html5-video-player", "ad-showing"]);
  const button = new HTMLButtonElement(["ytp-ad-skip-button-modern"]);
  button.className = "ytp-ad-skip-button-modern";
  button.innerText = "Skip";
  button.parentElement = player;
  if (skipDisabled) button.setAttribute("disabled", "");
  player.querySelector = selector => selector.includes("video") ? media : null;
  player.querySelectorAll = selector => selector === ".ytp-ad-skip-button-modern" ? [button] : [];
  const document = new EventTarget();
  document.visibilityState = visibility;
  document.documentElement = new Element();
  document.body = new Element();
  document.querySelector = selector => selector === "#movie_player.html5-video-player" ? player : null;
  document.elementFromPoint = () => button;
  function endAd() {
    player.classList.delete("ad-showing");
    media.currentSrc = "https://example.test/content";
  }
  button.click = () => {
    clicks.push({ at: now, visibility: document.visibilityState,
      marked: button.getAttribute("data-yas-page-click") });
    if (endOnClick) endAd();
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      getManifest: () => manifest,
      onMessage: {
        addListener: fn => { runtimeListener = fn; },
        removeListener: fn => { if (runtimeListener === fn) runtimeListener = null; }
      },
      sendMessage(message) {
        assert.equal(message.type, "YAS_SYNC_AD_AUDIO");
        let observed;
        runtimeListener({ type: "YAS_QUERY_AD_AUDIO", requestId: message.requestId },
          { id: chrome.runtime.id }, response => { observed = response; });
        assert.equal(observed.ok, true);
        audioRequests.push({ at: now, ...observed });
        // Model the worker response at the runtime boundary: an active ad is
        // muted in foreground and background. Player audio is never modified.
        const muted = observed.adActive;
        if (muted !== tabMuted) audioChanges.push({ at: now, muted });
        tabMuted = muted;
        return Promise.resolve({ ok: true, runId: observed.runId,
          mutedByExtension: muted, reason: observed.adActive ? "ad_active" : "ad_ended" });
      }
    }
  };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [1_800_000_000_000 + now])); }
    static now() { return 1_800_000_000_000 + now; }
  }
  context = vm.createContext({
    chrome, document, Element, HTMLElement: Element, HTMLButtonElement,
    URL, location: new URL("https://www.youtube.com/watch?v=visibility_fixture"),
    Date: ClockDate, performance: { now: () => now },
    innerWidth: 1024, innerHeight: 768, getComputedStyle: node => node.style,
    console: { info() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: (fn, delay) => timer(fn, delay),
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => timer(fn, delay, delay),
    clearInterval: id => timers.delete(id)
  });
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    advance, clicks, audioRequests, audioChanges, media, mediaWrites, endAd,
    status: () => context.__youtubeAdAutoSkip.getStatus(),
    skipAvailable(available) {
      if (available) button.removeAttribute("disabled");
      else button.setAttribute("disabled", "");
    },
    visibility(value) {
      document.visibilityState = value;
      document.dispatchEvent(new Event("visibilitychange"));
    }
  };
}

function assertPlayerAudioUnchanged(h) {
  assert.deepEqual(h.mediaWrites, [], "content script must not write player audio properties");
  assert.equal(h.media.muted, false);
  assert.equal(h.media.volume, 0.37);
}

test("a hidden ad waits for its disabled skip button without spending retries, then skips while still hidden", async () => {
  const h = harness({ visibility: "hidden", endOnClick: true, skipDisabled: true });
  await h.advance(35_000);
  const waiting = h.status();
  const episode = waiting.adEpisode;
  assert.equal(h.clicks.length, 0, "an unavailable button must never be clicked");
  h.skipAvailable(true);
  await h.advance(2_000);
  const ended = h.status();
  // Keep the complete before/after result together: the same button becomes
  // usable without any visibility event or new ad identity.
  assert.deepEqual({
    waiting: { state: waiting.state, attempts: waiting.clickAttempts,
      episodeAttempts: waiting.episodeAttempts, dispatches: waiting.pageDispatches },
    ended: { state: ended.state, attempts: ended.clickAttempts,
      dispatches: ended.pageDispatches, transitions: ended.confirmedTransitions,
      sameEpisode: ended.adEpisode === episode },
    actualClicks: h.clicks.length
  }, {
    waiting: { state: "waiting_skip", attempts: 0, episodeAttempts: 0, dispatches: 0 },
    ended: { state: "content", attempts: 1, dispatches: 1, transitions: 1, sameEpisode: true },
    actualClicks: 1
  });
  assert.deepEqual(h.clicks.map(click => click.visibility), ["hidden"]);
  assert.equal(h.clicks[0].marked, "1");
  assert.equal(waiting.audioMutedByExtension, true, "a waiting background ad stays muted");
  assert.equal(ended.audioMutedByExtension, false);
  assert.deepEqual(h.audioChanges.map(change => change.muted), [true, false]);
  assertPlayerAudioUnchanged(h);
});

test("real foreground clicks that fail to end an ad still stop after four attempts", async () => {
  const h = harness();
  await h.advance(35_000);
  const status = h.status();
  assert.equal(status.state, "retry_limit");
  assert.equal(status.clickAttempts, 4);
  assert.equal(status.episodeAttempts, 4);
  assert.equal(status.pageDispatches, 4);
  assert.equal(status.failedVerifications, 4);
  assert.equal(status.confirmedTransitions, 0);
  assert.equal(h.clicks.length, 4);
  assert.ok(h.clicks.every(click => click.visibility === "visible"));
  await h.advance(35_000);
  assert.equal(h.clicks.length, 4, "polling must retain the per-ad retry limit");
  assertPlayerAudioUnchanged(h);
});

test("real background clicks that fail to end an ad still stop after four attempts", async () => {
  const h = harness({ visibility: "hidden" });
  await h.advance(35_000);
  const status = h.status();
  assert.equal(status.state, "retry_limit");
  assert.equal(status.clickAttempts, 4);
  assert.equal(status.episodeAttempts, 4);
  assert.equal(status.pageDispatches, 4);
  assert.equal(status.failedVerifications, 4);
  assert.equal(status.confirmedTransitions, 0);
  assert.equal(status.audioMutedByExtension, true);
  assert.equal(h.clicks.length, 4);
  assert.ok(h.clicks.every(click => click.visibility === "hidden"));
  await h.advance(35_000);
  assert.equal(h.clicks.length, 4, "background polling must retain the per-ad retry limit");
  assertPlayerAudioUnchanged(h);
});

test("an ad ending while hidden still syncs audio and verifies a previously dispatched click", async () => {
  const h = harness({ visibility: "hidden" });
  await h.advance(300);
  assert.equal(h.status().pageDispatches, 1);
  assert.equal(h.status().audioMutedByExtension, true);
  h.endAd();
  await h.advance(2_000);
  const status = h.status();
  assert.equal(status.state, "content");
  assert.equal(status.adActive, false);
  assert.equal(status.confirmedTransitions, 1);
  assert.equal(status.failedVerifications, 0);
  assert.equal(status.audioMutedByExtension, false);
  assert.equal(status.audioRunId, null);
  assert.ok(h.audioRequests.some(request => !request.visible && !request.adActive && request.runId === null),
    "the runtime must receive the hidden-page ad end for audio restoration");
  assert.deepEqual(h.audioChanges.map(change => change.muted), [true, false]);
  assert.equal(h.clicks.length, 1);
  assert.ok(h.clicks.every(click => click.visibility === "hidden"));
  assertPlayerAudioUnchanged(h);
});
