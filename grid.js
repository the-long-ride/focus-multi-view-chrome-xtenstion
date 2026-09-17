'use strict';

const MAX_PANES = MPV.MAX_PANES;
const GUTTER = 6;
const MIN_TRACK_PX = 120;
const COMPAT_RULE_ID = 1;
const FLOATING_PADDING = 12;
const FLOATING_GAP = 8;

const container = document.getElementById('panesContainer');
const controlTrigger = document.getElementById('controlTrigger');
const floatingPanel = document.getElementById('floatingPanel');
const triggerPaneCount = document.getElementById('triggerPaneCount');
const addBtn = document.getElementById('addPane');
const compatBtn = document.getElementById('compatToggle');
const countLabel = document.getElementById('paneCountLabel');

let panes = [];
let colSplitters = [];
let rowSplitters = [];
let cols = 1;
let rows = 1;
let colSizes = [1];
let rowSizes = [1];
let compatEnabled = false;
let currentTabId = null;
let dragState = null;
let suppressNextTriggerClick = false;
const COMPAT_ORIGINS = { origins: ['http://*/*', 'https://*/*'] };

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
  await chrome.storage.local.set({
    floatingTriggerPosition: { x: rect.left, y: rect.top },
  });
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
  if (target === iframe.src) reloadIframe(iframe);
  else iframe.src = target;
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
  let dragging = false;
  let startPos = 0;
  let sizesAtStart = [];

  element.addEventListener('mousedown', (event) => {
    dragging = true;
    element.classList.add('dragging');
    startPos = orientation === 'col' ? event.clientX : event.clientY;
    sizesAtStart = orientation === 'col' ? [...colSizes] : [...rowSizes];
    document.body.style.cursor = orientation === 'col' ? 'col-resize' : 'row-resize';
    event.preventDefault();
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging) return;
    const pos = orientation === 'col' ? event.clientX : event.clientY;
    const delta = pos - startPos;

    if (orientation === 'col') {
      const availablePx = container.clientWidth - (cols - 1) * GUTTER;
      const unitPx = availablePx / cols;
      const minFr = MIN_TRACK_PX / unitPx;
      const leftFr = sizesAtStart[index] + delta / unitPx;
      const rightFr = sizesAtStart[index + 1] - delta / unitPx;
      if (leftFr < minFr || rightFr < minFr) return;
      colSizes[index] = leftFr;
      colSizes[index + 1] = rightFr;
    } else {
      const availablePx = container.clientHeight - (rows - 1) * GUTTER;
      const unitPx = availablePx / rows;
      const minFr = MIN_TRACK_PX / unitPx;
      const topFr = sizesAtStart[index] + delta / unitPx;
      const bottomFr = sizesAtStart[index + 1] - delta / unitPx;
      if (topFr < minFr || bottomFr < minFr) return;
      rowSizes[index] = topFr;
      rowSizes[index + 1] = bottomFr;
    }
    applyGridTemplate();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    element.classList.remove('dragging');
    document.body.style.cursor = '';
  });

  return element;
}

function updatePaneCountUi() {
  const count = panes.length;
  countLabel.textContent = `${count} pane${count === 1 ? '' : 's'}`;
  triggerPaneCount.textContent = String(count);
  addBtn.disabled = count >= MAX_PANES;
  if (!floatingPanel.hidden) requestAnimationFrame(positionFloatingPanel);
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
}

function createPane(url) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pane';

  const toolbar = document.createElement('div');
  toolbar.className = 'pane-toolbar';

  const urlInput = document.createElement('input');
  urlInput.className = 'pane-url';
  urlInput.type = 'text';
  urlInput.value = url;
  urlInput.placeholder = 'Enter URL or search';
  urlInput.setAttribute('aria-label', 'Pane URL');

  const reloadBtn = document.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.textContent = '⟳';
  reloadBtn.title = 'Refresh pane';
  reloadBtn.setAttribute('aria-label', 'Refresh pane');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.title = 'Close pane';
  closeBtn.setAttribute('aria-label', 'Close pane');

  toolbar.append(urlInput, reloadBtn, closeBtn);

  const iframe = document.createElement('iframe');
  iframe.className = 'pane-iframe';
  iframe.name = `pane-${crypto.randomUUID()}`;
  iframe.src = MPV.normalizeUrl(url);
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups');

  wrapper.append(toolbar, iframe);

  urlInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') goTo(iframe, urlInput);
  });
  reloadBtn.addEventListener('click', () => reloadIframe(iframe));
  closeBtn.addEventListener('click', () => removePane(wrapper));

  return { wrapper, iframe };
}

function removePane(wrapper) {
  const index = panes.findIndex((pane) => pane.wrapper === wrapper);
  if (index === -1) return;
  wrapper.remove();
  panes.splice(index, 1);
  layoutPanes();
}

function addPane(url) {
  if (panes.length >= MAX_PANES) return;
  const pane = createPane(url || '');
  container.appendChild(pane.wrapper);
  panes.push(pane);
  layoutPanes();
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
      condition: {
        tabIds: [currentTabId],
        resourceTypes: ['sub_frame'],
      },
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
  dragState = {
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
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
  const position = setTriggerPosition({ x: dragState.originX + dx, y: dragState.originY + dy });
  if (!floatingPanel.hidden) {
    floatingPanel.style.left = `${position.x}px`;
    requestAnimationFrame(positionFloatingPanel);
  }
}

async function endTriggerDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const moved = dragState.moved;
  if (controlTrigger.hasPointerCapture(event.pointerId)) controlTrigger.releasePointerCapture(event.pointerId);
  controlTrigger.classList.remove('dragging');
  dragState = null;
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

addBtn.addEventListener('click', () => {
  const url = prompt('Enter URL for new pane:');
  if (url) addPane(url);
});
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
  if (!floatingPanel.hidden) requestAnimationFrame(positionFloatingPanel);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.theme) MPV.applyTheme(changes.theme.newValue);
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
  await MPV.loadTheme();
  const result = await chrome.storage.local.get(['floatingTriggerPosition']);
  const rect = controlTrigger.getBoundingClientRect();
  const stored = result.floatingTriggerPosition;
  const defaultPosition = {
    x: window.innerWidth - rect.width - 18,
    y: 18,
  };
  setTriggerPosition(
    stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)
      ? stored
      : defaultPosition,
  );
}

async function initPanes() {
  const result = await chrome.storage.session.get(['launchUrls']);
  const urls = (Array.isArray(result.launchUrls) && result.launchUrls.length
    ? result.launchUrls
    : ['https://example.com', 'https://github.com']
  ).slice(0, MAX_PANES);
  urls.forEach((url) => addPane(url));
}

Promise.all([initFloatingUi(), initPanes()]).catch((error) => {
  console.error('Split view initialization failed:', error);
});
