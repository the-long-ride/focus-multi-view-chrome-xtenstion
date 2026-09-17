'use strict';

importScripts('../workspace/workspace-store.js', 'workspace-frame-registry.js', 'frame-registry.js', 'popup-router.js');

const registry = new MPVFrameRegistry.FrameRegistry();
const workspaceFrames = new MPVWorkspaceFrameRegistry.WorkspaceFrameRegistry();
const workspaceStore = new MPVWorkspaceStore.WorkspaceStore({
  localArea: chrome.storage.local,
  getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
});

const MAX_PANES = 9;
const GRID_PORT_PREFIX = 'mpv-grid:';
const GRID_URL = chrome.runtime.getURL('grid.html');
const BOOTSTRAP_URL = chrome.runtime.getURL('pane-bootstrap.html');
const LIVE_BINDINGS_KEY = 'mpv:workspace-live-bindings';
const POPUP_ACK_TIMEOUT_MS = 2500;
const TRAVERSAL_TIMEOUT_MS = 5000;
const gridPorts = new Map();
const pendingPopups = new Map();
const pendingTraversals = new Map();
const workspaceQueues = new Map();
const tabToWorkspace = new Map();
let popupSequence = 0;
let liveBindingWrite = Promise.resolve();

function senderTabId(sender) {
  return Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
}

function hostnameOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isGridUrl(value) {
  try {
    const actual = new URL(value);
    const expected = new URL(GRID_URL);
    const keys = [...actual.searchParams.keys()];
    return actual.origin === expected.origin
      && actual.pathname === expected.pathname
      && keys.length <= 1
      && keys.every((key) => key === 'workspace');
  } catch {
    return false;
  }
}

function workspaceIdFromGridUrl(value) {
  if (!isGridUrl(value)) return '';
  try { return new URL(value).searchParams.get('workspace') || ''; } catch { return ''; }
}

function parsePaneBootstrapUrl(value) {
  try {
    const actual = new URL(value);
    const expected = new URL(BOOTSTRAP_URL);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) return null;
    const workspaceId = actual.searchParams.get('workspace') || '';
    const paneId = actual.searchParams.get('pane') || '';
    return workspaceId && paneId ? { workspaceId, paneId } : null;
  } catch {
    return null;
  }
}

function sessionIdFromPortName(name) {
  const value = String(name || '');
  return value.startsWith(GRID_PORT_PREFIX) ? value.slice(GRID_PORT_PREFIX.length) : '';
}

function isTrustedGridPort(port, sessionId) {
  return Boolean(sessionId && isGridUrl(port?.sender?.url) && Number.isInteger(senderTabId(port.sender)));
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

function queueWorkspaceMutation(workspaceId, mutation) {
  const previous = workspaceQueues.get(workspaceId) || Promise.resolve();
  const run = previous.catch(() => {}).then(mutation);
  let tracked;
  tracked = run.finally(() => {
    if (workspaceQueues.get(workspaceId) === tracked) workspaceQueues.delete(workspaceId);
  });
  workspaceQueues.set(workspaceId, tracked);
  return tracked;
}

async function isLiveWorkspaceOwner(tabId, workspaceId) {
  if (!Number.isInteger(tabId)) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    return isGridUrl(tab?.url) && workspaceIdFromGridUrl(tab.url) === workspaceId;
  } catch {
    return false;
  }
}

function workspaceOwnerMatches(tabId, workspaceId) {
  return tabToWorkspace.get(tabId) === workspaceId;
}

function postWorkspaceState(tabId, workspace) {
  if (!workspace) return false;
  return postToGrid(tabId, { type: 'mpv:workspace-state', workspaceId: workspace.workspaceId, workspace });
}

async function persistLiveBindings() {
  const snapshot = workspaceFrames.serialize();
  liveBindingWrite = liveBindingWrite.catch(() => {}).then(() => chrome.storage.session.set({ [LIVE_BINDINGS_KEY]: snapshot }));
  return liveBindingWrite;
}

async function restoreLiveBindings() {
  let result;
  try { result = await chrome.storage.session.get(LIVE_BINDINGS_KEY); } catch { return; }
  workspaceFrames.restore(result?.[LIVE_BINDINGS_KEY]);
  for (const item of workspaceFrames.serialize().workspaces) {
    let frames;
    try { frames = await chrome.webNavigation.getAllFrames({ tabId: item.tabId }) || []; } catch {
      workspaceFrames.removeWorkspace(item.tabId);
      continue;
    }
    const frameIds = new Set(frames.map((frame) => frame.frameId));
    for (const record of item.frames) {
      if (!frameIds.has(record.frameId)) workspaceFrames.removeFrame(item.tabId, record.frameId);
    }
    const remaining = workspaceFrames.getWorkspace(item.tabId);
    if (remaining) tabToWorkspace.set(item.tabId, remaining.workspaceId);
  }
  await persistLiveBindings();
}

async function reconcileOpenWorkspaces() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({}); } catch { return; }
  const openByWorkspace = new Map();
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || !isGridUrl(tab.url)) continue;
    const workspaceId = workspaceIdFromGridUrl(tab.url);
    if (!workspaceId) continue;
    openByWorkspace.set(workspaceId, tab.id);
    tabToWorkspace.set(tab.id, workspaceId);
  }
  const index = await workspaceStore.listIndex();
  for (const entry of index) {
    const openTabId = openByWorkspace.get(entry.workspaceId);
    if (Number.isInteger(openTabId)) {
      if (entry.activeTabId !== openTabId || entry.closedAt != null) await workspaceStore.markActive(entry.workspaceId, openTabId);
    } else if (entry.activeTabId != null) {
      await workspaceStore.markClosed(entry.workspaceId);
    }
  }
  await workspaceStore.cleanup();
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
    if (!Number.isInteger(frame.frameId) || frame.frameId <= 0 || frame.parentFrameId !== 0 || !frame.documentId) continue;
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
  try { await chrome.tabs.remove(pending.popupTabId); return true; } catch { return false; }
}

function clearPendingForSession(tabId, sessionId) {
  for (const [candidateId, pending] of [...pendingPopups.entries()]) {
    if (pending.sourceTabId === tabId && pending.sessionId === sessionId) clearPendingPopup(candidateId);
  }
}

function clearExpiredTraversal(key) {
  const pending = pendingTraversals.get(key);
  if (pending && pending.expiresAt <= Date.now()) pendingTraversals.delete(key);
  return pendingTraversals.get(key) || null;
}

async function recordWorkspaceNavigation(record, url) {
  if (!record || !isHttpUrl(url)) return;
  const { tabId, workspaceId, paneId } = record;
  if (!workspaceOwnerMatches(tabId, workspaceId)) return;
  const key = `${tabId}:${paneId}`;
  const pending = clearExpiredTraversal(key);
  await queueWorkspaceMutation(workspaceId, async () => {
    const workspace = await workspaceStore.load(workspaceId);
    if (!workspace || workspace.activeTabId !== tabId) return;
    let mutation;
    if (pending && pending.url === new URL(url).href) {
      mutation = MPVWorkspaceStore.confirmTraversal(workspace, paneId, pending.index, pending.url);
      pendingTraversals.delete(key);
    } else {
      if (pending) pendingTraversals.delete(key);
      mutation = MPVWorkspaceStore.recordNavigation(workspace, paneId, url);
    }
    if (!mutation.changed) return;
    const now = Date.now();
    const saved = await workspaceStore.save({ ...mutation.workspace, updatedAt: now, lastSeenAt: now });
    postWorkspaceState(tabId, saved);
  });
}

function sanitizeUiPatch(workspace, patch) {
  const next = { ...workspace, layout: { ...workspace.layout }, ui: { ...workspace.ui, floatingTriggerPosition: { ...workspace.ui.floatingTriggerPosition } } };
  if (!patch || typeof patch !== 'object') return next;
  if (patch.layout && typeof patch.layout === 'object') {
    next.layout = {
      cols: Number(patch.layout.cols),
      rows: Number(patch.layout.rows),
      colSizes: Array.isArray(patch.layout.colSizes) ? patch.layout.colSizes.map(Number) : workspace.layout.colSizes,
      rowSizes: Array.isArray(patch.layout.rowSizes) ? patch.layout.rowSizes.map(Number) : workspace.layout.rowSizes,
    };
  }
  if (typeof patch.activePaneId === 'string' && workspace.panes.some((pane) => pane.paneId === patch.activePaneId)) next.activePaneId = patch.activePaneId;
  if (patch.ui && typeof patch.ui === 'object') {
    if (patch.ui.floatingTriggerPosition && typeof patch.ui.floatingTriggerPosition === 'object') {
      next.ui.floatingTriggerPosition = { x: Number(patch.ui.floatingTriggerPosition.x), y: Number(patch.ui.floatingTriggerPosition.y) };
    }
    if (typeof patch.ui.floatingPanelOpen === 'boolean') next.ui.floatingPanelOpen = patch.ui.floatingPanelOpen;
    if (typeof patch.ui.enhancedOptInHostname === 'string') next.ui.enhancedOptInHostname = patch.ui.enhancedOptInHostname;
    if (typeof patch.ui.compatibilityEnabled === 'boolean') next.ui.compatibilityEnabled = patch.ui.compatibilityEnabled;
  }
  return next;
}

async function registerWorkspaceForPort(port, tabId, sessionId, requestedId, requestId) {
  let cloned = false;
  let workspace = await queueWorkspaceMutation(requestedId, async () => {
    const loaded = await workspaceStore.load(requestedId);
    if (!loaded) return null;
    if (loaded.activeTabId != null && loaded.activeTabId !== tabId && await isLiveWorkspaceOwner(loaded.activeTabId, loaded.workspaceId)) {
      cloned = true;
      const clone = await workspaceStore.clone(loaded.workspaceId);
      return clone ? workspaceStore.markActive(clone.workspaceId, tabId) : null;
    }
    return workspaceStore.markActive(loaded.workspaceId, tabId);
  });
  if (!workspace) {
    postResult(port, requestId, false, { missing: true });
    return;
  }
  const previousId = tabToWorkspace.get(tabId);
  if (previousId && previousId !== workspace.workspaceId) workspaceFrames.removeWorkspace(tabId);
  tabToWorkspace.set(tabId, workspace.workspaceId);
  const portEntry = gridPorts.get(tabId);
  if (portEntry?.port === port) portEntry.workspaceId = workspace.workspaceId;
  workspaceFrames.registerWorkspace({ tabId, workspaceId: workspace.workspaceId, paneIds: workspace.panes.map((pane) => pane.paneId) });
  await persistLiveBindings();
  postResult(port, requestId, true, { workspaceId: workspace.workspaceId, workspace, cloned });
  for (const pane of workspace.panes) {
    if (!workspaceFrames.getPane(tabId, pane.paneId)) postToGrid(tabId, { type: 'mpv:pane-rebind', workspaceId: workspace.workspaceId, paneId: pane.paneId });
  }
}

async function recoverWorkspaceForPort(port, tabId, sessionId, urls, requestId) {
  const safeUrls = Array.from(urls || []).filter(isHttpUrl).slice(0, MAX_PANES);
  if (!safeUrls.length) safeUrls.push('https://example.com', 'https://github.com');
  let workspace = await workspaceStore.create(safeUrls);
  workspace = await workspaceStore.markActive(workspace.workspaceId, tabId);
  tabToWorkspace.set(tabId, workspace.workspaceId);
  const entry = gridPorts.get(tabId);
  if (entry?.port === port) entry.workspaceId = workspace.workspaceId;
  workspaceFrames.registerWorkspace({ tabId, workspaceId: workspace.workspaceId, paneIds: workspace.panes.map((pane) => pane.paneId) });
  await persistLiveBindings();
  postResult(port, requestId, true, { workspaceId: workspace.workspaceId, workspace, recovered: true });
}

async function handleGridPortMessage(port, tabId, sessionId, message) {
  if (!message || typeof message !== 'object') return;
  if (message.sessionId && message.sessionId !== sessionId) {
    postResult(port, message.requestId, false);
    return;
  }
  if (message.type === 'mpv:workspace-register') {
    await registerWorkspaceForPort(port, tabId, sessionId, String(message.workspaceId || ''), message.requestId);
    return;
  }
  if (message.type === 'mpv:workspace-recover') {
    await recoverWorkspaceForPort(port, tabId, sessionId, message.urls, message.requestId);
    return;
  }

  const workspaceId = tabToWorkspace.get(tabId);
  if (message.type === 'mpv:workspace-ui-patch' || message.type === 'mpv:workspace-pane-patch'
      || message.type === 'mpv:workspace-pane-add' || message.type === 'mpv:workspace-pane-remove'
      || message.type === 'mpv:history-traverse') {
    if (!workspaceId || (message.workspaceId && message.workspaceId !== workspaceId)) {
      postResult(port, message.requestId, false);
      return;
    }
  }

  if (message.type === 'mpv:workspace-ui-patch') {
    await queueWorkspaceMutation(workspaceId, async () => {
      const workspace = await workspaceStore.load(workspaceId);
      if (!workspace || workspace.activeTabId !== tabId) return postResult(port, message.requestId, false);
      const now = Date.now();
      const saved = await workspaceStore.save({ ...sanitizeUiPatch(workspace, message.patch), updatedAt: now, lastSeenAt: now });
      postResult(port, message.requestId, true, { workspace: saved });
      postWorkspaceState(tabId, saved);
    });
    return;
  }

  if (message.type === 'mpv:workspace-pane-patch') {
    await queueWorkspaceMutation(workspaceId, async () => {
      const workspace = await workspaceStore.load(workspaceId);
      const pane = workspace?.panes.find((item) => item.paneId === message.paneId);
      if (!workspace || workspace.activeTabId !== tabId || !pane || !message.controlPosition) return postResult(port, message.requestId, false);
      const panes = workspace.panes.map((item) => item.paneId === pane.paneId ? { ...item, controlPosition: { x: Number(message.controlPosition.x), y: Number(message.controlPosition.y) } } : item);
      const saved = await workspaceStore.save({ ...workspace, panes, updatedAt: Date.now() });
      postResult(port, message.requestId, true, { workspace: saved });
      postWorkspaceState(tabId, saved);
    });
    return;
  }

  if (message.type === 'mpv:workspace-pane-add') {
    await queueWorkspaceMutation(workspaceId, async () => {
      const workspace = await workspaceStore.load(workspaceId);
      const paneId = String(message.paneId || '');
      if (!workspace || workspace.activeTabId !== tabId || workspace.panes.length >= MAX_PANES || !paneId || !isHttpUrl(message.url)
          || workspace.panes.some((pane) => pane.paneId === paneId)) return postResult(port, message.requestId, false);
      const panes = [...workspace.panes, { paneId, controlPosition: { x: 8, y: 8 }, historyIndex: 0, history: [{ url: new URL(message.url).href }] }];
      const saved = await workspaceStore.save({ ...workspace, panes, updatedAt: Date.now() });
      workspaceFrames.replacePaneIds(tabId, workspaceId, saved.panes.map((pane) => pane.paneId));
      await persistLiveBindings();
      postResult(port, message.requestId, true, { workspace: saved });
      postWorkspaceState(tabId, saved);
    });
    return;
  }

  if (message.type === 'mpv:workspace-pane-remove') {
    await queueWorkspaceMutation(workspaceId, async () => {
      const workspace = await workspaceStore.load(workspaceId);
      if (!workspace || workspace.activeTabId !== tabId || workspace.panes.length <= 1) return postResult(port, message.requestId, false);
      const panes = workspace.panes.filter((pane) => pane.paneId !== message.paneId);
      if (panes.length === workspace.panes.length) return postResult(port, message.requestId, false);
      const activePaneId = panes.some((pane) => pane.paneId === workspace.activePaneId) ? workspace.activePaneId : panes[0].paneId;
      const saved = await workspaceStore.save({ ...workspace, panes, activePaneId, updatedAt: Date.now() });
      workspaceFrames.replacePaneIds(tabId, workspaceId, saved.panes.map((pane) => pane.paneId));
      await persistLiveBindings();
      postResult(port, message.requestId, true, { workspace: saved });
      postWorkspaceState(tabId, saved);
    });
    return;
  }

  if (message.type === 'mpv:history-traverse') {
    const workspace = await workspaceStore.load(workspaceId);
    if (!workspace || workspace.activeTabId !== tabId) return postResult(port, message.requestId, false);
    const target = MPVWorkspaceStore.prepareTraversal(workspace, message.paneId, message.direction);
    if (!target) return postResult(port, message.requestId, false);
    pendingTraversals.set(`${tabId}:${message.paneId}`, { ...target, expiresAt: Date.now() + TRAVERSAL_TIMEOUT_MS });
    postResult(port, message.requestId, true, { paneId: message.paneId, index: target.index, url: target.url });
    return;
  }

  if (message.type === 'mpv:session-start') {
    const session = registry.registerSession({ tabId, sessionId, hostname: message.hostname, paneIds: message.paneIds });
    postResult(port, message.requestId, Boolean(session));
    if (session) seedAndInjectSessionFrames(tabId).catch(() => {});
    return;
  }
  if (message.type === 'mpv:session-update') {
    postResult(port, message.requestId, registry.updateSessionPanes(tabId, sessionId, message.paneIds));
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
    if (!record || !['back', 'forward'].includes(message.command)) return postResult(port, message.requestId, false);
    chrome.tabs.sendMessage(
      tabId,
      { type: 'mpv:bridge-command', paneId: record.paneId, command: message.command },
      { frameId: record.frameId, documentId: record.documentId },
    ).then(() => postResult(port, message.requestId, true), () => postResult(port, message.requestId, false));
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
  gridPorts.set(tabId, { port, sessionId, workspaceId: tabToWorkspace.get(tabId) || '' });
  port.onMessage.addListener((message) => { handleGridPortMessage(port, tabId, sessionId, message).catch(() => postResult(port, message?.requestId, false)); });
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
  const input = { tabId, frameId: sender.frameId, documentId: sender.documentId, paneId: message.paneId, url: message.url, title: message.title, focused: message.focused };
  const record = message.type === 'mpv:bridge-register' ? registry.registerPaneFrame(input) : registry.updatePaneFrame(input);
  if (record) publishPane(record);
  sendResponse({ ok: Boolean(record) });
  return false;
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId <= 0) return;
  publishPane(registry.setFrameLoading(details.tabId, details.frameId, true));
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId <= 0 || details.parentFrameId !== 0 || !details.documentId) return;
  const bootstrap = parsePaneBootstrapUrl(details.url);
  if (bootstrap) {
    if (tabToWorkspace.get(details.tabId) !== bootstrap.workspaceId) return;
    const record = workspaceFrames.bindBootstrap({ tabId: details.tabId, frameId: details.frameId, documentId: details.documentId, workspaceId: bootstrap.workspaceId, paneId: bootstrap.paneId });
    if (record) persistLiveBindings().catch(() => {});
    return;
  }
  const universal = workspaceFrames.findPaneByFrame(details.tabId, details.frameId);
  if (universal && isHttpUrl(details.url)) {
    const updated = workspaceFrames.updateDocument({ tabId: details.tabId, frameId: details.frameId, documentId: details.documentId, url: details.url });
    if (updated) {
      persistLiveBindings().catch(() => {});
      recordWorkspaceNavigation(updated, details.url).catch(() => {});
    }
  }
  const session = registry.getSession(details.tabId);
  if (!session) return;
  const previous = registry.findPaneByFrame(details.tabId, details.frameId);
  if (hostnameOf(details.url) !== session.hostname) {
    if (previous) publishPane({ ...previous, url: details.url, loading: false }, { detached: true });
    registry.removeFrame(details.tabId, details.frameId);
    return;
  }
  if (!registry.recordCommittedDocument({ tabId: details.tabId, frameId: details.frameId, documentId: details.documentId, url: details.url })) return;
  injectBridge(details.tabId, details.frameId).catch(() => {});
});

function handleSameDocumentNavigation(details) {
  const record = workspaceFrames.findPaneByFrame(details.tabId, details.frameId);
  if (record) recordWorkspaceNavigation(record, details.url).catch(() => {});
  const enhanced = registry.findPaneByFrame(details.tabId, details.frameId);
  if (enhanced && (!details.documentId || enhanced.documentId === details.documentId)) publishPane(registry.updatePaneFrame({ ...enhanced, url: details.url }));
}

chrome.webNavigation.onHistoryStateUpdated.addListener(handleSameDocumentNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(handleSameDocumentNavigation);
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
  const route = MPVPopupRouter.decidePopupRoute({ sourceRegistered: true, sessionHostname: session.hostname, targetUrl: details.url, paneCount: session.paneIds.length, maxPanes: MAX_PANES });
  if (route.action !== 'pane') return;
  const candidateId = `${details.sourceTabId}:${++popupSequence}:${Date.now()}`;
  const timeoutId = setTimeout(() => clearPendingPopup(candidateId), POPUP_ACK_TIMEOUT_MS);
  pendingPopups.set(candidateId, { candidateId, sourceTabId: details.sourceTabId, popupTabId: details.tabId, sessionId: session.sessionId, timeoutId });
  const posted = postToGrid(details.sourceTabId, { type: 'mpv:popup-candidate', sessionId: session.sessionId, candidateId, sourcePaneId: source.paneId, targetUrl: route.targetUrl });
  if (!posted) clearPendingPopup(candidateId);
});

async function markWorkspaceClosedForTab(tabId) {
  const workspaceId = tabToWorkspace.get(tabId);
  if (!workspaceId) return;
  await queueWorkspaceMutation(workspaceId, async () => {
    const workspace = await workspaceStore.load(workspaceId);
    if (workspace?.activeTabId === tabId) await workspaceStore.markClosed(workspaceId);
    await workspaceStore.cleanup();
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  markWorkspaceClosedForTab(tabId).catch(() => {});
  const entry = gridPorts.get(tabId);
  if (entry) {
    gridPorts.delete(tabId);
    clearPendingForSession(tabId, entry.sessionId);
  }
  tabToWorkspace.delete(tabId);
  workspaceFrames.removeWorkspace(tabId);
  persistLiveBindings().catch(() => {});
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
  registry.removeSession(tabId);
  for (const key of [...pendingTraversals.keys()]) {
    if (key.startsWith(`${tabId}:`)) pendingTraversals.delete(key);
  }
  for (const [candidateId, pending] of [...pendingPopups.entries()]) {
    if (pending.popupTabId === tabId) clearPendingPopup(candidateId);
  }
});

Promise.resolve().then(restoreLiveBindings).then(reconcileOpenWorkspaces).catch(() => {});
