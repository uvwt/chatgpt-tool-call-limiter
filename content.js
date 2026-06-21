(() => {
  "use strict";

  const DEFAULT_SETTINGS = { enabled: true, limit: 10, showBadge: true };
  const TOOL_LABEL_RE = /(?:^|\s)(工具调用|Tool\s*call)\s*(\d+)\s*[：:]/i;
  const STORAGE_KEY = "cgToolCallLimiterSettings";
  const LOCAL_STATS_KEY = "cgToolCallLimiterStats";
  const CARD_MARK = "data-cg-tool-limiter-card";
  const HIDDEN_CLASS = "cg-tool-limiter-hidden";
  const PREHIDDEN_CLASS = "cg-tool-limiter-prehidden";
  const BADGE_ID = "cg-tool-limiter-badge";
  const MODAL_ID = "cg-tool-limiter-modal";
  const NATIVE_LIST_LINK_CLASS = "cg-tool-limiter-native-list-link";
  const OPEN_LIST_RE = /(打开工具调用列表|Open\s*tool\s*call\s*list)/i;
  const TOOL_MESSAGE_SELECTORS = [
    "[data-message-author-role='tool']",
    "[data-testid*='tool-call' i]",
    "[data-testid*='tool_call' i]",
    "[data-testid*='tool' i]"
  ];

  let settings = { ...DEFAULT_SETTINGS };
  let temporaryRevealAll = false;
  let applyTimer = 0;
  let badgeEl = null;
  let observerStarted = false;
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

  function findNativeToolListLink(target) {
    const start = target instanceof Element ? target : target?.parentElement;
    const candidates = [];
    let node = start;
    for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if (node instanceof HTMLElement && (node.matches("button, a, [role='button']") || OPEN_LIST_RE.test(normalizeText(node.textContent)))) {
        candidates.push(node);
      }
    }
    for (const candidate of candidates) {
      const text = normalizeText(candidate.textContent || "");
      if (OPEN_LIST_RE.test(text)) return candidate;
    }
    return null;
  }

  function markNativeToolListLinks(root = document) {
    const scope = root instanceof Element || root === document ? root : document;
    const nodes = scope.querySelectorAll?.("button, a, [role='button'], span, div") || [];
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const text = normalizeText(node.textContent || "");
      if (!OPEN_LIST_RE.test(text)) continue;
      const link = findNativeToolListLink(node) || node;
      link.classList.add(NATIVE_LIST_LINK_CLASS);
      link.title = "已由扩展拦截：点击打开轻量工具调用列表，避免 ChatGPT 原生全量列表卡死页面";
    }
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

  function collectToolCardsFrom(root) {
    const records = [];
    const seenCards = new Set();
    const labels = root === document ? collectLabelCandidates() : collectLabelCandidatesFrom(root);
    for (const labelEl of labels) {
      const label = parseToolLabel(labelEl);
      if (!label) continue;
      const card = findToolCardFromLabel(labelEl);
      if (!(card instanceof HTMLElement) || seenCards.has(card)) continue;
      card.setAttribute(CARD_MARK, "true");
      seenCards.add(card);
      records.push({ card, label });
    }
    return records;
  }

  function collectLabelCandidatesFrom(root) {
    const selectors = [
      "span.font-mono",
      "div.font-mono",
      "[class~='font-mono']",
      "span.truncate",
      "button[aria-controls]"
    ];
    if (!(root instanceof Element)) return [];
    const nodes = [];
    if (root.matches(selectors.join(","))) nodes.push(root);
    nodes.push(...root.querySelectorAll(selectors.join(",")));
    return uniqueNodes(nodes);
  }

  function collectToolMessageRecords(root) {
    const scope = root instanceof Element || root === document ? root : document;
    const nodes = [];
    for (const selector of TOOL_MESSAGE_SELECTORS) {
      try {
        if (scope instanceof Element && scope.matches(selector)) nodes.push(scope);
        nodes.push(...(scope.querySelectorAll?.(selector) || []));
      } catch (_) {
        // 部分浏览器对 i 修饰属性选择器兼容性不同，失败时跳过该选择器。
      }
    }
    return uniqueNodes(nodes)
      .filter((node) => node instanceof HTMLElement && !node.closest(`#${MODAL_ID}, #${BADGE_ID}`))
      .map((card, index) => {
        const parsed = parseToolLabel(card) || { number: index + 1, text: normalizeText(card.textContent || "工具调用") };
        card.setAttribute(CARD_MARK, "true");
        return { card, label: parsed };
      });
  }

  function mergeToolRecords(...groups) {
    const seenCards = new Set();
    const merged = [];
    for (const group of groups) {
      for (const record of group) {
        if (!(record.card instanceof HTMLElement) || seenCards.has(record.card)) continue;
        const parentRecord = merged.find((item) => item.card.contains(record.card));
        if (parentRecord) continue;
        for (let index = merged.length - 1; index >= 0; index -= 1) {
          if (record.card.contains(merged[index].card)) {
            seenCards.delete(merged[index].card);
            merged.splice(index, 1);
          }
        }
        seenCards.add(record.card);
        merged.push(record);
      }
    }
    return merged;
  }

  function sortRecordsByDom(records) {
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

  function collectToolCards() {
    return sortRecordsByDom(mergeToolRecords(
      collectToolCardsFrom(document),
      collectToolMessageRecords(document)
    ));
  }

  function setHidden(card, hidden) {
    card.classList.toggle(HIDDEN_CLASS, hidden);
    card.classList.toggle(PREHIDDEN_CLASS, hidden);
    if (hidden) card.setAttribute("aria-hidden", "true");
    else card.removeAttribute("aria-hidden");
  }

  function clearHiddenCards() {
    document.querySelectorAll(`[${CARD_MARK}].${HIDDEN_CLASS}, [${CARD_MARK}].${PREHIDDEN_CLASS}`).forEach((card) => setHidden(card, false));
  }

  function prehideOlderCards() {
    if (!settings.enabled || temporaryRevealAll) return;
    const allRecords = collectToolCards();
    const limit = clampLimit(settings.limit);
    if (allRecords.length <= limit) return;
    const firstVisibleIndex = Math.max(0, allRecords.length - limit);
    for (let index = 0; index < firstVisibleIndex; index += 1) {
      setHidden(allRecords[index].card, true);
    }
    for (let index = firstVisibleIndex; index < allRecords.length; index += 1) {
      setHidden(allRecords[index].card, false);
    }
  }

  function prehideAddedNodes(mutations) {
    if (!settings.enabled || temporaryRevealAll) return false;
    const touched = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        const root = node instanceof Element ? node : node.parentElement;
        if (!(root instanceof Element)) continue;
        const records = mergeToolRecords(collectToolCardsFrom(root), collectToolMessageRecords(root));
        if (!records.length) continue;
        touched.push(...records);
      }
    }
    if (!touched.length) return false;
    // 页面初次进入长会话时，MutationObserver 会早于完整渲染触发。
    // 这里不等空闲回调，立即给旧工具调用打隐藏类，避免“先全部渲染再隐藏”。
    prehideOlderCards();
    return true;
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

  function buildToolListItems(records) {
    return records.map((record, index) => ({
      index: index + 1,
      number: record.label.number,
      text: record.label.text || `工具调用 ${record.label.number}`
    }));
  }

  function showLightweightToolList() {
    const old = document.getElementById(MODAL_ID);
    if (old) old.remove();

    const records = collectToolCards();
    const limit = clampLimit(settings.limit);
    const items = buildToolListItems(records.slice(Math.max(0, records.length - limit)));

    const modal = document.createElement("div");
    modal.id = MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const panel = document.createElement("section");
    panel.id = "cg-tool-limiter-modal-panel";

    const head = document.createElement("header");
    head.className = "cg-tool-limiter-modal-head";

    const titleBox = document.createElement("div");
    const title = document.createElement("h2");
    title.className = "cg-tool-limiter-modal-title";
    title.textContent = "轻量工具调用列表";
    const subtitle = document.createElement("p");
    subtitle.className = "cg-tool-limiter-modal-subtitle";
    subtitle.textContent = `拦截 ChatGPT 原生全量列表，只显示最新 ${items.length}/${records.length} 个，避免页面无响应。`;
    titleBox.append(title, subtitle);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "cg-tool-limiter-modal-close";
    close.textContent = "关闭";
    close.addEventListener("click", () => modal.remove());
    head.append(titleBox, close);

    const list = document.createElement("div");
    list.className = "cg-tool-limiter-list";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "cg-tool-limiter-list-item";
      empty.textContent = "当前页面没有识别到工具调用。";
      list.append(empty);
    } else {
      for (const item of items) {
        const row = document.createElement("div");
        row.className = "cg-tool-limiter-list-item";
        const idx = document.createElement("span");
        idx.className = "cg-tool-limiter-list-index";
        idx.textContent = `#${item.number || item.index}`;
        const text = document.createElement("span");
        text.className = "cg-tool-limiter-list-text";
        text.textContent = item.text;
        row.append(idx, text);
        list.append(row);
      }
    }

    panel.append(head, list);
    modal.append(panel);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.remove();
    });
    document.addEventListener("keydown", function onKeydown(event) {
      if (event.key !== "Escape") return;
      modal.remove();
      document.removeEventListener("keydown", onKeydown, true);
    }, true);
    document.documentElement.appendChild(modal);
  }

  function interceptNativeToolListClick(event) {
    const link = findNativeToolListLink(event.target);
    if (!link || !settings.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    showLightweightToolList();
  }

  function setupNativeListInterception() {
    document.addEventListener("click", interceptNativeToolListClick, true);
    document.addEventListener("auxclick", interceptNativeToolListClick, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      interceptNativeToolListClick(event);
    }, true);
    markNativeToolListLinks(document);
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

    if (!settings.enabled || temporaryRevealAll) {
      clearHiddenCards();
    } else {
      // 不再先 clearHiddenCards 再隐藏，否则每次扫描都会短暂恢复旧工具调用，造成二次渲染抖动。
      records.forEach((record, index) => setHidden(record.card, shouldLimit && index < firstVisibleIndex));
    }

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

  function scheduleApply(delay = 60) {
    window.clearTimeout(applyTimer);
    applyTimer = window.setTimeout(applyLimit, delay);
  }

  function setupMutationObserver() {
    if (observerStarted) return;
    observerStarted = true;
    const observer = new MutationObserver((mutations) => {
      const alreadyPrehidden = prehideAddedNodes(mutations);
      for (const mutation of mutations) {
        if (mutation.type === "childList" && (mutation.addedNodes.length || mutation.removedNodes.length)) {
          for (const node of mutation.addedNodes) {
            const root = node instanceof Element ? node : node.parentElement;
            if (root instanceof Element) markNativeToolListLinks(root);
          }
          scheduleApply(alreadyPrehidden ? 20 : 80);
          return;
        }
        if (mutation.type === "attributes" && mutation.attributeName === "aria-expanded") {
          scheduleApply(20);
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
    // content script 改为 document_start：先按默认 enabled=true/limit=10 启动观察器，
    // 再异步读取用户设置。这样进入历史会话时不会等到 document_idle 才处理大量工具调用。
    setupRuntimeMessages();
    setupNativeListInterception();
    setupMutationObserver();
    scheduleApply(0);
    settings = await loadSettings();
    scheduleApply(0);
  }

  init().catch((error) => console.warn("[ChatGPT Tool Call Limiter] init failed", error));
})();
