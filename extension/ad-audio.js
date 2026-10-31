"use strict";

// Audio is a tab-level overlay. Never write the player's volume or muted
// preference, and never remove a mute owned by the user or another extension.
const YASAdAudio = (() => {
  const queues = new Map();
  let eventSequence = 0;

  function allowedSource(raw) {
    try {
      const url = new URL(raw);
      return url.origin === "https://www.youtube.com" && !url.username && !url.password;
    } catch { return false; }
  }

  function matchesVideo(raw, videoId) {
    try {
      const url = new URL(raw);
      return allowedSource(raw) && url.pathname === "/watch" &&
        url.searchParams.get("v") === videoId;
    } catch { return false; }
  }

  function ownsMute(tab) {
    const info = tab?.mutedInfo;
    return info?.muted === true && info.reason === "extension" &&
      info.extensionId === chrome.runtime.id;
  }

  function validRequest(message, sender) {
    return sender?.id === chrome.runtime.id && sender.frameId === 0 &&
      Number.isInteger(sender.tab?.id) && sender.tab.id >= 0 &&
      allowedSource(sender.url) &&
      (!sender.origin || sender.origin === "https://www.youtube.com") &&
      typeof message.requestId === "string" && message.requestId.length > 0 &&
      message.requestId.length <= 160 &&
      (sender.documentId === undefined || (typeof sender.documentId === "string" &&
        sender.documentId.length > 0 && sender.documentId.length <= 160));
  }

  function validSnapshot(snapshot, requestId) {
    return snapshot?.ok === true && snapshot.requestId === requestId &&
      snapshot.version === chrome.runtime.getManifest().version &&
      typeof snapshot.adActive === "boolean" && typeof snapshot.visible === "boolean" &&
      typeof snapshot.userOverride === "boolean" &&
      typeof snapshot.ownedAcknowledged === "boolean" &&
      typeof snapshot.videoId === "string" &&
      (snapshot.videoId === "" || /^[A-Za-z0-9_-]{1,80}$/.test(snapshot.videoId)) &&
      (snapshot.runId === null || (typeof snapshot.runId === "string" &&
        snapshot.runId.length > 0 && snapshot.runId.length <= 160)) &&
      (!snapshot.adActive || (snapshot.runId !== null && snapshot.videoId !== ""));
  }

  async function query(tabId, requestId, documentId) {
    try {
      const options = { frameId: 0 };
      if (documentId) options.documentId = documentId;
      const snapshot = await chrome.tabs.sendMessage(tabId, {
        type: "YAS_QUERY_AD_AUDIO", requestId
      }, options);
      return validSnapshot(snapshot, requestId) ? snapshot : null;
    } catch { return null; }
  }

  function result(snapshot, tab, reason, userOverride = snapshot?.userOverride || false) {
    return { ok: true, runId: snapshot?.runId ?? null,
      mutedByExtension: ownsMute(tab), userOverride, reason };
  }

  async function releaseOwned(tabId) {
    // Refresh immediately before changing audio. A user's newer mute wins.
    const tab = await chrome.tabs.get(tabId);
    if (!ownsMute(tab)) return tab;
    return await chrome.tabs.update(tabId, { muted: false });
  }

  async function notifyOverride(tabId, snapshot, documentId) {
    if (!snapshot?.adActive || !snapshot.runId) return;
    const options = { frameId: 0 };
    if (documentId) options.documentId = documentId;
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "YAS_AUDIO_USER_OVERRIDE", runId: snapshot.runId
      }, options);
    } catch { /* The run/document may already have ended. */ }
  }

  async function missingDocument(tabId, requestId, previousSnapshot) {
    const tab = await chrome.tabs.get(tabId);
    if (allowedSource(tab.url) && !tab.pendingUrl) {
      const current = await query(tabId, requestId);
      // An old document must not unmute a different document's current ad.
      if (current?.adActive && matchesVideo(tab.url, current.videoId)) {
        return { ok: false, error: "audio_document_changed", runId: current.runId };
      }
    }
    return result(previousSnapshot, await releaseOwned(tabId), "audio_document_gone");
  }

  async function reconcile(tabId, requestId, documentId) {
    let tab = await chrome.tabs.get(tabId);
    // Ownership is the only authority needed to clean up after leaving YouTube.
    if (!allowedSource(tab.url) || tab.pendingUrl) {
      return result(null, await releaseOwned(tabId), "navigation_cleanup");
    }
    const before = await query(tabId, requestId, documentId);
    if (!before) return missingDocument(tabId, requestId);
    const snapshot = await query(tabId, requestId, documentId);
    tab = await chrome.tabs.get(tabId);
    if (!snapshot) return missingDocument(tabId, requestId, before);
    if (!allowedSource(tab.url) || tab.pendingUrl) {
      return result(snapshot, await releaseOwned(tabId), "navigation_cleanup");
    }
    if (before.runId !== snapshot.runId || before.adActive !== snapshot.adActive ||
        before.videoId !== snapshot.videoId) {
      return { ok: false, error: "audio_run_changed", runId: snapshot.runId };
    }
    if (snapshot.videoId && !matchesVideo(tab.url, snapshot.videoId)) {
      return missingDocument(tabId, requestId, snapshot);
    }
    if (!snapshot.adActive) {
      // A foreground check is intentionally absent: background/closed-player
      // cleanup must restore the user's audio just as foreground cleanup does.
      return result(snapshot, await releaseOwned(tabId), "ad_ended");
    }
    if (snapshot.userOverride) {
      return result(snapshot, await releaseOwned(tabId), "user_override", true);
    }
    if (snapshot.ownedAcknowledged && !ownsMute(tab)) {
      await notifyOverride(tabId, snapshot, documentId);
      return result(snapshot, tab, "user_override", true);
    }
    if (ownsMute(tab)) return result(snapshot, tab, "ad_muted");
    if (tab.mutedInfo?.muted) return result(snapshot, tab, "preserved_existing_mute");
    // A validated ad in this document is eligible even when its tab/window is
    // in the background. Ownership and user overrides above remain decisive.
    // Only this single property is accepted; message-supplied tab IDs, volume,
    // URLs or commands never reach a browser mutation API.
    tab = await chrome.tabs.update(tabId, { muted: true });
    return result(snapshot, tab, "ad_muted");
  }

  function enqueue(tabId, operation) {
    const previous = queues.get(tabId) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation).catch(error => ({
      ok: false, error: "audio_update_failed", detail: String(error?.message || error)
    }));
    queues.set(tabId, next);
    next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); });
    return next;
  }

  function handleMessage(message, sender) {
    if (message?.type !== "YAS_SYNC_AD_AUDIO") return;
    if (!validRequest(message, sender)) {
      return Promise.resolve({ ok: false, error: "invalid_audio_sender_or_request" });
    }
    return enqueue(sender.tab.id, () => reconcile(sender.tab.id, message.requestId, sender.documentId));
  }

  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    const info = changeInfo.mutedInfo;
    const externalAudioChange = info &&
      !(info.reason === "extension" && info.extensionId === chrome.runtime.id);
    const navigationChange = typeof changeInfo.url === "string" ||
      changeInfo.status === "loading" || changeInfo.status === "complete";
    if (!externalAudioChange && !navigationChange) return;
    const requestId = `audio-event:${++eventSequence}`;
    enqueue(tabId, async () => {
      const tab = await chrome.tabs.get(tabId);
      if (!allowedSource(tab.url) || tab.pendingUrl) {
        return result(null, await releaseOwned(tabId), "navigation_cleanup");
      }
      if (externalAudioChange) {
        const snapshot = await query(tabId, requestId);
        await notifyOverride(tabId, snapshot);
      }
      return reconcile(tabId, requestId);
    });
  });
  chrome.tabs.onRemoved?.addListener(tabId => queues.delete(tabId));

  return Object.freeze({ handleMessage });
})();
