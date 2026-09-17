'use strict';

const MAX_PANES = MPV.MAX_PANES;
const GUTTER = 2;
const MIN_TRACK_PX = 120;
const FLOATING_PADDING = 12;
const FLOATING_GAP = 8;
const PANE_CONTROL_PADDING = 8;
const PORT_REQUEST_TIMEOUT_MS = 3000;
const PORT_RECONNECT_DELAY_MS = 250;
const COMPAT_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };

const container = document.getElementById('panesContainer');
const controlTrigger = document.getElementById('controlTrigger');
const floatingPanel = document.getElementById('floatingPanel');
const triggerPaneCount = document.getElementById('triggerPaneCount');
const addBtn = document.getElementById('addPane');
const enhancedToggle = document.getElementById('enhancedToggle');
const compatBtn = document.getElementById('compatToggle');
const countLabel = document.getElementById('paneCountLabel');

const sessionId = crypto.randomUUID();
let workspaceId = '';
let currentWorkspace = null;
let panes = [];
let colSplitters = [];
let rowSplitters = [];
let cols = 1;
let rows = 1;
let colSizes = [1];
let rowSizes = [1];
let compatEnabled = false;
let currentTabId = null;
let triggerDragState = null;
let paneControlDragState = null;
let resizeDragState = null;
let suppressNextTriggerClick = false;
let enhancedActive = false;
let enhancedHostname = '';
let enhancedOptInHostname = sessionStorage.getItem('mpv-enhanced-opt-in-hostname') || '';
let gridPort = null;
let gridPortReady = false;
let gridInitialized = false;
let reconnectTimer = null;
let requestSequence = 0;
let enhancedSyncTimer = null;
const pendingPortRequests = new Map();
const portReadyWaiters = new Set();
const paneRegistry = new Map();

function viewportSize() {
  return { width: window.innerWidth, height: window.innerHeight };
}

function setTriggerPosition(position) {
  const rect = controlTrigger.getBoundingClientRect();
  const clamped = MPV.clampFloatingPosition(
    position,
    { width: rect.width || controlTrigger.offsetWidth, height: rect.height || controlTrigger.offsetHeight },
    viewportSize(),
    FLOATING_PADDING,
  );
  controlTrigger.style.left = `${clamped.x}px`;
  controlTrigger.style.top = `${clamped.y}px`;
  return clamped;
}

async function persistTriggerPosition() {
  const rect = controlTrigger.getBoundingClientRect();
  const position = { x: rect.left, y: rect.top };
  await chrome.storage.local.set({ floatingTriggerPosition: position });
  if (gridInitialized) sendWorkspaceUiPatch({ ui: { floatingTriggerPosition: position } }).catch(() => {});
}

function positionFloatingPanel() {
  if (floatingPanel.hidden) return;
  const triggerRect = controlTrigger.getBoundingClientRect();
  const panelRect = floatingPanel.getBoundingClientRect();
  const position = MPV.computeFloatingPanelPosition(
    triggerRect,
    { width: panelRect.width, height: panelRect.height },
    viewportSize(),
    FLOATING_PADDING,
    FLOATING_GAP,
  );
  floatingPanel.style.left = `${position.x}px`;
  floatingPanel.style.top = `${position.y}px`;
}

function openFloatingPanel({ persist = true } = {}) {
  floatingPanel.hidden = false;
  controlTrigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(positionFloatingPanel);
  if (persist && gridInitialized) sendWorkspaceUiPatch({ ui: { floatingPanelOpen: true } }).catch(() => {});
}

function closeFloatingPanel({ persist = true } = {}) {
  floatingPanel.hidden = true;
  controlTrigger.setAttribute('aria-expanded', 'false');
  if (persist && gridInitialized) sendWorkspaceUiPatch({ ui: { floatingPanelOpen: false } }).catch(() => {});
}

function toggleFloatingPanel() {
  if (floatingPanel.hidden) openFloatingPanel(); else closeFloatingPanel();
}

function computeDims(n) {
  const c = Math.max(1, Math.ceil(Math.sqrt(n)));
  const r = Math.max(1, Math.ceil(n / c));
  return { cols: c, rows: r };
}

function applyGridTemplate() {
  container.style.gridTemplateColumns = colSizes.map((w) => `${w}fr`).join(` ${GUTTER}px `);
  container.style.gridTemplateRows = rowSizes.map((h) => `${h}fr`).join(` ${GUTTER}px `);
}

function clearSplitters() {
  colSplitters.forEach((splitter) => splitter.remove());
  rowSplitters.forEach((splitter) => splitter.remove());
  colSplitters = [];
  rowSplitters = [];
}

function makeSplitter(orientation, index) {
  const element = document.createElement('div');
  element.className = orientation === 'col' ? 'splitter splitter-col' : 'splitter splitter-row';
  element.dataset.orientation = orientation;
  element.dataset.index = String(index);
  element.setAttribute('role', 'separator');
  element.setAttribute('aria-orientation', orientation === 'col' ? 'vertical' : 'horizontal');
  return element;
}

function getResizeMetrics(orientation, index) {
  const sizes = orientation === 'col' ? colSizes : rowSizes;
  const count = orientation === 'col' ? cols : rows;
  const availablePx = (orientation === 'col' ? container.clientWidth : container.clientHeight) - (count - 1) * GUTTER;
  const totalFr = sizes.reduce((sum, value) => sum + value, 0);
  const frPerPx = totalFr / Math.max(1, availablePx);
  const minFr = MIN_TRACK_PX * frPerPx;
  return {
    sizes: [...sizes],
    frPerPx,
    minDelta: -Math.max(0, (sizes[index] - minFr) / frPerPx),
    maxDelta: Math.max(0, (sizes[index + 1] - minFr) / frPerPx),
  };
}

function beginResize(event, splitter) {
  if (event.button !== 0 || resizeDragState) return;
  const orientation = splitter.dataset.orientation;
  const index = Number(splitter.dataset.index);
  const metrics = getResizeMetrics(orientation, index);
  resizeDragState = {
    pointerId: event.pointerId,
    orientation,
    index,
    splitter,
    startPos: orientation === 'col' ? event.clientX : event.clientY,
    latestDelta: 0,
    rafId: null,
    ...metrics,
  };
  splitter.setPointerCapture(event.pointerId);
  splitter.classList.add('dragging');
  document.body.classList.add('resizing');
  document.body.style.cursor = orientation === 'col' ? 'col-resize' : 'row-resize';
  event.preventDefault();
}

function renderResizePreview() {
  if (!resizeDragState) return;
  resizeDragState.rafId = null;
  const { orientation, splitter, latestDelta } = resizeDragState;
  splitter.style.transform = orientation === 'col'
    ? `translate3d(${latestDelta}px, 0, 0)`
    : `translate3d(0, ${latestDelta}px, 0)`;
}

function moveResize(event) {
  if (!resizeDragState || event.pointerId !== resizeDragState.pointerId) return;
  const position = resizeDragState.orientation === 'col' ? event.clientX : event.clientY;
  const rawDelta = position - resizeDragState.startPos;
  resizeDragState.latestDelta = MPV.clamp(rawDelta, resizeDragState.minDelta, resizeDragState.maxDelta);
  if (resizeDragState.rafId == null) resizeDragState.rafId = requestAnimationFrame(renderResizePreview);
  event.preventDefault();
}

function finishResize(event) {
  if (!resizeDragState || event.pointerId !== resizeDragState.pointerId) return;
  const state = resizeDragState;
  if (state.rafId != null) cancelAnimationFrame(state.rafId);
  const deltaFr = state.latestDelta * state.frPerPx;
  const next = [...state.sizes];
  next[state.index] += deltaFr;
  next[state.index + 1] -= deltaFr;
  if (state.orientation === 'col') colSizes = next; else rowSizes = next;
  state.splitter.style.transform = '';
  state.splitter.classList.remove('dragging');
  if (state.splitter.hasPointerCapture(event.pointerId)) state.splitter.releasePointerCapture(event.pointerId);
  resizeDragState = null;
  document.body.classList.remove('resizing');
  document.body.style.cursor = '';
  applyGridTemplate();
  requestAnimationFrame(clampAllPaneControls);
  if (gridInitialized) {
    sendWorkspaceUiPatch({ layout: { cols, rows, colSizes: [...colSizes], rowSizes: [...rowSizes] } }).catch(() => {});
  }
}

function updatePaneCountUi() {
  const count = panes.length;
  countLabel.textContent = `${count} pane${count === 1 ? '' : 's'}`;
  triggerPaneCount.textContent = String(count);
  addBtn.disabled = count >= MAX_PANES;
  if (!floatingPanel.hidden) requestAnimationFrame(positionFloatingPanel);
}

function clampPaneControl(pane, position = pane.controlPosition || { x: PANE_CONTROL_PADDING, y: PANE_CONTROL_PADDING }) {
  const width = pane.wrapper.clientWidth;
  const height = pane.wrapper.clientHeight;
  const maxX = Math.max(PANE_CONTROL_PADDING, width - pane.control.offsetWidth - PANE_CONTROL_PADDING);
  const maxY = Math.max(PANE_CONTROL_PADDING, height - pane.control.offsetHeight - PANE_CONTROL_PADDING);
  const clamped = {
    x: MPV.clamp(position.x, PANE_CONTROL_PADDING, maxX),
    y: MPV.clamp(position.y, PANE_CONTROL_PADDING, maxY),
  };
  pane.controlPosition = clamped;
  pane.control.style.left = `${clamped.x}px`;
  pane.control.style.top = `${clamped.y}px`;
  return clamped;
}

function clampAllPaneControls() {
  panes.forEach((pane) => clampPaneControl(pane));
}

function beginPaneControlDrag(pane, event) {
  if (event.button !== 0 || paneControlDragState || resizeDragState) return;
  const rect = pane.control.getBoundingClientRect();
  const wrapperRect = pane.wrapper.getBoundingClientRect();
  paneControlDragState = {
    pane,
    pointerId: event.pointerId,
    captureTarget: event.currentTarget,
    startX: event.clientX,
    startY: event.clientY,
    originX: rect.left - wrapperRect.left,
    originY: rect.top - wrapperRect.top,
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  pane.control.classList.add('dragging');
  event.preventDefault();
  event.stopPropagation();
}

function movePaneControl(event) {
  if (!paneControlDragState || event.pointerId !== paneControlDragState.pointerId) return;
  const state = paneControlDragState;
  clampPaneControl(state.pane, {
    x: state.originX + event.clientX - state.startX,
    y: state.originY + event.clientY - state.startY,
  });
  event.preventDefault();
}

function endPaneControlDrag(event) {
  if (!paneControlDragState || event.pointerId !== paneControlDragState.pointerId) return;
  const state = paneControlDragState;
  if (state.captureTarget.hasPointerCapture(event.pointerId)) state.captureTarget.releasePointerCapture(event.pointerId);
  state.pane.control.classList.remove('dragging');
  paneControlDragState = null;
  if (gridInitialized) {
    portRequest('mpv:workspace-pane-patch', {
      workspaceId,
      paneId: state.pane.id,
      controlPosition: { ...state.pane.controlPosition },
    }).catch(() => {});
  }
}

function paneIds() {
  return panes.map((pane) => pane.id);
}

function paneUrls() {
  return panes.map((pane) => pane.urlInput.value || pane.pendingTargetUrl || '');
}

function sameHostAnalysis() {
  return MPV.analyzeSameHostUrls(paneUrls());
}

function setEnhancedOptIn(hostname, { persist = false } = {}) {
  enhancedOptInHostname = String(hostname || '').toLowerCase();
  if (enhancedOptInHostname) sessionStorage.setItem('mpv-enhanced-opt-in-hostname', enhancedOptInHostname);
  else sessionStorage.removeItem('mpv-enhanced-opt-in-hostname');
  if (persist && gridInitialized) sendWorkspaceUiPatch({ ui: { enhancedOptInHostname } }).catch(() => {});
}

function resolvePortReady() {
  for (const resolve of [...portReadyWaiters]) resolve(true);
  portReadyWaiters.clear();
}

function waitForPortReady(timeoutMs = PORT_REQUEST_TIMEOUT_MS) {
  if (gridPort && gridPortReady) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      portReadyWaiters.delete(done);
      resolve(false);
    }, timeoutMs);
    function done(value) {
      clearTimeout(timer);
      resolve(value);
    }
    portReadyWaiters.add(done);
  });
}

function failPendingPortRequests() {
  for (const pending of pendingPortRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ ok: false, disconnected: true });
  }
  pendingPortRequests.clear();
  for (const resolve of [...portReadyWaiters]) resolve(false);
  portReadyWaiters.clear();
}

function portPost(message) {
  if (!gridPort || !gridPortReady) return false;
  try {
    gridPort.postMessage({ ...message, sessionId });
    return true;
  } catch {
    return false;
  }
}

function portRequest(type, payload = {}) {
  if (!gridPort || !gridPortReady) return Promise.resolve({ ok: false, disconnected: true });
  const requestId = `${sessionId}:${++requestSequence}`;
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      pendingPortRequests.delete(requestId);
      resolve({ ok: false, timeout: true });
    }, PORT_REQUEST_TIMEOUT_MS);
    pendingPortRequests.set(requestId, { resolve, timeoutId });
    if (!portPost({ type, requestId, ...payload })) {
      clearTimeout(timeoutId);
      pendingPortRequests.delete(requestId);
      resolve({ ok: false, disconnected: true });
    }
  });
}

function schedulePortReconnect() {
  if (reconnectTimer != null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectGridPort();
  }, PORT_RECONNECT_DELAY_MS);
}

function currentPaneUrl(snapshotPane) {
  if (!snapshotPane || !Array.isArray(snapshotPane.history) || !snapshotPane.history.length) return 'https://example.com/';
  const index = Math.min(Math.max(Number(snapshotPane.historyIndex) || 0, 0), snapshotPane.history.length - 1);
  return snapshotPane.history[index]?.url || 'https://example.com/';
}

function updateHistoryButtons(pane) {
  pane.backBtn.disabled = !(pane.historyIndex > 0);
  pane.forwardBtn.disabled = !(pane.historyIndex < pane.history.length - 1);
}

function applyWorkspaceState(snapshot, { initial = false } = {}) {
  if (!snapshot || !Array.isArray(snapshot.panes) || !snapshot.panes.length) return;
  currentWorkspace = snapshot;
  workspaceId = snapshot.workspaceId;
  setEnhancedOptIn(snapshot.ui?.enhancedOptInHostname || enhancedOptInHostname);

  const existingById = new Map(panes.map((pane) => [pane.id, pane]));
  const desired = [];
  for (const snapshotPane of snapshot.panes) {
    let pane = existingById.get(snapshotPane.paneId);
    const url = currentPaneUrl(snapshotPane);
    if (!pane) {
      pane = createPane(url, {
        paneId: snapshotPane.paneId,
        controlPosition: snapshotPane.controlPosition,
        history: snapshotPane.history,
        historyIndex: snapshotPane.historyIndex,
      });
      container.appendChild(pane.wrapper);
    } else {
      pane.history = snapshotPane.history.map((entry) => ({ ...entry }));
      pane.historyIndex = snapshotPane.historyIndex;
      pane.pendingTargetUrl = url;
      pane.urlInput.value = url;
      pane.controlPosition = { ...snapshotPane.controlPosition };
      updateHistoryButtons(pane);
    }
    desired.push(pane);
    paneRegistry.set(pane.id, pane);
    existingById.delete(snapshotPane.paneId);
  }
  for (const pane of existingById.values()) { paneRegistry.delete(pane.id); pane.wrapper.remove(); }
  panes = desired;
  for (const pane of panes) container.appendChild(pane.wrapper);

  const dims = computeDims(panes.length);
  cols = dims.cols;
  rows = dims.rows;
  colSizes = Array.isArray(snapshot.layout?.colSizes) && snapshot.layout.colSizes.length === cols
    ? snapshot.layout.colSizes.map(Number) : new Array(cols).fill(1);
  rowSizes = Array.isArray(snapshot.layout?.rowSizes) && snapshot.layout.rowSizes.length === rows
    ? snapshot.layout.rowSizes.map(Number) : new Array(rows).fill(1);
  layoutPanes({ preserveTrackSizes: true });

  panes.forEach((pane) => {
    pane.wrapper.classList.toggle('logical-active', pane.id === snapshot.activePaneId);
    requestAnimationFrame(() => clampPaneControl(pane, pane.controlPosition));
  });
  const position = snapshot.ui?.floatingTriggerPosition;
  if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) setTriggerPosition(position);
  if (snapshot.ui?.floatingPanelOpen) openFloatingPanel({ persist: false }); else closeFloatingPanel({ persist: false });
  if (!initial) updateEnhancedUi();
}

function handleGridPortMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'mpv:request-result') {
    const pending = pendingPortRequests.get(message.requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    pendingPortRequests.delete(message.requestId);
    pending.resolve(message);
    return;
  }
  if (message.type === 'mpv:background-ready' && message.sessionId === sessionId) {
    gridPortReady = true;
    resolvePortReady();
    if (gridInitialized && workspaceId) registerWorkspace().then(() => syncEnhancedSession()).catch(() => {});
    return;
  }
  if (message.type === 'mpv:workspace-state' && message.workspace?.workspaceId === workspaceId) {
    applyWorkspaceState(message.workspace);
    return;
  }
  if (message.type === 'mpv:pane-rebind' && message.workspaceId === workspaceId) {
    const pane = panes.find((item) => item.id === message.paneId);
    if (pane) rebindPane(pane);
    return;
  }
  if (message.type === 'mpv:pane-state') {
    const pane = panes.find((item) => item.id === message.paneId);
    if (!pane) return;
    if (message.url) pane.urlInput.value = message.url;
    pane.wrapper.dataset.title = message.title || '';
    pane.wrapper.classList.toggle('loading', message.loading === true);
    if (message.focused) setActivePane(pane, { persist: true });
    if (message.detached === true || (message.url && enhancedHostname && (() => {
      try { return new URL(message.url).hostname.toLowerCase() !== enhancedHostname; } catch { return true; }
    })())) {
      stopEnhancedSession().catch(() => {});
      return;
    }
    scheduleEnhancedSync();
    return;
  }
  if (message.type === 'mpv:popup-candidate' && message.sessionId === sessionId) {
    handlePopupCandidate(message).catch(() => {
      portPost({ type: 'mpv:popup-result', candidateId: message.candidateId, accepted: false });
    });
  }
}

function connectGridPort() {
  if (gridPort) return;
  try {
    const port = chrome.runtime.connect({ name: `mpv-grid:${sessionId}` });
    gridPort = port;
    gridPortReady = false;
    port.onMessage.addListener(handleGridPortMessage);
    port.onDisconnect.addListener(() => {
      if (gridPort !== port) return;
      gridPort = null;
      gridPortReady = false;
      failPendingPortRequests();
      enhancedActive = false;
      enhancedHostname = '';
      updateEnhancedUi();
      schedulePortReconnect();
    });
  } catch {
    gridPort = null;
    gridPortReady = false;
    schedulePortReconnect();
  }
}

function setEnhancedActionsVisible(visible) {
  panes.forEach((pane) => pane.enhancedButtons.forEach((button) => { button.hidden = !visible; }));
  requestAnimationFrame(clampAllPaneControls);
}

function updateEnhancedUi(analysis = sameHostAnalysis()) {
  if (!enhancedToggle) return;
  enhancedToggle.classList.toggle('active', enhancedActive);
  enhancedToggle.disabled = !analysis.eligible && analysis.reason === 'mixed-host';
  const label = enhancedToggle.lastElementChild;
  if (enhancedActive) label.textContent = 'Enhanced: On';
  else if (analysis.reason === 'mixed-host') label.textContent = 'Enhanced: Mixed hosts';
  else label.textContent = 'Enhanced: Off';
  setEnhancedActionsVisible(enhancedActive);
}

async function stopEnhancedSession() {
  const wasActive = enhancedActive;
  enhancedActive = false;
  enhancedHostname = '';
  updateEnhancedUi();
  if (wasActive && gridPortReady) await portRequest('mpv:session-stop');
}

async function syncEnhancedSession() {
  const analysis = sameHostAnalysis();
  if (!analysis.eligible || analysis.hostname !== enhancedOptInHostname) {
    await stopEnhancedSession();
    updateEnhancedUi(analysis);
    return false;
  }
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: analysis.origins }); } catch { granted = false; }
  if (!granted || !gridPortReady) {
    await stopEnhancedSession();
    updateEnhancedUi(analysis);
    return false;
  }
  if (enhancedActive && enhancedHostname && enhancedHostname !== analysis.hostname) await stopEnhancedSession();
  const response = await portRequest(
    enhancedActive ? 'mpv:session-update' : 'mpv:session-start',
    enhancedActive ? { paneIds: paneIds() } : { hostname: analysis.hostname, paneIds: paneIds() },
  );
  enhancedActive = response?.ok === true;
  enhancedHostname = enhancedActive ? analysis.hostname : '';
  updateEnhancedUi(analysis);
  return enhancedActive;
}

function scheduleEnhancedSync() {
  if (!gridInitialized) return;
  if (enhancedSyncTimer != null) clearTimeout(enhancedSyncTimer);
  enhancedSyncTimer = setTimeout(() => {
    enhancedSyncTimer = null;
    syncEnhancedSession().catch(() => {});
  }, 0);
}

async function enableEnhancedFromGesture() {
  const analysis = sameHostAnalysis();
  if (!analysis.eligible) { updateEnhancedUi(analysis); return false; }
  let granted = false;
  try { granted = await chrome.permissions.request({ origins: analysis.origins }); } catch { granted = false; }
  if (!granted) { updateEnhancedUi(analysis); return false; }
  setEnhancedOptIn(analysis.hostname, { persist: true });
  return syncEnhancedSession();
}

async function handlePopupCandidate(message) {
  let pane = null;
  if (enhancedActive && panes.length < MAX_PANES) {
    const analysis = MPV.analyzeSameHostUrls([...paneUrls(), message.targetUrl]);
    if (analysis.eligible && analysis.hostname === enhancedHostname) pane = await addPane(message.targetUrl);
  }
  portPost({ type: 'mpv:popup-result', candidateId: message.candidateId, accepted: Boolean(pane) });
}

function layoutPanes({ preserveTrackSizes = false } = {}) {
  const count = panes.length;
  const dims = computeDims(count);
  if (!preserveTrackSizes) {
    if (dims.cols !== cols) colSizes = new Array(dims.cols).fill(1);
    if (dims.rows !== rows) rowSizes = new Array(dims.rows).fill(1);
  }
  cols = dims.cols;
  rows = dims.rows;
  if (colSizes.length !== cols) colSizes = new Array(cols).fill(1);
  if (rowSizes.length !== rows) rowSizes = new Array(rows).fill(1);
  applyGridTemplate();
  panes.forEach((pane, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    pane.wrapper.style.gridColumn = `${2 * col + 1}`;
    pane.wrapper.style.gridRow = `${2 * row + 1}`;
    pane.indexLabel.textContent = String(index + 1);
  });
  const lastRowStartIndex = (rows - 1) * cols;
  const itemsInLastRow = count - lastRowStartIndex;
  if (count > 0 && itemsInLastRow > 0 && itemsInLastRow < cols) {
    const col = (count - 1) % cols;
    panes[count - 1].wrapper.style.gridColumn = `${2 * col + 1} / -1`;
  }
  clearSplitters();
  for (let index = 0; index < cols - 1; index += 1) {
    const splitter = makeSplitter('col', index);
    splitter.style.gridColumn = `${2 * index + 2}`;
    splitter.style.gridRow = '1 / -1';
    container.appendChild(splitter);
    colSplitters.push(splitter);
  }
  for (let index = 0; index < rows - 1; index += 1) {
    const splitter = makeSplitter('row', index);
    splitter.style.gridRow = `${2 * index + 2}`;
    splitter.style.gridColumn = '1 / -1';
    container.appendChild(splitter);
    rowSplitters.push(splitter);
  }
  updatePaneCountUi();
  updateEnhancedUi();
  requestAnimationFrame(clampAllPaneControls);
}

function bootstrapUrlForPane(paneId) {
  const url = new URL(chrome.runtime.getURL('pane-bootstrap.html'));
  url.searchParams.set('workspace', workspaceId);
  url.searchParams.set('pane', paneId);
  return url.toString();
}

function setActivePane(pane, { persist = true } = {}) {
  if (!pane) return;
  panes.forEach((item) => item.wrapper.classList.toggle('logical-active', item === pane));
  if (persist && gridInitialized) sendWorkspaceUiPatch({ activePaneId: pane.id }).catch(() => {});
}

function navigatePaneTo(pane, url, { bootstrap = false } = {}) {
  const target = MPV.normalizeUrl(url);
  if (!/^https?:\/\//i.test(target)) return false;
  pane.pendingTargetUrl = target;
  pane.urlInput.value = target;
  if (bootstrap) pane.iframe.src = bootstrapUrlForPane(pane.id);
  else pane.iframe.src = target;
  return true;
}

function rebindPane(pane) {
  const url = pane.history[pane.historyIndex]?.url || pane.urlInput.value;
  navigatePaneTo(pane, url, { bootstrap: true });
}

function reloadPane(pane) {
  const target = pane.urlInput.value || pane.history[pane.historyIndex]?.url;
  if (target) pane.iframe.src = target;
}

async function navigateHistory(pane, direction) {
  const response = await portRequest('mpv:history-traverse', { workspaceId, paneId: pane.id, direction });
  if (response?.ok && response.url) navigatePaneTo(pane, response.url);
}

function goTo(pane) {
  const target = MPV.normalizeUrl(pane.urlInput.value);
  pane.urlInput.value = target;
  if (target === pane.history[pane.historyIndex]?.url) reloadPane(pane);
  else navigatePaneTo(pane, target);
  scheduleEnhancedSync();
}

function createPane(url, options = {}) {
  const paneId = options.paneId || crypto.randomUUID();
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';
  wrapper.dataset.paneId = paneId;
  const iframe = document.createElement('iframe');
  iframe.className = 'pane-iframe';
  iframe.name = `focus-pane:${paneId}`;
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
  const history = Array.isArray(options.history) && options.history.length
    ? options.history.map((entry) => ({ url: String(entry.url) }))
    : [{ url: MPV.normalizeUrl(url) }];
  const historyIndex = Math.min(Math.max(Number.isInteger(options.historyIndex) ? options.historyIndex : history.length - 1, 0), history.length - 1);
  const targetUrl = history[historyIndex]?.url || MPV.normalizeUrl(url);
  iframe.src = bootstrapUrlForPane(paneId);

  const control = document.createElement('div');
  control.className = 'pane-control';
  const grip = document.createElement('button');
  grip.type = 'button';
  grip.className = 'pane-control-grip';
  grip.title = 'Drag pane controls';
  grip.setAttribute('aria-label', 'Drag pane controls');
  const gripMark = document.createElement('span');
  gripMark.className = 'pane-control-grip-mark';
  gripMark.textContent = '••';
  gripMark.setAttribute('aria-hidden', 'true');
  const indexLabel = document.createElement('span');
  indexLabel.className = 'pane-control-index';
  indexLabel.textContent = '?';
  indexLabel.setAttribute('aria-hidden', 'true');
  grip.append(gripMark, indexLabel);
  const details = document.createElement('div');
  details.className = 'pane-control-details';
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'pane-control-action';
  backBtn.textContent = '‹';
  backBtn.title = 'Back';
  backBtn.setAttribute('aria-label', 'Back');
  const forwardBtn = document.createElement('button');
  forwardBtn.type = 'button';
  forwardBtn.className = 'pane-control-action';
  forwardBtn.textContent = '›';
  forwardBtn.title = 'Forward';
  forwardBtn.setAttribute('aria-label', 'Forward');
  const urlInput = document.createElement('input');
  urlInput.className = 'pane-url';
  urlInput.type = 'text';
  urlInput.autocomplete = 'off';
  urlInput.value = targetUrl;
  urlInput.placeholder = 'URL or search';
  urlInput.setAttribute('aria-label', 'Pane URL');
  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'pane-control-action';
  reloadBtn.textContent = '↻';
  reloadBtn.title = 'Refresh pane';
  reloadBtn.setAttribute('aria-label', 'Refresh pane');
  const nativeBtn = document.createElement('button');
  nativeBtn.type = 'button';
  nativeBtn.className = 'pane-control-action enhanced-only';
  nativeBtn.hidden = !enhancedActive;
  nativeBtn.textContent = '↗';
  nativeBtn.title = 'Open in native tab';
  nativeBtn.setAttribute('aria-label', 'Open in native tab');
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pane-control-action close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Close pane';
  closeBtn.setAttribute('aria-label', 'Close pane');
  details.append(backBtn, forwardBtn, urlInput, reloadBtn, nativeBtn, closeBtn);
  control.append(grip, details);
  wrapper.append(iframe, control);

  const pane = {
    id: paneId,
    wrapper,
    iframe,
    control,
    grip,
    indexLabel,
    urlInput,
    backBtn,
    forwardBtn,
    enhancedButtons: [nativeBtn],
    controlPosition: options.controlPosition ? { ...options.controlPosition } : { x: PANE_CONTROL_PADDING, y: PANE_CONTROL_PADDING },
    history,
    historyIndex,
    pendingTargetUrl: targetUrl,
  };
  updateHistoryButtons(pane);
  paneRegistry.set(paneId, pane);

  grip.addEventListener('pointerdown', (event) => beginPaneControlDrag(pane, event));
  grip.addEventListener('pointermove', movePaneControl);
  grip.addEventListener('pointerup', endPaneControlDrag);
  grip.addEventListener('pointercancel', endPaneControlDrag);
  control.addEventListener('pointerenter', () => requestAnimationFrame(() => clampPaneControl(pane)));
  control.addEventListener('focusin', () => { setActivePane(pane); requestAnimationFrame(() => clampPaneControl(pane)); });
  wrapper.addEventListener('pointerdown', () => setActivePane(pane));
  urlInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') goTo(pane); });
  iframe.addEventListener('load', scheduleEnhancedSync);
  backBtn.addEventListener('click', () => navigateHistory(pane, 'back').catch(() => {}));
  forwardBtn.addEventListener('click', () => navigateHistory(pane, 'forward').catch(() => {}));
  reloadBtn.addEventListener('click', () => reloadPane(pane));
  nativeBtn.addEventListener('click', () => { chrome.tabs.create({ url: urlInput.value || targetUrl }).catch(() => {}); });
  closeBtn.addEventListener('click', () => { removePane(wrapper).catch(() => {}); });
  return pane;
}

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin) return;
  const message = event.data;
  if (message?.type !== 'mpv:pane-bootstrap-ready' || message.workspaceId !== workspaceId) return;
  const candidate = paneRegistry.get(message.paneId);
  const pane = candidate && event.source === candidate.iframe.contentWindow ? candidate : null;
  if (!pane) return;
  pane.iframe.contentWindow.postMessage({
    type: 'mpv:pane-bootstrap-target',
    workspaceId,
    paneId: pane.id,
    targetUrl: pane.pendingTargetUrl,
  }, location.origin);
});

async function removePane(wrapper) {
  const pane = panes.find((item) => item.wrapper === wrapper);
  if (!pane || panes.length <= 1) return false;
  if (!gridInitialized) {
    paneRegistry.delete(pane.id);
    wrapper.remove();
    panes = panes.filter((item) => item !== pane);
    layoutPanes();
    return true;
  }
  const response = await portRequest('mpv:workspace-pane-remove', { workspaceId, paneId: pane.id });
  if (!response?.ok) return false;
  if (response.workspace) applyWorkspaceState(response.workspace);
  scheduleEnhancedSync();
  return true;
}

async function addPane(url, options = {}) {
  const target = MPV.normalizeUrl(url || '');
  if (!/^https?:\/\//i.test(target) || panes.length >= MAX_PANES) return null;
  if (options.persist === false || !gridInitialized) {
    const pane = createPane(target, options);
    container.appendChild(pane.wrapper);
    panes.push(pane);
    layoutPanes();
    scheduleEnhancedSync();
    return pane;
  }
  const paneId = options.paneId || crypto.randomUUID();
  const response = await portRequest('mpv:workspace-pane-add', { workspaceId, paneId, url: target });
  if (!response?.ok) return null;
  if (response.workspace) applyWorkspaceState(response.workspace);
  scheduleEnhancedSync();
  return panes.find((pane) => pane.id === paneId) || null;
}

function compatRuleId() {
  return Number.isInteger(currentTabId) && currentTabId > 0 ? currentTabId : 1;
}

function setCompatibilityUi(enabled) {
  compatEnabled = enabled === true;
  compatBtn.lastElementChild.textContent = compatEnabled ? 'Compatibility: On' : 'Compatibility: Off';
  compatBtn.classList.toggle('active', compatEnabled);
}

async function enableCompatRules() {
  if (currentTabId == null) throw new Error('Could not identify this tab.');
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [compatRuleId()],
    addRules: [{
      id: compatRuleId(),
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
          { header: 'content-security-policy-report-only', operation: 'remove' },
        ],
      },
      condition: { tabIds: [currentTabId], resourceTypes: ['sub_frame'] },
    }],
  });
  setCompatibilityUi(true);
}

async function disableCompatRules() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [compatRuleId()] });
  setCompatibilityUi(false);
}

async function toggleCompat() {
  try {
    if (!compatEnabled) {
      const granted = await chrome.permissions.request(COMPAT_ORIGINS);
      if (!granted) return;
      await enableCompatRules();
      await sendWorkspaceUiPatch({ ui: { compatibilityEnabled: true } });
      panes.forEach((pane) => reloadPane(pane));
    } else {
      await disableCompatRules();
      await sendWorkspaceUiPatch({ ui: { compatibilityEnabled: false } });
      await chrome.permissions.remove(COMPAT_ORIGINS);
    }
  } catch (error) {
    alert(`Compatibility mode failed: ${error.message || error}`);
    console.error('Compatibility toggle failed:', error);
  }
}

function beginTriggerDrag(event) {
  if (event.button !== 0) return;
  const rect = controlTrigger.getBoundingClientRect();
  triggerDragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: rect.left,
    originY: rect.top,
    moved: false,
  };
  controlTrigger.setPointerCapture(event.pointerId);
  controlTrigger.classList.add('dragging');
  event.preventDefault();
}

function moveTrigger(event) {
  if (!triggerDragState || event.pointerId !== triggerDragState.pointerId) return;
  const dx = event.clientX - triggerDragState.startX;
  const dy = event.clientY - triggerDragState.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) triggerDragState.moved = true;
  const position = setTriggerPosition({ x: triggerDragState.originX + dx, y: triggerDragState.originY + dy });
  if (!floatingPanel.hidden) {
    floatingPanel.style.left = `${position.x}px`;
    requestAnimationFrame(positionFloatingPanel);
  }
}

async function endTriggerDrag(event) {
  if (!triggerDragState || event.pointerId !== triggerDragState.pointerId) return;
  const moved = triggerDragState.moved;
  if (controlTrigger.hasPointerCapture(event.pointerId)) controlTrigger.releasePointerCapture(event.pointerId);
  controlTrigger.classList.remove('dragging');
  triggerDragState = null;
  if (moved) suppressNextTriggerClick = true;
  await persistTriggerPosition();
  if (!floatingPanel.hidden) positionFloatingPanel();
}

function workspaceIdFromLocation() {
  return new URLSearchParams(location.search).get('workspace') || '';
}

function replaceWorkspaceUrl(nextWorkspaceId) {
  const url = new URL(location.href);
  url.searchParams.set('workspace', nextWorkspaceId);
  history.replaceState(null, '', url.toString());
}

async function registerWorkspace() {
  const requestedId = workspaceId || workspaceIdFromLocation();
  if (!requestedId) return null;
  const response = await portRequest('mpv:workspace-register', { workspaceId: requestedId });
  if (!response?.ok || !response.workspace) return null;
  workspaceId = response.workspaceId;
  if (workspaceId !== requestedId) replaceWorkspaceUrl(workspaceId);
  applyWorkspaceState(response.workspace, { initial: !gridInitialized });
  return response.workspace;
}

async function recoverWorkspace() {
  const legacy = await chrome.storage.session.get(['launchUrls']);
  const urls = Array.isArray(legacy.launchUrls) && legacy.launchUrls.length
    ? legacy.launchUrls.slice(0, MAX_PANES).map(MPV.normalizeUrl)
    : ['https://example.com', 'https://github.com'];
  const response = await portRequest('mpv:workspace-recover', { urls });
  if (!response?.ok || !response.workspace) throw new Error('Could not recover a workspace');
  workspaceId = response.workspaceId;
  replaceWorkspaceUrl(workspaceId);
  await chrome.storage.session.remove(['launchUrls', 'launchEnhancedHostname']);
  applyWorkspaceState(response.workspace, { initial: true });
  return response.workspace;
}

async function sendWorkspaceUiPatch(patch) {
  if (!workspaceId || !gridPortReady) return false;
  const response = await portRequest('mpv:workspace-ui-patch', { workspaceId, patch });
  if (response?.workspace) currentWorkspace = response.workspace;
  return response?.ok === true;
}

async function initFloatingUiFallback() {
  const result = await chrome.storage.local.get(['floatingTriggerPosition']);
  const rect = controlTrigger.getBoundingClientRect();
  const stored = result.floatingTriggerPosition;
  const defaultPosition = { x: window.innerWidth - rect.width - 18, y: 18 };
  setTriggerPosition(stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : defaultPosition);
}

async function restoreWorkspaceModes() {
  if (!currentWorkspace) return;
  setEnhancedOptIn(currentWorkspace.ui?.enhancedOptInHostname || '');
  if (currentWorkspace.ui?.compatibilityEnabled) {
    let granted = false;
    try { granted = await chrome.permissions.contains(COMPAT_ORIGINS); } catch { granted = false; }
    if (granted) await enableCompatRules(); else setCompatibilityUi(false);
  } else {
    setCompatibilityUi(false);
  }
  await syncEnhancedSession();
}

controlTrigger.addEventListener('pointerdown', beginTriggerDrag);
controlTrigger.addEventListener('pointermove', moveTrigger);
controlTrigger.addEventListener('pointerup', endTriggerDrag);
controlTrigger.addEventListener('pointercancel', endTriggerDrag);
controlTrigger.addEventListener('click', () => {
  if (suppressNextTriggerClick) { suppressNextTriggerClick = false; return; }
  toggleFloatingPanel();
});
container.addEventListener('pointerdown', (event) => {
  const splitter = event.target.closest('.splitter');
  if (splitter && container.contains(splitter)) beginResize(event, splitter);
});
window.addEventListener('pointermove', moveResize);
window.addEventListener('pointerup', finishResize);
window.addEventListener('pointercancel', finishResize);
addBtn.addEventListener('click', () => {
  const url = prompt('Enter URL for new pane:');
  if (url) addPane(url).catch(() => {});
});
if (enhancedToggle) enhancedToggle.addEventListener('click', () => { enableEnhancedFromGesture().catch(() => {}); });
compatBtn.addEventListener('click', () => { toggleCompat(); });
document.addEventListener('pointerdown', (event) => {
  if (floatingPanel.hidden) return;
  if (floatingPanel.contains(event.target) || controlTrigger.contains(event.target)) return;
  closeFloatingPanel();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !floatingPanel.hidden) { closeFloatingPanel(); controlTrigger.focus(); }
});
window.addEventListener('resize', () => {
  const rect = controlTrigger.getBoundingClientRect();
  setTriggerPosition({ x: rect.left, y: rect.top });
  persistTriggerPosition().catch((error) => console.error('Could not save trigger position:', error));
  clampAllPaneControls();
  if (!floatingPanel.hidden) requestAnimationFrame(positionFloatingPanel);
});
window.addEventListener('beforeunload', () => {
  if (gridPort && gridPortReady && enhancedActive) {
    try { gridPort.postMessage({ type: 'mpv:session-stop', sessionId }); } catch { /* closing */ }
  }
  try { gridPort?.disconnect(); } catch { /* closing */ }
});

async function init() {
  connectGridPort();
  const tab = await chrome.tabs.getCurrent();
  currentTabId = tab?.id ?? null;
  await initFloatingUiFallback();
  const ready = await waitForPortReady();
  if (!ready) throw new Error('Background service worker is unavailable');
  workspaceId = workspaceIdFromLocation();
  let workspace = workspaceId ? await registerWorkspace() : null;
  if (!workspace) workspace = await recoverWorkspace();
  gridInitialized = true;
  updateEnhancedUi();
  await restoreWorkspaceModes();
}

init().catch((error) => {
  console.error('Split view initialization failed:', error);
});
