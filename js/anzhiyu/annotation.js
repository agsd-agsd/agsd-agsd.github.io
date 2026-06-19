(function () {
  if (window.AnZhiYuAnnotation) return;

  const DB_NAME = "anzhiyu_annotations";
  const DB_VERSION = 1;
  const STORE_NAME = "annotations";
  const UNSUPPORTED_SELECTOR =
    "#article-container > header, pre, code, table, script, style, textarea, input, button, .highlight, .mermaid, .mermaid-wrap, .katex";

  const state = {
    activeAnnotationId: "",
    activeGroupKey: "",
    annotations: [],
    capturedDraft: null,
    controller: null,
    currentDraft: null,
    dbPromise: null,
    groups: new Map(),
    postKey: "",
    syncAdapter: {
      enabled: false,
      sync: () => Promise.resolve({ ok: true }),
    },
  };

  function $(selector) {
    return document.querySelector(selector);
  }

  function getArticle() {
    return document.getElementById("article-container");
  }

  function isPostPage() {
    return Boolean(window.GLOBAL_CONFIG_SITE && GLOBAL_CONFIG_SITE.isPost && getArticle());
  }

  function getPostKey() {
    const pathname = decodeURIComponent(window.location.pathname || "/");
    return pathname.replace(/\/$/, "") || "/";
  }

  function elementFromNode(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function isUnsupportedNode(node) {
    const element = elementFromNode(node);
    return Boolean(element && element.closest(UNSUPPORTED_SELECTOR));
  }

  function selectionInsideArticle(selection) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const article = getArticle();
    return Boolean(article && article.contains(range.startContainer) && article.contains(range.endContainer));
  }

  function rangeTouchesUnsupported(range) {
    if (isUnsupportedNode(range.startContainer) || isUnsupportedNode(range.endContainer)) return true;
    const article = getArticle();
    if (!article) return true;
    const unsupportedNodes = article.querySelectorAll(UNSUPPORTED_SELECTOR);
    for (const node of unsupportedNodes) {
      if (range.intersectsNode(node)) return true;
    }
    return false;
  }

  function getTextNodes() {
    const article = getArticle();
    if (!article) return [];
    const nodes = [];
    const walker = document.createTreeWalker(
      article,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          if (isUnsupportedNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      },
      false
    );
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function getArticleText() {
    return getTextNodes()
      .map(node => node.nodeValue)
      .join("");
  }

  function normalizeText(text) {
    return String(text || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cssEscape(value) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(value);
    return String(value || "").replace(/["\\]/g, "\\$&");
  }

  function hashText(text) {
    let hash = 0;
    const input = String(text || "");
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function makeAnchorKey(anchor) {
    if (anchor && anchor.key) return anchor.key;
    return [anchor.start, anchor.end, hashText(anchor.quote)].join(":");
  }

  function commonPrefixLength(a, b) {
    let count = 0;
    const length = Math.min(a.length, b.length);
    while (count < length && a[count] === b[count]) count++;
    return count;
  }

  function commonSuffixLength(a, b) {
    let count = 0;
    const length = Math.min(a.length, b.length);
    while (count < length && a[a.length - 1 - count] === b[b.length - 1 - count]) count++;
    return count;
  }

  function offsetForPoint(container, offset) {
    const nodes = getTextNodes();
    let position = 0;
    for (const node of nodes) {
      if (node === container) return position + offset;
      position += node.nodeValue.length;
    }
    return null;
  }

  function findBestQuoteIndex(text, quote, anchor) {
    if (!quote) return -1;
    const positions = [];
    let index = text.indexOf(quote);
    while (index !== -1) {
      positions.push(index);
      index = text.indexOf(quote, index + Math.max(quote.length, 1));
    }
    if (!positions.length) return -1;
    if (positions.length === 1 || !anchor) return positions[0];

    let best = positions[0];
    let bestScore = -1;
    const prefix = anchor.prefix || "";
    const suffix = anchor.suffix || "";
    positions.forEach(pos => {
      const before = text.slice(Math.max(0, pos - prefix.length), pos);
      const after = text.slice(pos + quote.length, pos + quote.length + suffix.length);
      const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
      if (score > bestScore) {
        best = pos;
        bestScore = score;
      }
    });
    return best;
  }

  function rangeFromOffsets(start, end) {
    const nodes = getTextNodes();
    let position = 0;
    let startNode = null;
    let endNode = null;
    let startOffset = 0;
    let endOffset = 0;

    for (const node of nodes) {
      const next = position + node.nodeValue.length;
      if (!startNode && start >= position && start <= next) {
        startNode = node;
        startOffset = Math.max(0, Math.min(node.nodeValue.length, start - position));
      }
      if (!endNode && end >= position && end <= next) {
        endNode = node;
        endOffset = Math.max(0, Math.min(node.nodeValue.length, end - position));
      }
      if (startNode && endNode) break;
      position = next;
    }

    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function buildAnchorFromRange(range) {
    if (!range || range.collapsed || rangeTouchesUnsupported(range)) return null;
    const rawQuote = range.toString();
    const quote = rawQuote.trim();
    if (!quote) return null;

    const text = getArticleText();
    const leadingWhitespace = rawQuote.match(/^\s*/)[0].length;
    const trailingWhitespace = rawQuote.match(/\s*$/)[0].length;
    let start = offsetForPoint(range.startContainer, range.startOffset);
    let end = offsetForPoint(range.endContainer, range.endOffset);

    if (start === null || end === null || end <= start) {
      const quoteIndex = findBestQuoteIndex(text, quote);
      if (quoteIndex === -1) return null;
      start = quoteIndex;
      end = quoteIndex + quote.length;
    } else {
      start += leadingWhitespace;
      end -= trailingWhitespace;
    }

    if (start < 0 || end <= start) return null;
    const anchor = {
      end,
      key: "",
      prefix: text.slice(Math.max(0, start - 48), start),
      quote,
      start,
      suffix: text.slice(end, end + 48),
    };
    anchor.key = makeAnchorKey(anchor);
    return anchor;
  }

  function locateAnchor(anchor) {
    if (!anchor || !anchor.quote) return null;
    const text = getArticleText();
    const quote = anchor.quote;
    let start = Number(anchor.start);
    let end = Number(anchor.end);
    if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= text.length) {
      const candidate = text.slice(start, end);
      if (normalizeText(candidate) === normalizeText(quote)) {
        const range = rangeFromOffsets(start, end);
        if (range) return { end, range, start };
      }
    }

    start = findBestQuoteIndex(text, quote, anchor);
    if (start === -1) return null;
    end = start + quote.length;
    const range = rangeFromOffsets(start, end);
    return range ? { end, range, start } : null;
  }

  function openDb() {
    if (state.dbPromise) return state.dbPromise;
    state.dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is not available"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
          store.createIndex("postKey", "postKey", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open IndexedDB"));
    });
    return state.dbPromise;
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  async function getStore(mode) {
    const db = await openDb();
    return db.transaction(STORE_NAME, mode).objectStore(STORE_NAME);
  }

  async function loadAnnotations(postKey) {
    const store = await getStore("readonly");
    const request = store.index("postKey").getAll(IDBKeyRange.only(postKey));
    const annotations = await requestToPromise(request);
    return annotations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  async function saveAnnotation(annotation) {
    const store = await getStore("readwrite");
    await requestToPromise(store.put(annotation));
  }

  async function removeAnnotation(id) {
    const store = await getStore("readwrite");
    await requestToPromise(store.delete(id));
  }

  function showMessage(message, duration) {
    if (window.anzhiyu && typeof anzhiyu.snackbarShow === "function" && window.GLOBAL_CONFIG.Snackbar !== undefined) {
      anzhiyu.snackbarShow(message, false, duration || 2000);
    } else {
      console.info(message);
    }
  }

  function unwrapHighlights() {
    const article = getArticle();
    if (!article) return;
    article.querySelectorAll(".annotation-highlight").forEach(mark => {
      mark.replaceWith(document.createTextNode(mark.textContent || ""));
    });
    article.normalize();
  }

  function wrapTextSegment(node, startOffset, endOffset, groupKey) {
    if (!node || startOffset >= endOffset) return;
    let target = node;
    if (endOffset < target.nodeValue.length) target.splitText(endOffset);
    if (startOffset > 0) target = target.splitText(startOffset);

    const mark = document.createElement("span");
    mark.className = "annotation-highlight";
    mark.dataset.annotationGroup = groupKey;
    mark.tabIndex = 0;
    mark.title = "查看批注";
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
  }

  function wrapRangeByOffsets(start, end, groupKey) {
    const nodes = getTextNodes();
    const segments = [];
    let position = 0;

    nodes.forEach(node => {
      const nodeStart = position;
      const nodeEnd = position + node.nodeValue.length;
      const overlapStart = Math.max(start, nodeStart);
      const overlapEnd = Math.min(end, nodeEnd);
      if (overlapStart < overlapEnd) {
        segments.push({
          end: overlapEnd - nodeStart,
          node,
          start: overlapStart - nodeStart,
        });
      }
      position = nodeEnd;
    });

    segments.reverse().forEach(segment => {
      wrapTextSegment(segment.node, segment.start, segment.end, groupKey);
    });
  }

  function buildGroups() {
    const groups = new Map();
    state.annotations.forEach(annotation => {
      const location = locateAnchor(annotation.anchor);
      annotation._location = location;
      const key = annotation.anchor.key || makeAnchorKey(annotation.anchor);
      if (!groups.has(key)) {
        groups.set(key, {
          anchor: annotation.anchor,
          annotations: [],
          key,
          location,
          quote: annotation.quote,
        });
      }
      const group = groups.get(key);
      if (!group.location && location) group.location = location;
      group.annotations.push(annotation);
    });
    state.groups = groups;
  }

  function renderHighlights() {
    unwrapHighlights();
    buildGroups();
    const groups = Array.from(state.groups.values())
      .filter(group => group.location)
      .sort((a, b) => b.location.start - a.location.start);
    groups.forEach(group => {
      wrapRangeByOffsets(group.location.start, group.location.end, group.key);
    });
  }

  function getActiveDraftSource() {
    if (state.currentDraft) return state.currentDraft;
    const group = state.groups.get(state.activeGroupKey);
    if (!group) return null;
    return {
      anchor: Object.assign({}, group.anchor),
      quote: group.quote,
    };
  }

  function renderCompose() {
    const compose = $("#annotation-compose");
    const quote = $("#annotation-quote");
    if (!compose || !quote) return;
    const draft = getActiveDraftSource();
    compose.classList.toggle("show", Boolean(draft));
    quote.textContent = draft ? draft.quote : "选择正文后创建批注";
  }

  function formatTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString();
  }

  function renderList() {
    const list = $("#annotation-list");
    const empty = $("#annotation-empty");
    const count = $("#annotation-count");
    if (!list || !empty || !count) return;

    count.textContent = String(state.annotations.length);
    empty.classList.toggle("show", state.annotations.length === 0);
    list.innerHTML = state.annotations
      .map(annotation => {
        const groupKey = annotation.anchor.key || makeAnchorKey(annotation.anchor);
        const isActive = annotation.id === state.activeAnnotationId || groupKey === state.activeGroupKey;
        const isMissing = !annotation._location;
        return `
          <div class="annotation-thread${isActive ? " active" : ""}${isMissing ? " is-missing" : ""}" data-annotation-id="${escapeHtml(
          annotation.id
        )}" data-annotation-group="${escapeHtml(groupKey)}" role="button" tabindex="0">
            <div class="annotation-thread__top">
              <span class="annotation-thread__avatar">M</span>
              <span class="annotation-thread__meta">
                <span class="annotation-thread__author">Me</span>
                ${escapeHtml(formatTime(annotation.createdAt))}
              </span>
              <button class="annotation-delete" type="button" title="删除批注" data-annotation-delete="${escapeHtml(
                annotation.id
              )}">
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <div class="annotation-thread__quote">${escapeHtml(annotation.quote)}</div>
            <div class="annotation-thread__comment">${escapeHtml(annotation.comment)}</div>
            ${isMissing ? '<span class="annotation-thread__missing">原文位置已失效</span>' : ""}
          </div>
        `;
      })
      .join("");
  }

  function renderDrawer() {
    renderCompose();
    renderList();
    requestAnimationFrame(() => {
      const list = $("#annotation-list");
      const active = state.activeAnnotationId
        ? list && list.querySelector(`[data-annotation-id="${cssEscape(state.activeAnnotationId)}"]`)
        : state.activeGroupKey && list && list.querySelector(`[data-annotation-group="${cssEscape(state.activeGroupKey)}"]`);
      if (active) active.scrollIntoView({ block: "nearest" });
    });
  }

  function renderAll() {
    renderHighlights();
    renderDrawer();
  }

  function openDrawer() {
    const drawer = $("#annotation-drawer");
    const mask = $("#annotation-mask");
    if (!drawer || !mask) return;
    drawer.classList.add("open");
    mask.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    const drawer = $("#annotation-drawer");
    const mask = $("#annotation-mask");
    if (!drawer || !mask) return;
    drawer.classList.remove("open");
    mask.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
  }

  function clearDraft() {
    state.currentDraft = null;
    state.activeGroupKey = "";
    state.activeAnnotationId = "";
    const input = $("#annotation-input");
    if (input) input.value = "";
    renderDrawer();
  }

  function openDraft(draft) {
    if (!draft) return;
    state.currentDraft = draft;
    state.activeGroupKey = draft.anchor.key;
    state.activeAnnotationId = "";
    const input = $("#annotation-input");
    if (input) input.value = "";
    renderDrawer();
    openDrawer();
    setTimeout(() => {
      const textarea = $("#annotation-input");
      if (textarea) textarea.focus();
    }, 80);
  }

  async function submitAnnotation() {
    const input = $("#annotation-input");
    const draft = getActiveDraftSource();
    const comment = input ? input.value.trim() : "";
    if (!draft) {
      showMessage("请先选中正文创建批注", 2000);
      return;
    }
    if (!comment) {
      showMessage("先写一点批注内容吧", 2000);
      return;
    }

    const now = new Date().toISOString();
    const annotation = {
      anchor: Object.assign({}, draft.anchor),
      comment,
      createdAt: now,
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      postKey: state.postKey,
      quote: draft.quote,
      updatedAt: now,
    };

    try {
      await saveAnnotation(annotation);
      if (state.syncAdapter.enabled) {
        state.syncAdapter.sync(annotation).catch(() => {
          showMessage("本地已保存，同步失败", 3000);
        });
      }
      state.annotations.unshift(annotation);
      state.currentDraft = null;
      state.activeGroupKey = annotation.anchor.key;
      state.activeAnnotationId = annotation.id;
      if (input) input.value = "";
      renderAll();
      flashGroup(annotation.anchor.key);
      showMessage("已保存到本地", 1800);
    } catch (error) {
      console.error("[annotation] save failed", error);
      showMessage("批注保存失败", 2500);
    }
  }

  async function deleteAnnotation(id) {
    try {
      await removeAnnotation(id);
      state.annotations = state.annotations.filter(annotation => annotation.id !== id);
      if (state.activeAnnotationId === id) state.activeAnnotationId = "";
      renderAll();
      showMessage("已删除批注", 1800);
    } catch (error) {
      console.error("[annotation] delete failed", error);
      showMessage("删除失败", 2200);
    }
  }

  function flashGroup(groupKey) {
    if (!groupKey) return;
    const marks = document.querySelectorAll(`.annotation-highlight[data-annotation-group="${cssEscape(groupKey)}"]`);
    marks.forEach(mark => mark.classList.add("annotation-highlight--active"));
    window.setTimeout(() => {
      marks.forEach(mark => mark.classList.remove("annotation-highlight--active"));
    }, 1500);
  }

  function scrollToGroup(groupKey) {
    const group = state.groups.get(groupKey);
    if (!group || !group.location) {
      showMessage("原文位置已失效", 2200);
      return;
    }
    const mark = document.querySelector(`.annotation-highlight[data-annotation-group="${cssEscape(groupKey)}"]`);
    if (!mark) return;
    const rect = mark.getBoundingClientRect();
    const top = Math.max(0, window.scrollY + rect.top - 110);
    if (window.anzhiyu && typeof anzhiyu.scrollToDest === "function") {
      anzhiyu.scrollToDest(top, 420);
    } else {
      window.scrollTo({ top, behavior: "smooth" });
    }
    flashGroup(groupKey);
  }

  function activateGroup(groupKey, annotationId, shouldScroll) {
    const group = state.groups.get(groupKey);
    if (!group) return;
    state.activeGroupKey = groupKey;
    state.activeAnnotationId = annotationId || "";
    state.currentDraft = null;
    renderDrawer();
    openDrawer();
    if (shouldScroll) scrollToGroup(groupKey);
    else flashGroup(groupKey);
  }

  function handleArticleClick(event) {
    const mark = event.target.closest(".annotation-highlight");
    if (!mark) return;
    event.preventDefault();
    activateGroup(mark.dataset.annotationGroup, "", false);
  }

  function handleListClick(event) {
    const deleteButton = event.target.closest("[data-annotation-delete]");
    if (deleteButton) {
      event.stopPropagation();
      deleteAnnotation(deleteButton.dataset.annotationDelete);
      return;
    }
    const thread = event.target.closest(".annotation-thread");
    if (!thread) return;
    activateGroup(thread.dataset.annotationGroup, thread.dataset.annotationId, true);
  }

  function canCreateFromSelection() {
    const selection = window.getSelection();
    if (!selectionInsideArticle(selection)) return false;
    const range = selection.getRangeAt(0);
    if (rangeTouchesUnsupported(range)) return false;
    return Boolean(range.toString().trim());
  }

  function captureSelection() {
    const selection = window.getSelection();
    if (!selectionInsideArticle(selection)) {
      state.capturedDraft = null;
      return null;
    }
    const anchor = buildAnchorFromRange(selection.getRangeAt(0).cloneRange());
    if (!anchor) {
      state.capturedDraft = null;
      return null;
    }
    state.capturedDraft = {
      anchor,
      quote: anchor.quote,
    };
    return state.capturedDraft;
  }

  function createFromSelection(fallbackText) {
    let draft = captureSelection() || state.capturedDraft;
    if (!draft && fallbackText && String(fallbackText).trim()) {
      const text = getArticleText();
      const quote = String(fallbackText).trim();
      const start = findBestQuoteIndex(text, quote);
      if (start !== -1) {
        const anchor = {
          end: start + quote.length,
          key: "",
          prefix: text.slice(Math.max(0, start - 48), start),
          quote,
          start,
          suffix: text.slice(start + quote.length, start + quote.length + 48),
        };
        anchor.key = makeAnchorKey(anchor);
        draft = { anchor, quote };
      }
    }
    if (!draft) {
      showMessage("请先选中文章正文", 2200);
      return false;
    }
    window.getSelection() && window.getSelection().removeAllRanges();
    openDraft(draft);
    return true;
  }

  async function reloadAnnotations() {
    if (!isPostPage()) return;
    try {
      state.annotations = await loadAnnotations(state.postKey);
      renderAll();
    } catch (error) {
      console.error("[annotation] load failed", error);
      showMessage("批注加载失败", 2500);
    }
  }

  function bindEvents() {
    const signal = state.controller.signal;
    const article = getArticle();
    const mask = $("#annotation-mask");
    const closeButton = $("#annotation-close");
    const backButton = $("#annotation-back");
    const submitButton = $("#annotation-submit");
    const cancelButton = $("#annotation-cancel");
    const list = $("#annotation-list");
    const rightsideButton = $("#annotation-rightside-button");

    if (article) article.addEventListener("click", handleArticleClick, { signal });
    if (mask) mask.addEventListener("click", closeDrawer, { signal });
    if (closeButton) closeButton.addEventListener("click", closeDrawer, { signal });
    if (backButton) backButton.addEventListener("click", closeDrawer, { signal });
    if (submitButton) submitButton.addEventListener("click", submitAnnotation, { signal });
    if (cancelButton) cancelButton.addEventListener("click", clearDraft, { signal });
    if (list) list.addEventListener("click", handleListClick, { signal });
    if (rightsideButton) {
      rightsideButton.addEventListener(
        "click",
        () => {
          state.currentDraft = null;
          renderDrawer();
          openDrawer();
        },
        { signal }
      );
    }
  }

  function cleanup() {
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.currentDraft = null;
    state.capturedDraft = null;
    state.activeGroupKey = "";
    state.activeAnnotationId = "";
    state.annotations = [];
    state.groups = new Map();
    closeDrawer();
    unwrapHighlights();
  }

  async function init() {
    cleanup();
    if (!isPostPage()) return;
    if (!$("#annotation-drawer")) return;
    state.controller = new AbortController();
    state.postKey = getPostKey();
    bindEvents();
    await reloadAnnotations();
  }

  window.AnZhiYuAnnotation = {
    canCreateFromSelection,
    captureSelection,
    cleanup,
    createFromSelection,
    init,
    syncAdapter: state.syncAdapter,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  document.addEventListener("pjax:send", cleanup);
  document.addEventListener("pjax:complete", () => {
    window.setTimeout(init, 0);
  });
})();
