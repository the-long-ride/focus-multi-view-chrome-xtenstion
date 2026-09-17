(function initWorkspaceStore(global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_HISTORY_ENTRIES = 50;
  const MAX_CLOSED_WORKSPACES = 20;
  const SOFT_BUDGET_BYTES = 6 * 1024 * 1024;
  const INDEX_KEY = 'mpv:workspace-index';
  const MAX_PANES = 9;

  function workspaceKey(workspaceId) {
    return `mpv:workspace:${workspaceId}`;
  }

  function makeUuid() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    throw new Error('crypto.randomUUID is unavailable');
  }

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function positiveTrackSizes(value, expectedLength) {
    if (!Array.isArray(value) || value.length !== expectedLength) return null;
    const next = value.map(Number);
    return next.every((item) => Number.isFinite(item) && item > 0) ? next : null;
  }

  function validId(value) {
    const id = String(value || '').trim();
    return id && id.length <= 256 ? id : '';
  }

  function validHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      return raw;
    } catch {
      return '';
    }
  }

  function computeDims(count) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    return { cols, rows };
  }

  function normalizePosition(value, fallback = { x: 8, y: 8 }) {
    if (!value || typeof value !== 'object') return { ...fallback };
    return {
      x: finiteNumber(value.x, fallback.x),
      y: finiteNumber(value.y, fallback.y),
    };
  }

  function normalizeUi(value = {}) {
    return {
      floatingTriggerPosition: normalizePosition(value.floatingTriggerPosition, { x: 0, y: 0 }),
      floatingPanelOpen: value.floatingPanelOpen === true,
      enhancedOptInHostname: String(value.enhancedOptInHostname || '').trim().toLowerCase(),
      compatibilityEnabled: value.compatibilityEnabled === true,
    };
  }

  function trimPaneHistory(pane) {
    const source = Array.isArray(pane?.history) ? pane.history : [];
    if (!source.length) return { ...pane, history: [], historyIndex: 0 };
    const index = Math.min(Math.max(Number.isInteger(pane.historyIndex) ? pane.historyIndex : 0, 0), source.length - 1);
    if (source.length <= MAX_HISTORY_ENTRIES) {
      return { ...pane, history: source.map((entry) => ({ ...entry })), historyIndex: index };
    }
    const maxStart = source.length - MAX_HISTORY_ENTRIES;
    const start = Math.min(Math.max(index - (MAX_HISTORY_ENTRIES - 1), 0), maxStart);
    const history = source.slice(start, start + MAX_HISTORY_ENTRIES).map((entry) => ({ ...entry }));
    return { ...pane, history, historyIndex: index - start };
  }

  function normalizePane(value) {
    if (!value || typeof value !== 'object') return null;
    const paneId = validId(value.paneId);
    if (!paneId || !Array.isArray(value.history)) return null;
    const history = [];
    for (const entry of value.history) {
      const url = validHttpUrl(entry?.url);
      if (url) history.push({ url });
    }
    if (!history.length) return null;
    const historyIndex = Math.min(
      Math.max(Number.isInteger(value.historyIndex) ? value.historyIndex : history.length - 1, 0),
      history.length - 1,
    );
    return trimPaneHistory({
      paneId,
      controlPosition: normalizePosition(value.controlPosition),
      historyIndex,
      history,
    });
  }

  function normalizeWorkspace(value) {
    if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) return null;
    const workspaceId = validId(value.workspaceId);
    if (!workspaceId) return null;

    const seenPaneIds = new Set();
    const panes = [];
    for (const candidate of Array.isArray(value.panes) ? value.panes : []) {
      const pane = normalizePane(candidate);
      if (!pane || seenPaneIds.has(pane.paneId)) continue;
      seenPaneIds.add(pane.paneId);
      panes.push(pane);
      if (panes.length === MAX_PANES) break;
    }
    if (!panes.length) return null;

    const dims = computeDims(panes.length);
    const layoutValue = value.layout && typeof value.layout === 'object' ? value.layout : {};
    const layoutCols = dims.cols;
    const layoutRows = dims.rows;
    const colSizes = positiveTrackSizes(layoutValue.colSizes, layoutCols) || new Array(layoutCols).fill(1);
    const rowSizes = positiveTrackSizes(layoutValue.rowSizes, layoutRows) || new Array(layoutRows).fill(1);

    const now = Date.now();
    const createdAt = finiteNumber(value.createdAt, now);
    const updatedAt = finiteNumber(value.updatedAt, createdAt);
    const lastSeenAt = finiteNumber(value.lastSeenAt, updatedAt);
    const closedAt = value.closedAt == null ? null : finiteNumber(value.closedAt, null);
    const activeTabId = Number.isInteger(value.activeTabId) ? value.activeTabId : null;
    const requestedActivePaneId = validId(value.activePaneId);
    const activePaneId = seenPaneIds.has(requestedActivePaneId) ? requestedActivePaneId : panes[0].paneId;

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      createdAt,
      updatedAt,
      lastSeenAt,
      closedAt,
      activeTabId,
      layout: { cols: layoutCols, rows: layoutRows, colSizes, rowSizes },
      activePaneId,
      ui: normalizeUi(value.ui),
      panes,
    };
  }

  function createWorkspaceFromUrls(urls, options = {}) {
    const cleanUrls = (Array.isArray(urls) ? urls : [])
      .map(validHttpUrl)
      .filter(Boolean)
      .slice(0, MAX_PANES);
    if (!cleanUrls.length) throw new Error('At least one valid HTTP(S) URL is required');

    const now = finiteNumber(options.now, Date.now());
    const workspaceId = validId(options.workspaceId) || makeUuid();
    const makePaneId = typeof options.makePaneId === 'function' ? options.makePaneId : makeUuid;
    const panes = cleanUrls.map((url) => ({
      paneId: validId(makePaneId()) || makeUuid(),
      controlPosition: { x: 8, y: 8 },
      historyIndex: 0,
      history: [{ url }],
    }));
    const dims = computeDims(panes.length);
    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: null,
      activeTabId: null,
      layout: {
        cols: dims.cols,
        rows: dims.rows,
        colSizes: new Array(dims.cols).fill(1),
        rowSizes: new Array(dims.rows).fill(1),
      },
      activePaneId: panes[0].paneId,
      ui: normalizeUi(options.ui),
      panes,
    };
  }

  function cloneWorkspace(workspace, options = {}) {
    const source = normalizeWorkspace(workspace);
    if (!source) throw new Error('Invalid workspace');
    const now = finiteNumber(options.now, Date.now());
    const workspaceId = validId(options.workspaceId) || makeUuid();
    const makePaneId = typeof options.makePaneId === 'function' ? options.makePaneId : makeUuid;
    const paneMap = new Map();
    const panes = source.panes.map((pane) => {
      const paneId = validId(makePaneId()) || makeUuid();
      paneMap.set(pane.paneId, paneId);
      return {
        ...pane,
        paneId,
        controlPosition: { ...pane.controlPosition },
        history: pane.history.map((entry) => ({ ...entry })),
      };
    });
    return {
      ...source,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: null,
      activeTabId: null,
      activePaneId: paneMap.get(source.activePaneId) || panes[0]?.paneId || null,
      layout: {
        ...source.layout,
        colSizes: [...source.layout.colSizes],
        rowSizes: [...source.layout.rowSizes],
      },
      ui: { ...source.ui, floatingTriggerPosition: { ...source.ui.floatingTriggerPosition } },
      panes,
    };
  }

  function replacePane(workspace, paneId, mutate) {
    const paneIndex = workspace.panes.findIndex((item) => item.paneId === paneId);
    if (paneIndex < 0) return { workspace, changed: false };
    const panes = workspace.panes.map((pane, index) => (index === paneIndex ? mutate(pane) : pane));
    return { workspace: { ...workspace, panes }, changed: true };
  }

  function recordNavigation(workspace, paneId, value) {
    const url = validHttpUrl(value);
    if (!url) return { workspace, changed: false };
    const pane = workspace?.panes?.find((item) => item.paneId === paneId);
    if (!pane) return { workspace, changed: false };
    const currentUrl = pane.history[pane.historyIndex]?.url;
    if (currentUrl === url) return { workspace, changed: false };

    const nextHistory = pane.history.slice(0, pane.historyIndex + 1).map((entry) => ({ ...entry }));
    nextHistory.push({ url });
    let nextPane = { ...pane, history: nextHistory, historyIndex: nextHistory.length - 1 };
    nextPane = trimPaneHistory(nextPane);
    return replacePane(workspace, paneId, () => nextPane);
  }

  function prepareTraversal(workspace, paneId, direction) {
    const pane = workspace?.panes?.find((item) => item.paneId === paneId);
    if (!pane) return null;
    const delta = direction === 'back' ? -1 : direction === 'forward' ? 1 : 0;
    const index = pane.historyIndex + delta;
    if (!delta || index < 0 || index >= pane.history.length) return null;
    return { index, url: pane.history[index].url };
  }

  function confirmTraversal(workspace, paneId, expectedIndex, expectedUrl) {
    const pane = workspace?.panes?.find((item) => item.paneId === paneId);
    if (!pane || !Number.isInteger(expectedIndex) || expectedIndex < 0 || expectedIndex >= pane.history.length) {
      return { workspace, changed: false };
    }
    if (pane.history[expectedIndex]?.url !== expectedUrl || pane.historyIndex === expectedIndex) {
      return { workspace, changed: false };
    }
    return replacePane(workspace, paneId, (current) => ({ ...current, historyIndex: expectedIndex }));
  }

  const api = {
    SCHEMA_VERSION,
    MAX_HISTORY_ENTRIES,
    MAX_CLOSED_WORKSPACES,
    SOFT_BUDGET_BYTES,
    INDEX_KEY,
    workspaceKey,
    createWorkspaceFromUrls,
    normalizeWorkspace,
    cloneWorkspace,
    recordNavigation,
    prepareTraversal,
    confirmTraversal,
    trimPaneHistory,
  };

  global.MPVWorkspaceStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
