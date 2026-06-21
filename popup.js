(() => {
  "use strict";

  const STORAGE_KEY = "cgToolCallLimiterSettings";
  const DEFAULT_SETTINGS = { enabled: true, limit: 10, showBadge: true };

  const els = {
    enabled: document.getElementById("enabled"),
    limit: document.getElementById("limit"),
    showBadge: document.getElementById("showBadge"),
    save: document.getElementById("save"),
    toggleReveal: document.getElementById("toggleReveal"),
    total: document.getElementById("total"),
    visible: document.getElementById("visible"),
    hidden: document.getElementById("hidden"),
    status: document.getElementById("status")
  };

  function clampLimit(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.limit;
    return Math.min(100, Math.max(1, n));
  }

  function setStatus(text) { els.status.textContent = text; }

  async function getActiveChatGPTTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    const url = tab.url || "";
    if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(url)) return null;
    return tab;
  }

  function sendMessage(tabId, message) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response || null);
      });
    });
  }

  function loadSavedSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get([STORAGE_KEY], (result) => {
        resolve({ ...DEFAULT_SETTINGS, ...(result?.[STORAGE_KEY] || {}) });
      });
    });
  }

  function render(settings, stats) {
    els.enabled.checked = settings.enabled !== false;
    els.limit.value = clampLimit(settings.limit);
    els.showBadge.checked = settings.showBadge !== false;
    els.total.textContent = stats?.total ?? "-";
    els.visible.textContent = stats?.visible ?? "-";
    els.hidden.textContent = stats?.hidden ?? "-";
    els.toggleReveal.textContent = stats?.revealAll ? "恢复限流" : "临时显示全部";
  }

  function readForm() {
    return {
      enabled: els.enabled.checked,
      limit: clampLimit(els.limit.value),
      showBadge: els.showBadge.checked
    };
  }

  async function saveAndApply() {
    const settings = readForm();
    await chrome.storage.sync.set({ [STORAGE_KEY]: settings });
    const tab = await getActiveChatGPTTab();
    if (!tab) {
      setStatus("设置已保存。打开 ChatGPT 页面后自动生效。");
      render(settings, null);
      return;
    }
    const response = await sendMessage(tab.id, { type: "cgToolCallLimiter:setSettings", settings });
    if (!response?.ok) {
      setStatus("设置已保存。刷新当前 ChatGPT 页面后生效。");
      render(settings, null);
      return;
    }
    setStatus("已应用到当前页面。");
    setTimeout(refresh, 180);
  }

  async function toggleRevealAll() {
    const tab = await getActiveChatGPTTab();
    if (!tab) {
      setStatus("当前不是 ChatGPT 页面。");
      return;
    }
    const response = await sendMessage(tab.id, { type: "cgToolCallLimiter:toggleRevealAll" });
    if (!response?.ok) {
      setStatus("当前页面未注入脚本，刷新 ChatGPT 后再试。");
      return;
    }
    setTimeout(refresh, 180);
  }

  async function refresh() {
    const saved = await loadSavedSettings();
    const tab = await getActiveChatGPTTab();
    if (!tab) {
      render(saved, null);
      setStatus("只在 chatgpt.com / chat.openai.com 页面生效。");
      return;
    }
    const response = await sendMessage(tab.id, { type: "cgToolCallLimiter:getState" });
    if (!response?.ok) {
      render(saved, null);
      setStatus("未连接到当前页面。刷新 ChatGPT 后自动生效。");
      return;
    }
    render(response.settings || saved, response.stats || null);
    setStatus("已连接到当前 ChatGPT 页面。");
  }

  els.save.addEventListener("click", saveAndApply);
  els.toggleReveal.addEventListener("click", toggleRevealAll);
  document.addEventListener("DOMContentLoaded", refresh);
  refresh();
})();
