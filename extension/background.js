"use strict";
importScripts("ad-audio.js");
// The click path runs in the document. This worker only owns audio.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "YAS_SYNC_AD_AUDIO") return;
  YASAdAudio.handleMessage(message, sender).then(sendResponse, error => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });
  return true;
});
