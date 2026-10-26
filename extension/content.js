(() => {
  "use strict";

  // This global lives in Chrome's isolated content-script world, not the page.
  if (globalThis.__youtubeAdAutoSkip) return;

  const VERSION = chrome.runtime.getManifest().version;
  const EXTENSION_ID = chrome.runtime.id;
  const PREFIX = "[YouTube Auto Skip]";
  const SELECTORS = [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button"
  ];
  const MAX_ATTEMPTS = 4;
  const VERIFY_TIMEOUT = 1800;
  const RETRY_DELAYS = [0, 1500, 3000, 5000];
  const events = [];
  const state = {
    enabled: true,
    ready: true,
    disposed: false,
    stopReason: null,
    state: "initializing",
    message: "正在启动自动检测",
    videoId: "",
    adActive: false,
    adEpisode: 0,
    episodeAttempts: 0,
    clickAttempts: 0,
    pageDispatches: 0,
    lastPageClickError: null,
    confirmedTransitions: 0,
    failedVerifications: 0,
    lastAttemptAt: null,
    lastConfirmedAt: null,
    audioRunId: null,
    audioMutedByExtension: false,
    audioUserOverride: false,
    audioOwnedAcknowledged: false,
    lastAudioError: null
  };
  let boundPlayer = null;
  let source = "";
  let adIndex = "";
  let lastMediaTime = null;
  let pending = null;
  let nextAttemptAt = 0;
  let candidate = null;
  let candidateSince = 0;
  let scanTimer = null;
  let lastScanAt = 0;
  let pollTimer = null;
  let observer = null;
  const audioDocumentToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  let audioRunCounter = 0;
  let audioRunVideoId = "";
  let audioBusy = false;
  let audioResyncWanted = false;
  let audioLastKey = "";
  let audioNextSyncAt = 0;
  let audioRequestCounter = 0;

  function runtimeIsValid() {
    try {
      return typeof EXTENSION_ID === "string" && EXTENSION_ID.length > 0 &&
        chrome.runtime.id === EXTENSION_ID && chrome.runtime.getManifest().version === VERSION;
    } catch {
      return false;
    }
  }

  function dispose(reason) {
    if (state.disposed) return;
    state.disposed = true;
    state.ready = false;
    state.stopReason = reason;
    state.adActive = false;
    pending = null;
    candidate = null;
    if (scanTimer !== null) clearTimeout(scanTimer);
    if (pollTimer !== null) clearInterval(pollTimer);
    scanTimer = null;
    pollTimer = null;
    observer?.disconnect();
    document.removeEventListener("yt-navigate-finish", onPageChanged);
    document.removeEventListener("visibilitychange", onPageChanged);
    document.removeEventListener("pointerdown", onUserAudioControl, true);
    document.removeEventListener("click", onUserAudioControl, true);
    document.removeEventListener("keydown", onUserAudioKey, true);
    try { chrome.runtime.onMessage.removeListener(onRuntimeMessage); } catch { /* Invalid context. */ }
    setStatus("stopped", "扩展已停用或重新加载；重新启用后请刷新视频页");
    record("stopped", { reason });
  }

  function ensureActive() {
    if (state.disposed) return false;
    if (runtimeIsValid()) return true;
    dispose("extension_context_invalidated");
    return false;
  }

  function record(type, detail = {}) {
    const entry = { at: new Date().toISOString(), type, ...detail };
    events.push(entry);
    if (events.length > 50) events.shift();
    console.info(PREFIX, type, detail);
  }

  function setStatus(name, message) {
    state.state = name;
    state.message = message;
  }

  function getStatus() {
    return {
      version: VERSION,
      ...state,
      recentEvents: events.map((entry) => ({ ...entry }))
    };
  }

  Object.defineProperty(globalThis, "__youtubeAdAutoSkip", {
    value: Object.freeze({ getStatus }),
    configurable: false,
    writable: false
  });

  function currentVideoId() {
    if (location.pathname !== "/watch") return "";
    return new URL(location.href).searchParams.get("v") || "";
  }

  // Audio is a separate operation from skipping. A run lasts through adjacent
  // ads, so a person's choice is not reset when only the ad source changes.
  function observeAdAudio() {
    const videoId = currentVideoId();
    const player = document.querySelector("#movie_player.html5-video-player");
    const adActive = Boolean(videoId && player && (
      player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")
    ));
    if (adActive && (!state.audioRunId || audioRunVideoId !== videoId)) {
      state.audioRunId = `${audioDocumentToken}:${++audioRunCounter}`;
      audioRunVideoId = videoId;
      state.audioUserOverride = false;
      state.audioOwnedAcknowledged = false;
      record("ad_audio_run_started", { runId: state.audioRunId });
    } else if (!adActive && state.audioRunId !== null &&
        (player || !videoId || audioRunVideoId !== videoId)) {
      record("ad_audio_run_ended", { runId: state.audioRunId });
      state.audioRunId = null;
      audioRunVideoId = "";
      state.audioUserOverride = false;
      state.audioOwnedAcknowledged = false;
    }
    return {
      videoId,
      runId: state.audioRunId,
      adActive,
      visible: document.visibilityState === "visible",
      userOverride: state.audioUserOverride,
      ownedAcknowledged: state.audioOwnedAcknowledged
    };
  }

  function adAudioKey(observed) {
    return `${observed.videoId}|${observed.runId || ""}|${observed.adActive}|${observed.visible}|${observed.userOverride}`;
  }

  function syncAdAudio(force = false) {
    if (!ensureActive()) return;
    const observed = observeAdAudio();
    const key = adAudioKey(observed);
    if (audioBusy) {
      if (force || key !== audioLastKey) audioResyncWanted = true;
      return;
    }
    const now = performance.now();
    if (!force && key === audioLastKey && (
      now < audioNextSyncAt ||
      (!observed.adActive && !state.audioMutedByExtension && !state.lastAudioError)
    )) return;
    audioBusy = true;
    audioLastKey = key;
    audioNextSyncAt = now + 5000;
    const requestId = `audio:${audioDocumentToken}:${++audioRequestCounter}`;
    let request;
    try {
      request = chrome.runtime.sendMessage({ type: "YAS_SYNC_AD_AUDIO", requestId });
    } catch (error) {
      request = Promise.reject(error);
    }
    Promise.resolve(request).then((result) => {
      if (!ensureActive()) return;
      const current = observeAdAudio();
      if (result?.ok && result.runId === current.runId) {
        const wasOwned = state.audioMutedByExtension;
        state.audioMutedByExtension = result.mutedByExtension === true;
        // A missing player can be a brief rerender, not a new ad run. Keep a
        // person's override, but do not mistake our temporary release for one.
        if (!current.adActive && !state.audioMutedByExtension) state.audioOwnedAcknowledged = false;
        if (current.adActive && state.audioMutedByExtension) state.audioOwnedAcknowledged = true;
        if (current.adActive && result.userOverride) state.audioUserOverride = true;
        state.lastAudioError = null;
        if (!wasOwned && state.audioMutedByExtension) record("ad_audio_muted");
        if (wasOwned && !state.audioMutedByExtension) record("ad_audio_restored", { reason: result.reason });
      } else if (result?.ok) {
        audioResyncWanted = true;
      } else {
        const error = result?.error || "audio_sync_failed";
        if (state.lastAudioError !== error) record("ad_audio_failed", { error });
        state.lastAudioError = error;
        audioNextSyncAt = performance.now() + 1000;
      }
    }).catch((error) => {
      if (!ensureActive()) return;
      const detail = String(error?.message || error);
      if (state.lastAudioError !== detail) record("ad_audio_failed", { error: detail });
      state.lastAudioError = detail;
      audioNextSyncAt = performance.now() + 1000;
    }).finally(() => {
      audioBusy = false;
      if (!state.disposed && audioResyncWanted) {
        audioResyncWanted = false;
        scheduleScan(0);
      }
    });
  }

  function userTakesAudioControl() {
    if (!ensureActive() || !observeAdAudio().adActive || state.audioUserOverride) return;
    state.audioUserOverride = true;
    record("ad_audio_user_override");
    syncAdAudio(true);
  }

  function onUserAudioControl(event) {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest(".ytp-mute-button, .ytp-volume-panel, .ytp-volume-slider, .ytp-volume-area");
    if (control?.closest("#movie_player.html5-video-player")) userTakesAudioControl();
  }

  function onUserAudioKey(event) {
    if (!event.isTrusted || event.ctrlKey || event.metaKey || event.altKey ||
        !(event.target instanceof Element) ||
        event.target.closest("input, textarea, select, [contenteditable='true']")) return;
    const player = document.querySelector("#movie_player.html5-video-player");
    const targetInPlayer = Boolean(player?.contains(event.target));
    const muteKey = event.key.toLowerCase() === "m" &&
      (targetInPlayer || event.target === document.body || event.target === document.documentElement);
    const volumeKey = targetInPlayer && ["ArrowUp", "ArrowDown"].includes(event.key);
    if (muteKey || volumeKey) userTakesAudioControl();
  }

  function resetEpisode() {
    state.adEpisode += 1;
    state.episodeAttempts = 0;
    nextAttemptAt = 0;
    candidate = null;
    candidateSince = 0;
  }

  function resetVideo(videoId) {
    if (pending) record("verification_cancelled", { reason: "video_changed" });
    pending = null;
    state.videoId = videoId;
    state.adActive = false;
    boundPlayer = null;
    source = "";
    adIndex = "";
    lastMediaTime = null;
    resetEpisode();
    record("video_changed", { videoId });
  }

  // A hidden ancestor is as significant as a hidden button. Checking the full
  // ancestry excludes YouTube's pre-rendered, not-yet-available skip control.
  function isVisible(element, player) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom <= 0 || rect.right <= 0 ||
        rect.top >= innerHeight || rect.left >= innerWidth) return false;
    let node = element;
    while (node instanceof HTMLElement) {
      if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility !== "visible" ||
          Number(style.opacity) === 0) return false;
      if (node === player) break;
      node = node.parentElement;
    }
    return true;
  }

  function isAvailable(button, player) {
    if (!isVisible(button, player) || getComputedStyle(button).pointerEvents === "none" || button.matches(":disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        button.hasAttribute("disabled")) return false;
    // Never click a wrapper, countdown, advertiser link, or arbitrary button
    // found by matching broad words such as "skip" in the page text.
    if (!(button instanceof HTMLButtonElement) &&
        button.getAttribute("role") !== "button") return false;
    if (button.closest("a")) return false;

    // innerText excludes hidden legacy countdown text retained inside a button.
    const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`;
    if (/\b(?:skip|video)\b[^.\n]{0,50}\bin\s+\d|\b(?:available|skip).*?\b\d+\s*(?:seconds?|secs?)\b|\d+\s*秒后|あと\s*\d+\s*秒/i.test(label)) return false;

    const countdowns = button.querySelectorAll(
      ".ytp-ad-preview-text, .ytp-ad-skip-button-countdown, .ytp-skip-ad-button__countdown"
    );
    for (const countdown of countdowns) {
      if (isVisible(countdown, player)) return false;
    }
    return getClickPoint(button) !== null;
  }

  function getClickPoint(button) {
    const rect = button.getBoundingClientRect();
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(innerWidth, rect.right);
    const bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) return null;
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === button || button.contains(hit)) ? { x, y } : null;
  }

  function preparePageClick(message) {
    if (!ensureActive() || !pending ||
        pending.stage !== "dispatching" ||
        message.requestId !== pending.requestId ||
        message.videoId !== state.videoId || message.videoId !== currentVideoId() ||
        message.episode !== state.adEpisode || document.visibilityState !== "visible") {
      return { ok: false, error: "stale_request" };
    }
    const player = document.querySelector("#movie_player.html5-video-player");
    if (player !== boundPlayer || !player || !(
      player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")
    )) return { ok: false, error: "ad_changed" };
    const media = player.querySelector("video.html5-main-video, video");
    const currentSource = media?.currentSrc || media?.src || "";
    const currentIndex = readAdIndex(player);
    if ((source && currentSource && currentSource !== source) ||
        (adIndex && currentIndex && currentIndex !== adIndex)) {
      return { ok: false, error: "ad_changed" };
    }
    const button = findSkipButton(player);
    const point = button && getClickPoint(button);
    if (!point) return { ok: false, error: "skip_not_available" };
    return {
      ok: true,
      requestId: message.requestId,
      videoId: state.videoId,
      episode: state.adEpisode,
      ...point,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      preparedAt: Date.now()
    };
  }

  function dispatchPageClick(attempt) {
    if (!ensureActive()) return;
    const prepared = preparePageClick({
      requestId: attempt.requestId, videoId: state.videoId, episode: attempt.episode
    });
    const button = prepared.ok && findSkipButton(boundPlayer);
    if (!prepared.ok || !button) {
      state.lastPageClickError = prepared.error || "skip_not_available";
      record("page_click_failed", { error: state.lastPageClickError });
      pending = null;
      scheduleScan(100);
      return;
    }
    try {
      // MAIN-world listeners registered at document_start provide the narrowly
      // scoped compatibility handling; the browser event remains synthetic.
      // Reuse the production control checks immediately before this click.
      button.setAttribute("data-yas-page-click", "1");
      try { button.click(); }
      finally { button.removeAttribute("data-yas-page-click"); }
      state.pageDispatches += 1;
      state.lastPageClickError = null;
      attempt.at = performance.now();
      attempt.stage = "dispatched";
      record("page_click_dispatched", { episode: attempt.episode, currentVideoId: state.videoId });
    } catch (error) {
      state.lastPageClickError = String(error?.message || error);
      record("page_click_failed", { error: state.lastPageClickError });
      pending = null;
    }
    scheduleScan(100);
  }

  function findSkipButton(player) {
    for (const selector of SELECTORS) {
      for (const button of player.querySelectorAll(selector)) {
        if (isAvailable(button, player)) return button;
      }
    }
    return null;
  }

  function readAdIndex(player) {
    const nodes = player.querySelectorAll(".ytp-ad-text, .ytp-ad-simple-ad-badge");
    for (const node of nodes) {
      if (!isVisible(node, player)) continue;
      const text = (node.textContent || "").trim();
      const match = text.match(/(?:\bAd\s*)?(\d+)\s*(?:of|\/|共)\s*(\d+)|第\s*(\d+)\s*条.*?共\s*(\d+)\s*条/i);
      if (match) return `${match[1] || match[3]}/${match[2] || match[4]}`;
    }
    return "";
  }

  function confirmTransition(reason) {
    if (!pending) return;
    state.confirmedTransitions += 1;
    state.lastConfirmedAt = new Date().toISOString();
    record("transition_observed", {
      reason,
      episode: pending.episode,
      elapsedMs: Math.round(performance.now() - pending.at)
    });
    pending = null;
  }

  function scan() {
    scanTimer = null;
    lastScanAt = performance.now();
    if (!ensureActive()) return;
    syncAdAudio();
    const videoId = currentVideoId();
    if (videoId !== state.videoId) resetVideo(videoId);
    if (!videoId) {
      setStatus("waiting_video", "已启用，等待打开 YouTube 视频");
      return;
    }

    const player = document.querySelector("#movie_player.html5-video-player");
    if (!player) {
      setStatus("waiting_player", "已启用，等待播放器加载");
      return;
    }
    const playerReplaced = boundPlayer !== null && player !== boundPlayer;
    if (player !== boundPlayer) {
      boundPlayer = player;
      candidate = null;
      candidateSince = 0;
      // A replacement player is not proof that a preceding click worked.
      if (pending) record("verification_cancelled", { reason: "player_replaced" });
      pending = null;
      // Keep the existing ad identity, backoff and attempt budget across a DOM
      // rerender. Only actual video/ad changes below may reset that budget.
      if (playerReplaced) record("player_replaced", { episode: state.adEpisode });
    }

    const adActive = player.classList.contains("ad-showing") ||
      player.classList.contains("ad-interrupting");
    // Count an ad transition only after the click operation was dispatched.
    if (!adActive && pending?.stage === "dispatching") {
        setStatus("dispatching", "正在点击广告跳过按钮");
      return;
    }
    if (!adActive) {
      if (state.adActive) {
        confirmTransition("ad_state_ended");
        record("ad_ended");
      }
      state.adActive = false;
      source = "";
      adIndex = "";
      lastMediaTime = null;
      candidate = null;
      setStatus("content", "已启用，正文播放中；等待广告");
      return;
    }

    const media = player.querySelector("video.html5-main-video, video");
    const nextSource = media?.currentSrc || media?.src || "";
    const nextIndex = readAdIndex(player);
    const mediaTime = Number.isFinite(media?.currentTime) ? media.currentTime : null;
    const changed = state.adActive && (
      (nextSource && source && nextSource !== source) ||
      (nextIndex && adIndex && nextIndex !== adIndex) ||
      (!playerReplaced && mediaTime !== null && lastMediaTime !== null && mediaTime + 2 < lastMediaTime)
    );
    if (changed && pending?.stage === "dispatching") {
        setStatus("dispatching", "正在点击广告跳过按钮");
      return;
    }
    if (!state.adActive || changed) {
      if (changed) confirmTransition("next_ad_observed");
      resetEpisode();
      record(changed ? "ad_changed" : "ad_started", { episode: state.adEpisode });
    }
    state.adActive = true;
    // A replacement video can briefly expose no src before it is reattached.
    // Preserve the last known source so a later real source change is detected.
    source = nextSource || source;
    adIndex = nextIndex || adIndex;
    lastMediaTime = mediaTime;

    const now = performance.now();
    if (pending) {
      if (pending.stage === "dispatching") {
        setStatus("dispatching", "正在点击广告跳过按钮");
        return;
      }
      if (now - pending.at < VERIFY_TIMEOUT) {
        setStatus("verifying", "已点击跳过，正在确认广告状态");
        return;
      }
      state.failedVerifications += 1;
      record("click_not_confirmed", { episode: pending.episode });
      pending = null;
    }
    if (state.episodeAttempts >= MAX_ATTEMPTS) {
      setStatus("retry_limit", "本条广告已达到重试上限，等待广告变化");
      return;
    }

    const button = findSkipButton(player);
    if (!button) {
      candidate = null;
      setStatus("waiting_skip", "检测到广告，等待可用的跳过按钮");
      return;
    }
    if (now < nextAttemptAt) {
      setStatus("retry_wait", state.lastPageClickError
        ? "跳过操作未能发出，等待后重试"
        : "上次点击尚未确认，等待后重试");
      return;
    }
    if (button !== candidate) {
      candidate = button;
      candidateSince = now;
      scheduleScan(150);
      setStatus("skip_ready", "跳过按钮已出现，正在确认可用状态");
      return;
    }
    if (now - candidateSince < 120) {
      scheduleScan(150);
      return;
    }

    // Recheck immediately before the only action performed by this extension.
    if (!isAvailable(button, player) || !(
      player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")
    )) return;
    if (!ensureActive()) return;
    state.episodeAttempts += 1;
    state.clickAttempts += 1;
    state.lastAttemptAt = new Date().toISOString();
    pending = {
      at: now,
      episode: state.adEpisode,
      stage: "dispatching",
      requestId: `${state.adEpisode}:${state.clickAttempts}:${Date.now()}`
    };
    nextAttemptAt = now + VERIFY_TIMEOUT + RETRY_DELAYS[state.episodeAttempts - 1];
    record("click_attempt", {
      episode: state.adEpisode,
      attempt: state.episodeAttempts,
      buttonClass: button.className
    });
    setStatus("dispatching", "正在点击广告跳过按钮");
    dispatchPageClick(pending);
    scheduleScan(200);
  }

  function scheduleScan(delay = 100) {
    if (!ensureActive()) return;
    if (scanTimer !== null) return;
    const wait = Math.max(delay, 100 - (performance.now() - lastScanAt));
    scanTimer = setTimeout(scan, wait);
  }

  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "disabled", "aria-disabled", "aria-hidden", "aria-label"]
  });
  pollTimer = setInterval(() => scheduleScan(0), 1000);
  function onPageChanged() { scheduleScan(0); }
  document.addEventListener("yt-navigate-finish", onPageChanged);
  document.addEventListener("visibilitychange", onPageChanged);
  document.addEventListener("pointerdown", onUserAudioControl, true);
  document.addEventListener("click", onUserAudioControl, true);
  document.addEventListener("keydown", onUserAudioKey, true);

  function onRuntimeMessage(message, sender, sendResponse) {
    if (!ensureActive()) return;
    if (message?.type === "YAS_STATUS") sendResponse(getStatus());
    if (message?.type === "YAS_QUERY_AD_AUDIO") {
      sendResponse(sender.id === chrome.runtime.id && typeof message.requestId === "string" && message.requestId.length <= 160
        ? { ok: true, requestId: message.requestId, version: VERSION, ...observeAdAudio() }
        : { ok: false, error: "invalid_sender" });
    }
    if (message?.type === "YAS_AUDIO_USER_OVERRIDE") {
      const observed = observeAdAudio();
      const valid = sender.id === chrome.runtime.id && observed.adActive && message.runId === observed.runId;
      if (valid && !state.audioUserOverride) {
        state.audioUserOverride = true;
        record("ad_audio_user_override");
        scheduleScan(0);
      }
      sendResponse({ ok: valid });
    }
  }
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  record("started", { version: VERSION });
  scheduleScan(0);
})();
