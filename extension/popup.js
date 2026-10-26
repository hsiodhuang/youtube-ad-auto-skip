"use strict";

const status = document.querySelector("#status");
const attempts = document.querySelector("#attempts");
const confirmed = document.querySelector("#confirmed");
const events = document.querySelector("#events");
const diagnostics = document.querySelector("#diagnostics");
document.querySelector("#version").textContent = `版本 ${chrome.runtime.getManifest().version} · 本页计数，刷新后重置`;

const names = {
  started: "自动检测已启动",
  video_changed: "视频已切换",
  ad_started: "检测到广告",
  ad_changed: "检测到下一条广告",
  ad_ended: "广告结束",
  click_attempt: "尝试点击跳过",
  transition_observed: "点击后观察到广告变化",
  click_not_confirmed: "点击尚未确认生效",
  verification_cancelled: "页面变化，中止本次结果确认",
  player_replaced: "播放器已重新加载，保留当前重试额度",
  page_click_dispatched: "网页兼容点击已派发，等待广告结果",
  page_click_failed: "网页兼容点击未能派发",
  stopped: "扩展已停止检测",
  ad_audio_run_started: "开始处理广告声音",
  ad_audio_run_ended: "广告结束，恢复原声音状态",
  ad_audio_muted: "广告已自动静音",
  ad_audio_restored: "已保留或恢复原声音状态",
  ad_audio_user_override: "保留你手动选择的声音状态",
  ad_audio_failed: "广告静音操作暂未完成"
};

async function refresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no_tab");
    const data = await chrome.tabs.sendMessage(tab.id, { type: "YAS_STATUS" });
    if (!data) throw new Error("no_content_script");
    status.textContent = data.adActive && data.audioMutedByExtension
      ? `广告已静音；${data.message}` : data.message;
    attempts.textContent = data.clickAttempts;
    confirmed.textContent = data.confirmedTransitions;
    diagnostics.textContent = JSON.stringify(data, null, 2);
    events.textContent = data.recentEvents.slice(-10).reverse().map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString("zh-CN", { hour12: false });
      return `${time} ${names[entry.type] || entry.type}${entry.attempt ? `（第 ${entry.attempt} 次）` : ""}${entry.error ? `：${entry.error}` : ""}`;
    }).join("\n") || "暂无记录";
  } catch {
    status.textContent = "请打开 YouTube 视频；安装或重新启用后，已打开的视频页需要刷新一次。";
    attempts.textContent = "—";
    confirmed.textContent = "—";
    diagnostics.textContent = "当前标签页未连接";
    events.textContent = "当前标签页未连接";
  }
}

refresh();
setInterval(refresh, 1000);
