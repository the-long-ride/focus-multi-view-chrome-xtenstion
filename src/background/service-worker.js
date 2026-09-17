'use strict';

importScripts('frame-registry.js', 'popup-router.js');

const registry = new MPVFrameRegistry.FrameRegistry();
const MAX_PANES = 9;
const GRID_PORT_PREFIX = 'mpv-grid:';
const GRID_URL = chrome.runtime.getURL('grid.html');
const POPUP_ACK_TIMEOUT_MS = 2500;
const gridPorts = new Map();
const pendingPopups = new Map();
let popupSequence = 0;

function senderTabId(sender) {
  return Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
}

function hostnameOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function sessionIdFromPortName(name) {
  const value = String(name || '');
  return value.startsWith(GRID_PORT_PREFIX) ? value.slice(GRID_PORT_PREFIX.length) : '';
}

function isTrustedGridPort(port, sessionId) {
  return Boolean(
    sessionId
    && port?.sender?.url === GRID_URL
    && Number.isInteger(senderTabId(port.sender)),
  );
}

function postToGrid(tabId, message) {
  const entry = gridPorts.get(tabId);
  if (!entry) return false;
  try {
    entry.port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function postResult(port, requestId, ok, extra = {}) {
  if (!requestId) return;
  try { port.postMessage({ type: 'mpv:request-result', requestId, ok: Boolean(ok), ...extra }); } catch { /* disconnected */ }
}

async function injectBridge(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ['src/pane/bridge.js'],
  });
}

async function seedAndInjectSessionFrames(tabId) {
  const session = registry.getSession(tabId);
  if (!session) return;
  let frames = [];
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }) || []; } catch { return; }
  for (const frame of frames) {
    if (!Number.isInteger(frame.frameId) || frame.frameId <= 0 || !frame.documentId) continue;
    if (hostnameOf(frame.url) !== session.hostname) continue;
    if (!registry.recordCommittedDocument({ tabId, frameId: frame.frameId, documentId: frame.documentId, url: frame.url })) continue;
    try { await injectBridge(tabId, frame.frameId); } catch { /* basic mode remains available */ }
  }
}

function publishPane(record, extra = {}) {
  if (!record) return false;
  return postToGrid(record.tabId, { type: 'mpv:pane-state', ...record, ...extra });
}

function clearPendingPopup(candidateId) {
  const pending = pendingPopups.get(candidateId);
  if (!pending) return null;
  clearTimeout(pending.timeoutId);
  pendingPopups.delete(candidateId);
  return pending;
}

async function finishPopupCandidate(candidateId, accepted) {
  const pending = clearPendingPopup(candidateId);
  if (!pending || accepted !== true) return false;
  try {
    await chrome.tabs.remove(pending.popupTabId);
    return true;
  } catch {
    return false;
  }
}

function clearPendingForSession(tabId, sessionId) {
  for (const [candidateId, pending] of [...pendingPopups.entries()]) {
    if (pending.sourceTabId === tabId && pending.sessionId === sessionId) clearPendingPopup(candidateId);
  }
}

function handleGridPortMessage(port, tabId, sessionId, message) {
  if (!message || typeof message !== 'object') return;
  if (message.sessionId && message.sessionId !== sessionId) {
    postResult(port, message.requestId, false);
    return;
  }

  if (message.type === 'mpv:session-start') {
    const session = registry.registerSession({
      tabId,
      sessionId,
      hostname: message.hostname,
      paneIds: message.paneIds,
    });
    postResult(port, message.requestId, Boolean(session));
    if (session) seedAndInjectSessionFrames(tabId).catch(() => {});
    return;
  }

  if (message.type === 'mpv:session-update') {
    const ok = registry.updateSessionPanes(tabId, sessionId, message.paneIds);
    postResult(port, message.requestId, ok);
    return;
  }

  if (message.type === 'mpv:session-stop') {
    const session = registry.getSession(tabId);
    if (session?.sessionId === sessionId) registry.removeSession(tabId);
    clearPendingForSession(tabId, sessionId);
    postResult(port, message.requestId, true);
    return;
  }

  if (message.type === 'mpv:pane-command') {
    const record = registry.getPane(tabId, message.paneId);
    if (!record || !['back', 'forward'].includes(message.command)) {
      postResult(port, message.requestId, false);
      return;
    }
    chrome.tabs.sendMessage(
      tabId,
      { type: 'mpv:bridge-command', paneId: record.paneId, command: message.command },
      { frameId: record.frameId, documentId: record.documentId },
    ).then(
      () => postResult(port, message.requestId, true),
      () => postResult(port, message.requestId, false),
    );
    return;
  }

  if (message.type === 'mpv:popup-result') {
    const pending = pendingPopups.get(message.candidateId);
    if (!pending || pending.sourceTabId !== tabId || pending.sessionId !== sessionId) return;
    finishPopupCandidate(message.candidateId, message.accepted === true).catch(() => {});
  }
}

chrome.runtime.onConnect.addListener((port) => {
  const sessionId = sessionIdFromPortName(port.name);
  const tabId = senderTabId(port.sender);
  if (!isTrustedGridPort(port, sessionId) || !Number.isInteger(tabId)) return;

  const previous = gridPorts.get(tabId);
  if (previous && previous.port !== port) {
    try { previous.port.disconnect(); } catch { /* stale port */ }
  }
  gridPorts.set(tabId, { port, sessionId });

  port.onMessage.addListener((message) => handleGridPortMessage(port, tabId, sessionId, message));
  port.onDisconnect.addListener(() => {
    const current = gridPorts.get(tabId);
    if (current?.port !== port) return;
    gridPorts.delete(tabId);
    const session = registry.getSession(tabId);
    if (session?.sessionId === sessionId) registry.removeSession(tabId);
    clearPendingForSession(tabId, sessionId);
  });

  try { port.postMessage({ type: 'mpv:background-ready', sessionId }); } catch { /* disconnected */ }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'mpv:bridge-register' && message?.type !== 'mpv:bridge-state') return undefined;

  const tabId = senderTabId(sender);
  if (!Number.isInteger(tabId) || !Number.isInteger(sender.frameId) || sender.frameId <= 0 || !sender.documentId) {
    sendResponse({ ok: false });
    return false;
  }

  const input = {
    tabId,
    frameId: sender.frameId,
    documentId: sender.documentId,
    paneId: message.paneId,
    url: message.url,
    title: message.title,
    focused: message.focused,
  };
  const record = message.type === 'mpv:bridge-register'
    ? registry.registerPaneFrame(input)
    : registry.updatePaneFrame(input);
  if (record) publishPane(record);
  sendResponse({ ok: Boolean(record) });
  return false;
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId <= 0) return;
  publishPane(registry.setFrameLoading(details.tabId, details.frameId, true));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId <= 0 || !details.documentId) return;
  const session = registry.getSession(details.tabId);
  if (!session) return;

  const previous = registry.findPaneByFrame(details.tabId, details.frameId);
  if (hostnameOf(details.url) !== session.hostname) {
    if (previous) publishPane({ ...previous, url: details.url, loading: false }, { detached: true });
    registry.removeFrame(details.tabId, details.frameId);
    return;
  }

  if (!registry.recordCommittedDocument({
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    url: details.url,
  })) return;
  injectBridge(details.tabId, details.frameId).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const record = registry.findPaneByFrame(details.tabId, details.frameId);
  if (!record || record.documentId !== details.documentId) return;
  publishPane(registry.updatePaneFrame({ ...record, url: details.url }));
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId <= 0) return;
  publishPane(registry.setFrameLoading(details.tabId, details.frameId, false));
});

chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId <= 0) return;
  publishPane(registry.setFrameLoading(details.tabId, details.frameId, false));
});

chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  const source = registry.findPaneByFrame(details.sourceTabId, details.sourceFrameId);
  const session = registry.getSession(details.sourceTabId);
  const portEntry = gridPorts.get(details.sourceTabId);
  if (!source || !session || portEntry?.sessionId !== session.sessionId) return;

  const route = MPVPopupRouter.decidePopupRoute({
    sourceRegistered: true,
    sessionHostname: session.hostname,
    targetUrl: details.url,
    paneCount: session.paneIds.length,
    maxPanes: MAX_PANES,
  });
  if (route.action !== 'pane') return;

  const candidateId = `${details.sourceTabId}:${++popupSequence}:${Date.now()}`;
  const timeoutId = setTimeout(() => clearPendingPopup(candidateId), POPUP_ACK_TIMEOUT_MS);
  pendingPopups.set(candidateId, {
    candidateId,
    sourceTabId: details.sourceTabId,
    popupTabId: details.tabId,
    sessionId: session.sessionId,
    timeoutId,
  });

  const posted = postToGrid(details.sourceTabId, {
    type: 'mpv:popup-candidate',
    sessionId: session.sessionId,
    candidateId,
    sourcePaneId: source.paneId,
    targetUrl: route.targetUrl,
  });
  if (!posted) clearPendingPopup(candidateId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = gridPorts.get(tabId);
  if (entry) {
    gridPorts.delete(tabId);
    clearPendingForSession(tabId, entry.sessionId);
  }
  registry.removeSession(tabId);
  for (const [candidateId, pending] of [...pendingPopups.entries()]) {
    if (pending.popupTabId === tabId) clearPendingPopup(candidateId);
  }
});
