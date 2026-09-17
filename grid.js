'use strict';

const MAX_PANES = MPV.MAX_PANES;
const GUTTER = 2;
const MIN_TRACK_PX = 120;
const COMPAT_RULE_ID = 1;
const FLOATING_PADDING = 12;
const FLOATING_GAP = 8;
const PANE_CONTROL_PADDING = 8;
const PORT_REQUEST_TIMEOUT_MS = 3000;
const PORT_RECONNECT_DELAY_MS = 250;

const container = document.getElementById('panesContainer');
const controlTrigger = document.getElementById('controlTrigger');
const floatingPanel = document.getElementById('floatingPanel');
const triggerPaneCount = document.getElementById('triggerPaneCount');
const addBtn = document.getElementById('addPane');
const enhancedToggle = document.getElementById('enhancedToggle');
const compatBtn = document.getElementById('compatToggle');
const countLabel = document.getElementById('paneCountLabel');

const sessionId = crypto.randomUUID();
const COMPAT_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };

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
const pendingPortRequests = new Map();

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
  await chrome.storage.local.set({ floatingTriggerPosition: { x: rect.left, y: rect.top } });
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

function openFloatingPanel() {
  floatingPanel.hidden = false;
  controlTrigger.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(positionFloatingPanel);
}

function closeFloatingPanel() {
  floatingPanel.hidden = true;
  controlTrigger.setAttribute('aria-expanded', 'false');
}

function toggleFloatingPanel() {
  if (floatingPanel.hidden) openFloatingPanel();
  else closeFloatingPanel();
}

function reloadIframe(iframe) {
  const src = iframe.src;
  iframe.src = 'about:blank';
  requestAnimationFrame(() => { iframe.src = src; });
}

function goTo(iframe, urlInput) {
  const target = MPV.normalizeUrl(urlInput.value);
  urlInput.value = target;
  if (target === iframe.src) reloadIframe(iframe);
  else iframe.src = target;
  scheduleEnhancedSync();
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
  if (state.orientation === 'col') colSizes = next;
  else rowSizes = next;

  state.splitter.style.transform = '';
  state.splitter.classList.remove('dragging');
  if (state.splitter.hasPointerCapture(event.pointerId)) state.splitter.releasePointerCapture(event.pointerId);
  resizeDragState = null;
  document.body.classList.remove('resizing');
  document.body.style.cursor = '';
  applyGridTemplate();
  requestAnimationFrame(clampAllPaneControls);
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
  const controlWidth = pane.control.offsetWidth;
  const controlHeight = pane.control.offsetHeight;
  const maxX = Math.max(PANE_CONTROL_PADDING, width - controlWidth - PANE_CONTROL_PADDING);
  const maxY = Math.max(PANE_CONTROL_PADDING, height - controlHeight - PANE_CONTROL_PADDING);
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
}

function paneIds() {
  return panes.map((pane) => pane.id);
}

function paneUrls() {
  return panes.map((pane) => pane.urlInput.value || pane.iframe.src);
}

function sameHostAnalysis() {
  return MPV.analyzeSameHostUrls(paneUrls());
}

function setEnhancedOptIn(hostname) {
  enhancedOptInHostname = String(hostname || '').toLowerCase();
  if (enhancedOptInHostname) sessionStorage.setItem('mpv-enhanced-opt-in-hostname', enhancedOptInHostname);
  else sessionStorage.removeItem('mpv-enhanced-opt-in-hostname');
}

function failPendingPortRequests() {
  for (const pending of pendingPortRequests.values()) {
    clearTimeout(pending.timeoutId);
    pending.resolve({ ok: false, disconnected: true });
  }
  pendingPortRequests.clear();
}

function portPost(message) {
  if (!gridPort || !gridPortReady) return false;
  const port = gridPort;
  try {
    port.postMessage({ ...message, sessionId });
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
    if (gridInitialized) syncEnhancedSession().catch(() => {});
    return;
  }

  if (message.type === 'mpv:pane-state') {
    const pane = panes.find((item) => item.id === message.paneId);
    if (!pane) return;
    if (message.url) pane.urlInput.value = message.url;
    pane.wrapper.dataset.title = message.title || '';
    pane.wrapper.classList.toggle('loading', message.loading === true);
    if (message.focused) {
      panes.forEach((item) => item.wrapper.classList.toggle('logical-active', item === pane));
    }
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
  panes.forEach((pane) => {
    pane.enhancedButtons.forEach((button) => { button.hidden = !visible; });
  });
  requestAnimationFrame(clampAllPaneControls);
}

function updateEnhancedUi(analysis = sameHostAnalysis()) {
  if (!enhancedToggle) return;
  enhancedToggle.classList.toggle('active', enhancedActive);
  enhancedToggle.disabled = !analysis.eligible && analysis.reason === 'mixed-host';
  const label = enhancedToggle.lastElementChild;
  if (enhancedActive) label.textContent = 'Enhanced: On';
  else if (analysis.reason === 'mixed-host') label.textContent = 'Enhanced: Mixed hosts';
  else if (analysis.eligible) label.textContent = 'Enhanced: Off';
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
  if (!analysis.eligible) {
    await stopEnhancedSession();
    updateEnhancedUi(analysis);
    return false;
  }

  if (analysis.hostname !== enhancedOptInHostname) {
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

  if (enhancedActive && enhancedHostname && enhancedHostname !== analysis.hostname) {
    await stopEnhancedSession();
  }

  const response = await portRequest(
    enhancedActive ? 'mpv:session-update' : 'mpv:session-start',
    enhancedActive
      ? { paneIds: paneIds() }
      : { hostname: analysis.hostname, paneIds: paneIds() },
  );

  enhancedActive = response?.ok === true;
  enhancedHostname = enhancedActive ? analysis.hostname : '';
  updateEnhancedUi(analysis);
  return enhancedActive;
}

let enhancedSyncTimer = null;
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
  if (!analysis.eligible) {
    updateEnhancedUi(analysis);
    return false;
  }

  let granted = false;
  try { granted = await chrome.permissions.request({ origins: analysis.origins }); } catch { granted = false; }
  if (!granted) {
    updateEnhancedUi(analysis);
    return false;
  }
  setEnhancedOptIn(analysis.hostname);
  return syncEnhancedSession();
}

async function sendPaneCommand(paneId, command) {
  if (!enhancedActive) return false;
  const response = await portRequest('mpv:pane-command', { paneId, command });
  return response?.ok === true;
}

async function handlePopupCandidate(message) {
  let pane = null;
  if (enhancedActive && panes.length < MAX_PANES) {
    const analysis = MPV.analyzeSameHostUrls([...paneUrls(), message.targetUrl]);
    if (analysis.eligible && analysis.hostname === enhancedHostname) {
      pane = addPane(message.targetUrl);
      await syncEnhancedSession();
    }
  }
  portPost({
    type: 'mpv:popup-result',
    candidateId: message.candidateId,
    accepted: Boolean(pane),
  });
}

function layoutPanes() {
  const count = panes.length;
  const dims = computeDims(count);
  if (dims.cols !== cols) colSizes = new Array(dims.cols).fill(1);
  if (dims.rows !== rows) rowSizes = new Array(dims.rows).fill(1);
  cols = dims.cols;
  rows = dims.rows;

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

function createPane(url) {
  const paneId = crypto.randomUUID();
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';
  wrapper.dataset.paneId = paneId;

  const iframe = document.createElement('iframe');
  iframe.className = 'pane-iframe';
  iframe.name = `focus-pane:${paneId}`;
  iframe.src = MPV.normalizeUrl(url);
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');

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

  const urlInput = document.createElement('input');
  urlInput.className = 'pane-url';
  urlInput.type = 'text';
  urlInput.autocomplete = 'off';
  urlInput.value = MPV.normalizeUrl(url);
  urlInput.placeholder = 'URL or search';
  urlInput.setAttribute('aria-label', 'Pane URL');

  function enhancedAction(label, title, command) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pane-control-action enhanced-only';
    button.hidden = !enhancedActive;
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.addEventListener('click', () => { sendPaneCommand(paneId, command).catch(() => {}); });
    return button;
  }

  const backBtn = enhancedAction('‹', 'Back', 'back');
  backBtn.title = 'Back';
  const forwardBtn = enhancedAction('›', 'Forward', 'forward');
  forwardBtn.title = 'Forward';

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
    enhancedButtons: [backBtn, forwardBtn, nativeBtn],
    controlPosition: { x: PANE_CONTROL_PADDING, y: PANE_CONTROL_PADDING },
  };

  grip.addEventListener('pointerdown', (event) => beginPaneControlDrag(pane, event));
  grip.addEventListener('pointermove', movePaneControl);
  grip.addEventListener('pointerup', endPaneControlDrag);
  grip.addEventListener('pointercancel', endPaneControlDrag);
  control.addEventListener('pointerenter', () => requestAnimationFrame(() => clampPaneControl(pane)));
  control.addEventListener('focusin', () => requestAnimationFrame(() => clampPaneControl(pane)));
  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') goTo(iframe, urlInput);
  });
  iframe.addEventListener('load', scheduleEnhancedSync);
  reloadBtn.addEventListener('click', () => reloadIframe(iframe));
  nativeBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: urlInput.value || iframe.src }).catch(() => {});
  });
  closeBtn.addEventListener('click', () => removePane(wrapper));

  return pane;
}

function removePane(wrapper) {
  const index = panes.findIndex((pane) => pane.wrapper === wrapper);
  if (index === -1) return false;
  wrapper.remove();
  panes.splice(index, 1);
  layoutPanes();
  scheduleEnhancedSync();
  return true;
}

function addPane(url) {
  if (panes.length >= MAX_PANES) return null;
  const pane = createPane(url || '');
  container.appendChild(pane.wrapper);
  panes.push(pane);
  layoutPanes();
  scheduleEnhancedSync();
  return pane;
}

async function enableCompatRules() {
  if (currentTabId == null) throw new Error('Could not identify this tab.');
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [COMPAT_RULE_ID],
    addRules: [{
      id: COMPAT_RULE_ID,
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
  compatEnabled = true;
  compatBtn.lastElementChild.textContent = 'Compatibility: On';
  compatBtn.classList.add('active');
}

async function disableCompatRules() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [COMPAT_RULE_ID] });
  compatEnabled = false;
  compatBtn.lastElementChild.textContent = 'Compatibility: Off';
  compatBtn.classList.remove('active');
}

async function toggleCompat() {
  try {
    if (!compatEnabled) {
      const granted = await chrome.permissions.request(COMPAT_ORIGINS);
      if (!granted) return;
      await enableCompatRules();
      panes.forEach((pane) => reloadIframe(pane.iframe));
    } else {
      await disableCompatRules();
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

controlTrigger.addEventListener('pointerdown', beginTriggerDrag);
controlTrigger.addEventListener('pointermove', moveTrigger);
controlTrigger.addEventListener('pointerup', endTriggerDrag);
controlTrigger.addEventListener('pointercancel', endTriggerDrag);
controlTrigger.addEventListener('click', () => {
  if (suppressNextTriggerClick) {
    suppressNextTriggerClick = false;
    return;
  }
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
  if (url) addPane(url);
});
if (enhancedToggle) enhancedToggle.addEventListener('click', () => { enableEnhancedFromGesture().catch(() => {}); });
compatBtn.addEventListener('click', () => { toggleCompat(); });

document.addEventListener('pointerdown', (event) => {
  if (floatingPanel.hidden) return;
  if (floatingPanel.contains(event.target) || controlTrigger.contains(event.target)) return;
  closeFloatingPanel();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !floatingPanel.hidden) {
    closeFloatingPanel();
    controlTrigger.focus();
  }
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

chrome.tabs.getCurrent(async (tab) => {
  currentTabId = tab ? tab.id : null;
  try {
    const alreadyGranted = await chrome.permissions.contains(COMPAT_ORIGINS);
    if (alreadyGranted && currentTabId != null) await enableCompatRules();
  } catch (error) {
    console.error('Could not auto-enable compatibility mode:', error);
  }
});

async function initFloatingUi() {
  const result = await chrome.storage.local.get(['floatingTriggerPosition']);
  const rect = controlTrigger.getBoundingClientRect();
  const stored = result.floatingTriggerPosition;
  const defaultPosition = { x: window.innerWidth - rect.width - 18, y: 18 };
  setTriggerPosition(
    stored && Number.isFinite(stored.x) && Number.isFinite(stored.y) ? stored : defaultPosition,
  );
}

async function initPanes() {
  const result = await chrome.storage.session.get(['launchUrls', 'launchEnhancedHostname']);
  if (typeof result.launchEnhancedHostname === 'string' && result.launchEnhancedHostname) {
    setEnhancedOptIn(result.launchEnhancedHostname);
  }
  await chrome.storage.session.remove('launchEnhancedHostname');
  const urls = (Array.isArray(result.launchUrls) && result.launchUrls.length
    ? result.launchUrls
    : ['https://example.com', 'https://github.com']
  ).slice(0, MAX_PANES);
  urls.forEach((url) => addPane(url));
}

connectGridPort();
Promise.all([initFloatingUi(), initPanes()]).then(() => {
  gridInitialized = true;
  updateEnhancedUi();
  syncEnhancedSession().catch(() => {});
}).catch((error) => {
  console.error('Split view initialization failed:', error);
});
