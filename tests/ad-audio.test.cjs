"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = readFileSync(path.resolve(__dirname,
  "../extension/ad-audio.js"), "utf8");
const { version } = JSON.parse(readFileSync(path.resolve(__dirname,
  "../extension/manifest.json"), "utf8"));
const copy = value => JSON.parse(JSON.stringify(value));
const sender = {
  id: "test-extension", frameId: 0, tab: { id: 7 }, documentId: "document-1",
  url: "https://www.youtube.com/watch?v=first_video", origin: "https://www.youtube.com"
};

function harness(config = {}) {
  const calls = [];
  let queries = 0;
  let gets = 0;
  let requestSequence = 0;
  let updated = [];
  let removed = [];
  const state = {
    tab: copy({ id: 7, active: true, url: "https://www.youtube.com/watch?v=video_1",
      mutedInfo: { muted: false }, ...(config.tab || {}) }),
    snapshot: { ok: true, version, videoId: "video_1", runId: "run-1",
      adActive: true, visible: true, userOverride: false, ownedAcknowledged: false,
      ...copy(config.snapshot || {}) }
  };
  let controller;
  const chrome = {
    runtime: { id: "test-extension", getManifest: () => ({ version }) },
    tabs: {
      onUpdated: { addListener: fn => updated.push(fn) },
      onRemoved: { addListener: fn => removed.push(fn) },
      async get(tabId) {
        calls.push(["get", tabId]);
        gets++;
        if (config.get) await config.get(state, gets);
        if (state.closed) throw new Error("No tab");
        return copy(state.tab);
      },
      async sendMessage(tabId, message, options) {
        calls.push(["message", tabId, copy(message), copy(options)]);
        if (message.type === "YAS_AUDIO_USER_OVERRIDE") {
          if (state.snapshot.runId === message.runId && state.snapshot.adActive) {
            state.snapshot.userOverride = true;
          }
          return { ok: true };
        }
        queries++;
        const value = config.query ? await config.query(state, message, options, queries) : state.snapshot;
        return value ? { ...copy(value), requestId: message.requestId } : value;
      },
      async update(tabId, properties) {
        calls.push(["update", tabId, copy(properties)]);
        if (config.update) await config.update(state, properties);
        if (state.closed) throw new Error("No tab");
        state.tab.mutedInfo = { muted: properties.muted, reason: "extension", extensionId: chrome.runtime.id };
        updated.forEach(fn => fn(tabId, { mutedInfo: copy(state.tab.mutedInfo) }, copy(state.tab)));
        return copy(state.tab);
      }
    }
  };
  function restart() {
    updated = []; removed = [];
    const context = { chrome, URL, Promise, Map, Object, String, Number };
    vm.runInNewContext(source + "\nglobalThis.controller = YASAdAudio;", context);
    controller = context.controller;
  }
  restart();
  async function request(message = {}, overrideSender = {}) {
    const response = await controller.handleMessage({
      type: "YAS_SYNC_AD_AUDIO", requestId: `request-${++requestSequence}`, ...message
    }, { ...sender, ...overrideSender });
    if (response?.runId === state.snapshot.runId && response?.mutedByExtension) {
      state.snapshot.ownedAcknowledged = true;
    }
    return response;
  }
  function externalMute(info) {
    state.tab.mutedInfo = copy(info);
    updated.forEach(fn => fn(state.tab.id, { mutedInfo: copy(info) }, copy(state.tab)));
  }
  function navigation(url, status) {
    state.tab.url = url;
    updated.forEach(fn => fn(state.tab.id, { url, ...(status ? { status } : {}) }, copy(state.tab)));
  }
  return { state, calls, request, restart, externalMute, navigation,
    remove() { state.closed = true; removed.forEach(fn => fn(state.tab.id)); } };
}

const updates = h => h.calls.filter(([name]) => name === "update");
const ownMute = { muted: true, reason: "extension", extensionId: "test-extension" };

test("mutes a fresh ad and restores only its tab mute after natural ad end", async () => {
  const h = harness();
  const first = await h.request();
  assert.equal(first.mutedByExtension, true);
  assert.equal(first.runId, "run-1");
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }]);
  h.state.snapshot.adActive = false;
  h.state.snapshot.runId = null;
  const last = await h.request();
  assert.equal(last.mutedByExtension, false);
  assert.equal(last.reason, "ad_ended");
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }, { muted: false }]);
});

test("ordinary content makes no audio change", async () => {
  const h = harness({ snapshot: { adActive: false, runId: null } });
  assert.equal((await h.request()).mutedByExtension, false);
  assert.equal(updates(h).length, 0);
});

test("pre-existing user, capture, or other-extension tab mute remains untouched in background", async () => {
  for (const info of [
    { muted: true, reason: "user" },
    { muted: true, reason: "capture" },
    { muted: true, reason: "extension", extensionId: "other-extension" }
  ]) {
    const h = harness({ tab: { active: false, mutedInfo: info }, snapshot: { visible: false } });
    const result = await h.request();
    assert.equal(result.reason, "preserved_existing_mute");
    assert.equal(result.mutedByExtension, false);
    h.state.snapshot.adActive = false;
    h.state.snapshot.runId = null;
    await h.request();
    assert.deepEqual(h.state.tab.mutedInfo, info);
    assert.equal(updates(h).length, 0);
  }
});

test("only tab.muted is written; message volume/player state and arbitrary tab are ignored", async () => {
  const h = harness();
  await h.request({ tabId: 999, muted: false, volume: 1, videoMuted: false, command: "anything" });
  assert.deepEqual(updates(h), [["update", 7, { muted: true }]]);
  assert.equal(h.calls.some(c => c[1] === 999), false);
});

test("continuous adjacent ads keep one run and do not toggle sound between ads", async () => {
  const h = harness();
  await h.request();
  await h.request();
  await h.request();
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }]);
});

test("manual tab unmute is respected for the rest of the background ad run", async () => {
  const h = harness({ tab: { active: false }, snapshot: { visible: false } });
  await h.request();
  h.externalMute({ muted: false, reason: "user" });
  const result = await h.request();
  assert.equal(result.userOverride, true);
  assert.equal(h.state.snapshot.userOverride, true);
  await h.request();
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }]);
  h.state.snapshot = { ...h.state.snapshot, runId: "run-2", userOverride: false, ownedAcknowledged: false };
  assert.equal((await h.request()).mutedByExtension, true);
  assert.equal(updates(h).length, 2);
});

test("manual re-mute or other-extension takeover is not undone after a background ad", async () => {
  for (const info of [
    { muted: true, reason: "user" },
    { muted: true, reason: "extension", extensionId: "other-extension" }
  ]) {
    const h = harness({ tab: { active: false }, snapshot: { visible: false } });
    await h.request();
    h.externalMute(info);
    await h.request();
    h.state.snapshot.adActive = false;
    h.state.snapshot.runId = null;
    await h.request();
    assert.deepEqual(h.state.tab.mutedInfo, info);
    assert.equal(updates(h).length, 1);
  }
});

test("trusted player volume/mute intent releases only the extension overlay in background", async () => {
  const h = harness({ tab: { active: false }, snapshot: { visible: false } });
  await h.request();
  h.state.snapshot.userOverride = true;
  const result = await h.request();
  assert.equal(result.userOverride, true);
  assert.equal(result.mutedByExtension, false);
  await h.request();
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }, { muted: false }]);
});

test("worker restart recognizes its mute without storage and restores it", async () => {
  const h = harness();
  await h.request();
  h.restart();
  assert.equal((await h.request()).mutedByExtension, true);
  assert.equal(updates(h).length, 1);
  h.state.snapshot.adActive = false;
  h.state.snapshot.runId = null;
  assert.equal((await h.request()).mutedByExtension, false);
  assert.equal(updates(h).length, 2);
});

test("lost user onUpdated event is recovered from content acknowledgement plus mute ownership", async () => {
  const h = harness();
  await h.request();
  h.state.tab.mutedInfo = { muted: false, reason: "user" };
  h.restart();
  assert.equal((await h.request()).userOverride, true);
  assert.equal(updates(h).length, 1);
});

test("old-document query cannot unmute a fresh document's current ad", async () => {
  const h = harness({
    tab: { mutedInfo: ownMute },
    query: (state, _message, options) => {
      if (options.documentId === "old-document") throw new Error("No old document");
      return state.snapshot;
    }
  });
  const result = await h.request({}, { documentId: "old-document" });
  assert.equal(result.error, "audio_document_changed");
  assert.equal(updates(h).length, 0);
  h.state.snapshot.adActive = false;
  h.state.snapshot.runId = null;
  assert.equal((await h.request()).mutedByExtension, false);
});

test("unreachable old document releases its leftover mute when current frame has no ad", async () => {
  const h = harness({
    tab: { mutedInfo: ownMute },
    snapshot: { adActive: false, runId: null },
    query: (state, _message, options) => {
      if (options.documentId === "old-document") throw new Error("No old document");
      return state.snapshot;
    }
  });
  assert.equal((await h.request({}, { documentId: "old-document" })).mutedByExtension, false);
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: false }]);
});

test("ad or run changes during the two preparations prevent a stale mutation", async () => {
  for (const replacement of [
    { adActive: false, runId: null },
    { adActive: true, runId: "new-run" },
    { videoId: "video_2", runId: "new-run" }
  ]) {
    const h = harness({ query: (state, _message, _options, count) => ({
      ...state.snapshot, ...(count === 2 ? replacement : {})
    }) });
    assert.equal((await h.request()).error, "audio_run_changed");
    assert.equal(updates(h).length, 0);
  }
});

test("inactive, hidden, and inactive hidden ads mute and restore while remaining in background", async () => {
  for (const config of [
    { tab: { active: false } },
    { snapshot: { visible: false } },
    { tab: { active: false }, snapshot: { visible: false } }
  ]) {
    const h = harness(config);
    assert.equal((await h.request()).mutedByExtension, true);
    assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }]);
    h.state.snapshot.adActive = false;
    h.state.snapshot.runId = null;
    const last = await h.request();
    assert.equal(last.mutedByExtension, false);
    assert.equal(last.reason, "ad_ended");
    assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }, { muted: false }]);
    assert.equal(h.state.tab.active, config.tab?.active ?? true);
    assert.equal(h.state.snapshot.visible, config.snapshot?.visible ?? true);
  }
});

test("leaving YouTube or pending navigation cleans only a mute owned by this extension", async () => {
  for (const tab of [
    { url: "https://example.com/", active: false, mutedInfo: ownMute },
    { pendingUrl: "https://example.com/", mutedInfo: ownMute },
    { url: undefined, mutedInfo: ownMute }
  ]) {
    const h = harness({ tab });
    assert.equal((await h.request()).mutedByExtension, false);
    assert.deepEqual(updates(h).map(c => c[2]), [{ muted: false }]);
  }
  const h = harness({ tab: { url: "https://example.com/", mutedInfo: { muted: true, reason: "user" } } });
  await h.request();
  assert.equal(updates(h).length, 0);
});

test("navigation event cleans an owned mute even without another content request", async () => {
  const h = harness();
  await h.request();
  h.navigation("https://example.com/", "loading");
  await h.request();
  assert.equal(h.state.tab.mutedInfo.muted, false);
});

test("foreign, subframe, malformed or credentialed sender is rejected before reading tabs", async () => {
  for (const bad of [
    { id: "foreign" }, { frameId: 1 }, { tab: { id: -1 } },
    { url: "https://example.com/" }, { url: undefined },
    { url: "https://www.youtube.com.evil.example/" },
    { url: "https://person@www.youtube.com/" },
    { url: "https://person:secret@www.youtube.com/" },
    { origin: "https://example.com" }, { documentId: "" }
  ]) {
    const h = harness();
    assert.equal((await h.request({}, bad)).error, "invalid_audio_sender_or_request");
    assert.equal(h.calls.length, 0);
  }
  for (const requestId of ["", "x".repeat(161), 2]) {
    const h = harness();
    assert.equal((await h.request({ requestId })).error, "invalid_audio_sender_or_request");
    assert.equal(h.calls.length, 0);
  }
});

test("original homepage/watch document URL is allowed after legitimate SPA navigation", async () => {
  for (const url of ["https://www.youtube.com/", "https://www.youtube.com/watch?v=old_video"]) {
    const h = harness();
    assert.equal((await h.request({}, { url })).mutedByExtension, true);
  }
});

test("wrong current watch URL or invalid/unrelated snapshot cannot newly mute", async () => {
  for (const config of [
    { tab: { url: "https://www.youtube.com/watch?v=other_video" } },
    { snapshot: { version: "0.2.3" } },
    { snapshot: { videoId: "../invalid" } },
    { snapshot: { runId: null } },
    { snapshot: { visible: "yes" } },
    { query: () => null }
  ]) {
    const h = harness(config);
    await h.request();
    assert.equal(updates(h).length, 0);
  }
});

test("unknown messages are not accepted as an audio control API", async () => {
  const h = harness();
  assert.equal(await h.request({ type: "SET_VOLUME" }), undefined);
  assert.equal(h.calls.length, 0);
});

test("a failed update does not poison the per-tab queue", async () => {
  let fail = true;
  const h = harness({ update: () => { if (fail) { fail = false; throw new Error("tab temporarily unavailable"); } } });
  assert.equal((await h.request()).error, "audio_update_failed");
  assert.equal((await h.request()).mutedByExtension, true);
});

test("an ad ending during a pending mute is serialized before its final restoration", async () => {
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  let once = true;
  const h = harness({ update: async () => { if (once) { once = false; await gate; } } });
  const muting = h.request();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates(h).length, 1);
  h.state.snapshot.adActive = false;
  h.state.snapshot.runId = null;
  const ending = h.request();
  unblock();
  await Promise.all([muting, ending]);
  assert.deepEqual(updates(h).map(c => c[2]), [{ muted: true }, { muted: false }]);
  assert.equal(h.state.tab.mutedInfo.muted, false);
});

test("a user's newer mute observed before restoration is never cleared", async () => {
  let inject = false;
  const h = harness({ get: state => {
    if (inject) { state.tab.mutedInfo = { muted: true, reason: "user" }; inject = false; }
  } });
  await h.request();
  h.state.snapshot.adActive = false;
  h.state.snapshot.runId = null;
  inject = true;
  await h.request();
  assert.deepEqual(h.state.tab.mutedInfo, { muted: true, reason: "user" });
  assert.equal(updates(h).length, 1);
});
