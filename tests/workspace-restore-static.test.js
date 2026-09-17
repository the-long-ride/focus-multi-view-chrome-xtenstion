const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const popupHtml = fs.readFileSync('popup.html', 'utf8');
const popupJs = fs.readFileSync('popup.js', 'utf8');
const gridJs = fs.readFileSync('grid.js', 'utf8');
const bootstrapHtml = fs.readFileSync('pane-bootstrap.html', 'utf8');
const bootstrapJs = fs.readFileSync('pane-bootstrap.js', 'utf8');
const worker = fs.readFileSync('src/background/service-worker.js', 'utf8');
const store = fs.readFileSync('src/workspace/workspace-store.js', 'utf8');

test('popup loads workspace store and launches an opaque workspace URL', () => {
  assert.match(popupHtml, /src\/workspace\/workspace-store\.js[\s\S]*popup\.js/);
  assert.match(popupJs, /new MPVWorkspaceStore\.WorkspaceStore/);
  assert.match(popupJs, /const normalizedUrls = cleanUrls\.map\(MPV\.normalizeUrl\)/);
  assert.match(popupJs, /workspaceStore\.create\(normalizedUrls/);
  assert.match(popupJs, /searchParams\.set\(['"]workspace['"]/);
  assert.doesNotMatch(popupJs, /searchParams\.set\(['"]url/);
  assert.doesNotMatch(popupJs, /chrome\.storage\.session\.set\(\{\s*launchUrls/);
});

test('grid restores or recovers workspace before building durable panes', () => {
  assert.match(gridJs, /new URLSearchParams\(location\.search\)/);
  assert.match(gridJs, /mpv:workspace-register/);
  assert.match(gridJs, /mpv:workspace-recover/);
  assert.match(gridJs, /function applyWorkspaceState/);
  assert.match(gridJs, /options\.paneId/);
  assert.match(gridJs, /pane-bootstrap\.html/);
  assert.match(gridJs, /replaceWorkspaceUrl/);
});

test('bootstrap URLs contain only opaque workspace and pane ids', () => {
  assert.match(bootstrapHtml, /pane-bootstrap\.js/);
  assert.match(bootstrapJs, /mpv:pane-bootstrap-ready/);
  assert.match(bootstrapJs, /mpv:pane-bootstrap-target/);
  assert.match(bootstrapJs, /location\.replace\(targetUrl\)/);
  assert.doesNotMatch(bootstrapJs, /searchParams\.get\(['"]target/);

  const start = gridJs.indexOf('function bootstrapUrlForPane');
  const end = gridJs.indexOf('\n}', start) + 2;
  const builder = gridJs.slice(start, end);
  assert.match(builder, /searchParams\.set\(['"]workspace['"]/);
  assert.match(builder, /searchParams\.set\(['"]pane['"]/);
  assert.doesNotMatch(builder, /searchParams\.set\(['"](?:url|target)/);
});

test('workspace retention is bounded to approved limits', () => {
  assert.match(store, /const MAX_HISTORY_ENTRIES = 50;/);
  assert.match(store, /const MAX_CLOSED_WORKSPACES = 20;/);
  assert.match(store, /const SOFT_BUDGET_BYTES = 6 \* 1024 \* 1024;/);
  assert.match(store, /getBytesInUse\(\[INDEX_KEY,/);
});

test('retained Back and Forward are universal workspace history controls', () => {
  assert.match(worker, /mpv:history-traverse/);
  assert.match(worker, /webNavigation\.onCommitted/);
  assert.match(worker, /webNavigation\.onHistoryStateUpdated/);
  assert.match(worker, /webNavigation\.onReferenceFragmentUpdated/);
  assert.match(gridJs, /mpv:history-traverse/);
  assert.match(gridJs, /pane\.backBtn\.disabled/);
  assert.match(gridJs, /pane\.forwardBtn\.disabled/);

  const backIndex = gridJs.indexOf("backBtn.className = 'pane-control-action'");
  const forwardIndex = gridJs.indexOf("forwardBtn.className = 'pane-control-action'");
  assert.ok(backIndex >= 0 && forwardIndex >= 0, 'Back/Forward are normal pane actions');
});

test('basic and mixed-host navigation recording is independent of Enhanced permission', () => {
  const committed = worker.indexOf('chrome.webNavigation.onCommitted.addListener');
  const universal = worker.indexOf('recordWorkspaceNavigation(updated, details.url)', committed);
  const enhanced = worker.indexOf('const session = registry.getSession(details.tabId)', committed);
  assert.ok(committed >= 0 && universal > committed, 'universal navigation recorder exists');
  assert.ok(enhanced > universal, 'universal history recording occurs before Enhanced session gating');
});

test('service worker owns close lifecycle and restart recovery', () => {
  assert.match(worker, /mpv:workspace-live-bindings/);
  assert.match(worker, /chrome\.storage\.session\.set/);
  assert.match(worker, /restoreLiveBindings/);
  assert.match(worker, /reconcileOpenWorkspaces/);
  assert.match(worker, /webNavigation\.getAllFrames/);
  assert.match(worker, /tabs\.onRemoved/);
  assert.match(worker, /markWorkspaceClosedForTab/);

  const disconnectStart = worker.indexOf('port.onDisconnect.addListener');
  const disconnectEnd = worker.indexOf("port.postMessage({ type: 'mpv:background-ready'", disconnectStart);
  const disconnectBlock = worker.slice(disconnectStart, disconnectEnd);
  assert.doesNotMatch(disconnectBlock, /markClosed|markWorkspaceClosedForTab/);
});

test('workspace UI intent is restored without automatic permission prompts', () => {
  assert.match(gridJs, /currentWorkspace\.ui\?\.compatibilityEnabled/);
  assert.match(gridJs, /currentWorkspace\.ui\?\.enhancedOptInHostname/);
  assert.match(gridJs, /chrome\.permissions\.contains\(COMPAT_ORIGINS\)/);
  const restoreStart = gridJs.indexOf('async function restoreWorkspaceModes');
  const restoreEnd = gridJs.indexOf('\n}', restoreStart) + 2;
  const restoreBlock = gridJs.slice(restoreStart, restoreEnd);
  assert.doesNotMatch(restoreBlock, /permissions\.request/);
});
