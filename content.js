(() => {
  "use strict";

  const DEFAULT_SETTINGS = { enabled: true, limit: 10, showBadge: true };
  const TOOL_LABEL_RE = /(?:^|\s)(工具调用|Tool\s*call)\s*(\d+)\s*[：:]/i;
  const STORAGE_KEY = "cgToolCallLimiterSettings";
  const LOCAL_STATS_KEY = "cgToolCallLimiterStats";
  const CARD_MARK = "data-cg-tool-limiter-card";
  const HIDDEN_CLASS = "cg-tool-limiter-hidden";
  const BADGE_ID = "cg-tool-limiter-badge";

  let settings = { ...DEFAULT_SETTINGS };
  let temporaryRevealAll = false;
  let applyTimer = 0;
  let badgeEl = null;
  let lastStats = {
    total: 0,
    visible: 0,
    hidden: 0,
    limit: DEFAULT_SETTINGS.limit,
    enabled: DEFAULT_SETTINGS.enabled,
    revealAll: false,
    updatedAt: Date.now()
  };

  const storage = globalThis.chrome?.storage;
  const runtime = globalThis.chrome?.runtime;

  function normalizeText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function clampLimit(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.limit;
    return Math.min(100, Math.max(1, n));
  }

  function loadSettings() {
    return new Promise((resolve) => {
      if (!storage?.sync) {
        resolve({ ...DEFAULT_SETTINGS });
        return;
      }
      storage.sync.get([STORAGE_KEY], (result) => {
        const saved = result?.[STORAGE_KEY] || {};
        resolve({
          ...DEFAULT_SETTINGS,
          ...saved,
          limit: clampLimit(saved.limit ?? DEFAULT_SETTINGS.limit),
          enabled: saved.enabled !== false,
          showBadge: saved.showBadge !== false
        });
      });
    });
  }

  function saveSettings(nextSettings) {
    settings = {
      ...DEFAULT_SETTINGS,
      ...nextSettings,
      limit: clampLimit(nextSettings.limit),
      enabled: nextSettings.enabled !== false,
      showBadge: nextSettings.showBadge !== false
    };
    if (storage?.sync) storage.sync.set({ [STORAGE_KEY]: settings });
    scheduleApply(0);
  }

  function parseToolLabel(el) {
    const text = normalizeText(el?.textContent || "");
    const match = text.match(TOOL_LABEL_RE);
    if (!match) return null;
    return { text, number: Number.parseInt(match[2], 10) || 0 };
  }

  function findToolCardFromLabel(labelEl) {
    const button = labelEl.closest?.("button[aria-controls]") || labelEl.closest?.("button");
    if (button) {
      const header = button.closest?.("div[class*='sticky'], div[class*='bg-token-bg-elevated-secondary']") || button.parentElement;
      const card = header?.parentElement;
      if (card && card !== document.body && card !== document.documentElement) return card;
    }

    let node = labelEl;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      if (node instanceof HTMLElement && node.matches("div[class*='border-b'], span[class*='tool-message']")) {
        return node;
      }
    }
    return labelEl.parentElement || labelEl;
  }

  function uniqueNodes(nodes) {
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      out.push(node);
    }
    return out;
  }

  function collectLabelCandidates() {
    const selectors = [
      "span.font-mono",
      "div.font-mono",
      "[class~='font-mono']",
      "span.truncate",
      "button[aria-controls]"
    ];
    return uniqueNodes(document.querySelectorAll(selectors.join(",")));
  }

  function collectToolCards() {
    const records = [];
    const seenCards = new Set();
    for (const labelEl of collectLabelCandidates()) {
      const label = parseToolLabel(labelEl);
      if (!label) continue;
      const card = findToolCardFromLabel(labelEl);
      if (!(card instanceof HTMLElement) || seenCards.has(card)) continue;
      card.setAttribute(CARD_MARK, "true");
      seenCards.add(card);
      records.push({ card, label });
    }

    // DOM 顺序最接近“最新工具调用”的实际展示顺序，避免只依赖工具编号。
    records.sort((a, b) => {
      if (a.card === b.card) return 0;
      const pos = a.card.compareDocumentPosition(b.card);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return a.label.number - b.label.number;
    });
    return records;
  }

  function setHidden(card, hidden) {
    card.classList.toggle(HIDDEN_CLASS, hidden);
    if (hidden) card.setAttribute("aria-hidden", "true");
    else card.removeAttribute("aria-hidden");
  }

  function clearHiddenCards() {
    document.querySelectorAll(`[${CARD_MARK}].${HIDDEN_CLASS}`).forEach((card) => setHidden(card, false));
  }

  function updateStats(stats) {
    lastStats = { ...stats, updatedAt: Date.now() };
    if (storage?.local) storage.local.set({ [LOCAL_STATS_KEY]: lastStats });
    updateBadge();
  }

  function ensureBadge() {
    if (badgeEl && document.documentElement.contains(badgeEl)) return badgeEl;
    badgeEl = document.createElement("button");
    badgeEl.id = BADGE_ID;
    badgeEl.type = "button";
    badgeEl.title = "点击切换：临时显示全部 / 恢复只显示最新工具调用";
    badgeEl.addEventListener("click", () => {
      temporaryRevealAll = !temporaryRevealAll;
      scheduleApply(0);
    });
    document.documentElement.appendChild(badgeEl);
    return badgeEl;
  }

  function updateBadge() {
    if (!settings.showBadge || !settings.enabled || lastStats.total === 0) {
      if (badgeEl) badgeEl.remove();
      badgeEl = null;
      return;
    }
    const badge = ensureBadge();
    badge.classList.toggle("cg-tool-limiter-muted", temporaryRevealAll || lastStats.hidden === 0);
    if (temporaryRevealAll) {
      badge.textContent = `工具调用：已临时显示全部 ${lastStats.total} 个，点击恢复限流`;
    } else if (lastStats.hidden > 0) {
      badge.textContent = `工具调用：显示最新 ${lastStats.visible}/${lastStats.total}，隐藏 ${lastStats.hidden} 个`;
    } else {
      badge.textContent = `工具调用：${lastStats.total} 个，未超过限制 ${lastStats.limit}`;
    }
  }

  function applyLimit() {
    const records = collectToolCards();
    const total = records.length;
    const limit = clampLimit(settings.limit);
    const shouldLimit = settings.enabled && !temporaryRevealAll && total > limit;
    const firstVisibleIndex = shouldLimit ? Math.max(0, total - limit) : 0;

    clearHiddenCards();
    records.forEach((record, index) => setHidden(record.card, shouldLimit && index < firstVisibleIndex));

    const hidden = shouldLimit ? firstVisibleIndex : 0;
    updateStats({
      total,
      visible: total - hidden,
      hidden,
      limit,
      enabled: settings.enabled,
      revealAll: temporaryRevealAll
    });
  }

  function scheduleApply(delay = 160) {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(() => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(applyLimit, { timeout: 700 });
      else applyLimit();
    }, delay);
  }

  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          scheduleApply();
          return;
        }
        if (mutation.type === "attributes" && mutation.attributeName === "aria-expanded") {
          scheduleApply(80);
          return;
        }
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "hidden", "class"]
    });
  }

  function setupRuntimeMessages() {
    if (!runtime?.onMessage) return;
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "cgToolCallLimiter:getState") {
        sendResponse({ settings, stats: lastStats, ok: true });
        return true;
      }
      if (message?.type === "cgToolCallLimiter:setSettings") {
        temporaryRevealAll = false;
        saveSettings({ ...settings, ...(message.settings || {}) });
        sendResponse({ settings, stats: lastStats, ok: true });
        return true;
      }
      if (message?.type === "cgToolCallLimiter:toggleRevealAll") {
        temporaryRevealAll = !temporaryRevealAll;
        scheduleApply(0);
        sendResponse({ settings, stats: { ...lastStats, revealAll: temporaryRevealAll }, ok: true });
        return true;
      }
      if (message?.type === "cgToolCallLimiter:applyNow") {
        scheduleApply(0);
        sendResponse({ settings, stats: lastStats, ok: true });
        return true;
      }
      return false;
    });
  }

  async function init() {
    settings = await loadSettings();
    setupRuntimeMessages();
    setupMutationObserver();
    scheduleApply(0);
  }

  init().catch((error) => console.warn("[ChatGPT Tool Call Limiter] init failed", error));
})();
