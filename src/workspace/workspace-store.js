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
      return url.href;
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
    const source = value && typeof value === 'object' ? value : {};
    return {
      x: finiteNumber(source.x, fallback.x),
      y: finiteNumber(source.y, fallback.y),
    };
  }

  function normalizeUi(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      floatingTriggerPosition: normalizePosition(source.floatingTriggerPosition, { x: 0, y: 0 }),
      floatingPanelOpen: source.floatingPanelOpen === true,
      enhancedOptInHostname: String(source.enhancedOptInHostname || '').trim().toLowerCase(),
      compatibilityEnabled: source.compatibilityEnabled === true,
    };
  }

  function normalizeTrackSizes(value, expectedLength) {
    if (!Array.isArray(value) || value.length !== expectedLength) return new Array(expectedLength).fill(1);
    const next = value.map(Number);
    return next.every((item) => Number.isFinite(item) && item > 0)
      ? next
      : new Array(expectedLength).fill(1);
  }

  function trimPaneHistory(pane) {
    const source = Array.isArray(pane?.history) ? pane.history.map((entry) => ({ ...entry })) : [];
    if (!source.length) return { ...pane, history: [], historyIndex: 0 };
    const currentIndex = Math.min(
      Math.max(Number.isInteger(pane.historyIndex) ? pane.historyIndex : 0, 0),
      source.length - 1,
    );
    if (source.length <= MAX_HISTORY_ENTRIES) {
      return { ...pane, history: source, historyIndex: currentIndex };
    }

    const earliestStart = Math.max(0, currentIndex - (MAX_HISTORY_ENTRIES - 1));
    const latestStart = source.length - MAX_HISTORY_ENTRIES;
    const start = Math.min(earliestStart, latestStart);
    return {
      ...pane,
      history: source.slice(start, start + MAX_HISTORY_ENTRIES),
      historyIndex: currentIndex - start,
    };
  }

  function normalizePane(value) {
    if (!value || typeof value !== 'object') return null;
    const paneId = validId(value.paneId);
    if (!paneId || !Array.isArray(value.history)) return null;

    const history = value.history
      .map((entry) => validHttpUrl(entry?.url))
      .filter(Boolean)
      .map((url) => ({ url }));
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

    const panes = [];
    const paneIds = new Set();
    for (const rawPane of Array.isArray(value.panes) ? value.panes : []) {
      const pane = normalizePane(rawPane);
      if (!pane || paneIds.has(pane.paneId)) continue;
      paneIds.add(pane.paneId);
      panes.push(pane);
      if (panes.length === MAX_PANES) break;
    }
    if (!panes.length) return null;

    const dims = computeDims(panes.length);
    const layoutSource = value.layout && typeof value.layout === 'object' ? value.layout : {};
    const createdAt = finiteNumber(value.createdAt, Date.now());
    const updatedAt = finiteNumber(value.updatedAt, createdAt);
    const lastSeenAt = finiteNumber(value.lastSeenAt, updatedAt);
    const activePaneId = paneIds.has(validId(value.activePaneId)) ? validId(value.activePaneId) : panes[0].paneId;

    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      createdAt,
      updatedAt,
      lastSeenAt,
      closedAt: value.closedAt == null ? null : finiteNumber(value.closedAt, null),
      activeTabId: Number.isInteger(value.activeTabId) ? value.activeTabId : null,
      layout: {
        cols: dims.cols,
        rows: dims.rows,
        colSizes: normalizeTrackSizes(layoutSource.colSizes, dims.cols),
        rowSizes: normalizeTrackSizes(layoutSource.rowSizes, dims.rows),
      },
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
      workspaceId: validId(options.workspaceId) || makeUuid(),
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
    const makePaneId = typeof options.makePaneId === 'function' ? options.makePaneId : makeUuid;
    const paneIdMap = new Map();
    const panes = source.panes.map((pane) => {
      const paneId = validId(makePaneId()) || makeUuid();
      paneIdMap.set(pane.paneId, paneId);
      return {
        ...pane,
        paneId,
        controlPosition: { ...pane.controlPosition },
        history: pane.history.map((entry) => ({ ...entry })),
      };
    });
    return {
      ...source,
      workspaceId: validId(options.workspaceId) || makeUuid(),
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: null,
      activeTabId: null,
      activePaneId: paneIdMap.get(source.activePaneId) || panes[0].paneId,
      layout: {
        ...source.layout,
        colSizes: [...source.layout.colSizes],
        rowSizes: [...source.layout.rowSizes],
      },
      ui: {
        ...source.ui,
        floatingTriggerPosition: { ...source.ui.floatingTriggerPosition },
      },
      panes,
    };
  }

  function replacePane(workspace, paneId, mutate) {
    const index = workspace?.panes?.findIndex((pane) => pane.paneId === paneId) ?? -1;
    if (index < 0) return { workspace, changed: false };
    const panes = workspace.panes.map((pane, paneIndex) => (paneIndex === index ? mutate(pane) : pane));
    return { workspace: { ...workspace, panes }, changed: true };
  }

  function recordNavigation(workspace, paneId, value) {
    const url = validHttpUrl(value);
    const pane = workspace?.panes?.find((item) => item.paneId === paneId);
    if (!url || !pane) return { workspace, changed: false };
    if (pane.history[pane.historyIndex]?.url === url) return { workspace, changed: false };

    const history = pane.history.slice(0, pane.historyIndex + 1).map((entry) => ({ ...entry }));
    history.push({ url });
    const nextPane = trimPaneHistory({ ...pane, history, historyIndex: history.length - 1 });
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
    if (pane.history[expectedIndex]?.url !== validHttpUrl(expectedUrl) || pane.historyIndex === expectedIndex) {
      return { workspace, changed: false };
    }
    return replacePane(workspace, paneId, (current) => ({ ...current, historyIndex: expectedIndex }));
  }

  function indexEntry(workspace) {
    return {
      workspaceId: workspace.workspaceId,
      updatedAt: workspace.updatedAt,
      lastSeenAt: workspace.lastSeenAt,
      closedAt: workspace.closedAt,
      activeTabId: workspace.activeTabId,
    };
  }

  function normalizeIndex(value) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const result = [];
    for (const raw of value) {
      const workspaceId = validId(raw?.workspaceId);
      if (!workspaceId || seen.has(workspaceId)) continue;
      seen.add(workspaceId);
      result.push({
        workspaceId,
        updatedAt: finiteNumber(raw.updatedAt, 0),
        lastSeenAt: finiteNumber(raw.lastSeenAt, 0),
        closedAt: raw.closedAt == null ? null : finiteNumber(raw.closedAt, null),
        activeTabId: Number.isInteger(raw.activeTabId) ? raw.activeTabId : null,
      });
    }
    return result;
  }

  function removeOldestNonCurrentHistoryEntry(pane) {
    if (!pane || pane.history.length <= 1) return { pane, changed: false };
    let removeIndex = 0;
    if (removeIndex === pane.historyIndex) removeIndex = 1;
    const history = pane.history.filter((_, index) => index !== removeIndex);
    const historyIndex = pane.historyIndex > removeIndex ? pane.historyIndex - 1 : pane.historyIndex;
    return { pane: { ...pane, history, historyIndex }, changed: true };
  }

  class WorkspaceStore {
    constructor(options = {}) {
      if (!options.localArea) throw new Error('localArea is required');
      this.localArea = options.localArea;
      this.now = typeof options.now === 'function' ? options.now : Date.now;
      this.makeWorkspaceId = typeof options.makeWorkspaceId === 'function' ? options.makeWorkspaceId : makeUuid;
      this.makePaneId = typeof options.makePaneId === 'function' ? options.makePaneId : makeUuid;
      this.getBytesInUse = typeof options.getBytesInUse === 'function'
        ? options.getBytesInUse
        : (keys) => this.localArea.getBytesInUse(keys);
    }

    async listIndex() {
      const result = await this.localArea.get(INDEX_KEY);
      return normalizeIndex(result?.[INDEX_KEY]);
    }

    async writeIndex(index) {
      const normalized = normalizeIndex(index);
      await this.localArea.set({ [INDEX_KEY]: normalized });
      return normalized;
    }

    async updateIndexEntry(workspace) {
      const index = await this.listIndex();
      const nextEntry = indexEntry(workspace);
      const existing = index.findIndex((entry) => entry.workspaceId === workspace.workspaceId);
      if (existing >= 0) index[existing] = nextEntry;
      else index.push(nextEntry);
      await this.writeIndex(index);
    }

    async create(urls, options = {}) {
      const workspace = createWorkspaceFromUrls(urls, {
        workspaceId: options.workspaceId || this.makeWorkspaceId(),
        now: this.now(),
        makePaneId: this.makePaneId,
        ui: options.ui,
      });
      return this.save(workspace);
    }

    async load(workspaceId) {
      const id = validId(workspaceId);
      if (!id) return null;
      const result = await this.localArea.get(workspaceKey(id));
      return normalizeWorkspace(result?.[workspaceKey(id)]);
    }

    async save(workspace) {
      const normalized = normalizeWorkspace(workspace);
      if (!normalized) throw new Error('Invalid workspace');
      await this.localArea.set({ [workspaceKey(normalized.workspaceId)]: normalized });
      await this.updateIndexEntry(normalized);
      return normalized;
    }

    async clone(workspaceId) {
      const source = await this.load(workspaceId);
      if (!source) return null;
      const clone = cloneWorkspace(source, {
        workspaceId: this.makeWorkspaceId(),
        makePaneId: this.makePaneId,
        now: this.now(),
      });
      return this.save(clone);
    }

    async markActive(workspaceId, tabId) {
      if (!Number.isInteger(tabId)) return null;
      const workspace = await this.load(workspaceId);
      if (!workspace) return null;
      const now = this.now();
      return this.save({
        ...workspace,
        activeTabId: tabId,
        closedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      });
    }

    async markClosed(workspaceId) {
      const workspace = await this.load(workspaceId);
      if (!workspace) return null;
      const now = this.now();
      return this.save({
        ...workspace,
        activeTabId: null,
        closedAt: now,
        lastSeenAt: now,
        updatedAt: now,
      });
    }

    async deleteWorkspace(workspaceId) {
      const id = validId(workspaceId);
      if (!id) return false;
      await this.localArea.remove(workspaceKey(id));
      const index = (await this.listIndex()).filter((entry) => entry.workspaceId !== id);
      await this.writeIndex(index);
      return true;
    }

    async workspaceKeys() {
      return (await this.listIndex()).map((entry) => workspaceKey(entry.workspaceId));
    }

    async measuredBytes() {
      const keys = [INDEX_KEY, ...(await this.workspaceKeys())];
      return this.getBytesInUse(keys);
    }

    async cleanup() {
      let index = await this.listIndex();
      const closed = index
        .filter((entry) => entry.activeTabId == null && entry.closedAt != null)
        .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0));

      for (const entry of closed.slice(MAX_CLOSED_WORKSPACES)) {
        await this.localArea.remove(workspaceKey(entry.workspaceId));
        index = index.filter((item) => item.workspaceId !== entry.workspaceId);
      }
      await this.writeIndex(index);

      let bytes = await this.measuredBytes();
      if (bytes <= SOFT_BUDGET_BYTES) return;

      const remainingClosed = (await this.listIndex())
        .filter((entry) => entry.activeTabId == null && entry.closedAt != null)
        .sort((a, b) => (a.closedAt || 0) - (b.closedAt || 0));
      for (const entry of remainingClosed) {
        if (bytes <= SOFT_BUDGET_BYTES) break;
        await this.deleteWorkspace(entry.workspaceId);
        bytes = await this.measuredBytes();
      }
      if (bytes <= SOFT_BUDGET_BYTES) return;

      let madeProgress = true;
      while (bytes > SOFT_BUDGET_BYTES && madeProgress) {
        madeProgress = false;
        const activeEntries = (await this.listIndex())
          .filter((entry) => entry.activeTabId != null)
          .sort((a, b) => (a.lastSeenAt || 0) - (b.lastSeenAt || 0));
        for (const entry of activeEntries) {
          if (bytes <= SOFT_BUDGET_BYTES) break;
          const workspace = await this.load(entry.workspaceId);
          if (!workspace) continue;
          let changed = false;
          const panes = workspace.panes.map((pane) => {
            const trimmed = removeOldestNonCurrentHistoryEntry(pane);
            changed ||= trimmed.changed;
            return trimmed.pane;
          });
          if (!changed) continue;
          madeProgress = true;
          await this.save({ ...workspace, panes, updatedAt: this.now() });
          bytes = await this.measuredBytes();
        }
      }
    }
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
    WorkspaceStore,
  };

  global.MPVWorkspaceStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
