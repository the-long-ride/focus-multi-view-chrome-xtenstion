const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('src/background/service-worker.js', 'utf8');

test('service worker imports workspace, registry, and popup infrastructure', () => {
  assert.match(js, /importScripts\('\.\.\/workspace\/workspace-store\.js', 'workspace-frame-registry\.js', 'frame-registry\.js', 'popup-router\.js'\)/);
  assert.match(js, /new MPVWorkspaceStore\.WorkspaceStore/);
  assert.match(js, /new MPVWorkspaceFrameRegistry\.WorkspaceFrameRegistry/);
  assert.match(js, /queueWorkspaceMutation/);
});

test('service worker records committed, SPA, and fragment navigation universally', () => {
  assert.match(js, /webNavigation\.onCommitted/);
  assert.match(js, /webNavigation\.onHistoryStateUpdated/);
  assert.match(js, /webNavigation\.onReferenceFragmentUpdated/);
  assert.match(js, /recordWorkspaceNavigation/);
  assert.match(js, /mpv:history-traverse/);
});

test('grid sessions use dedicated ports instead of extension-wide pane broadcasts', () => {
  assert.match(js, /runtime\.onConnect/);
  assert.match(js, /mpv-grid:/);
  assert.match(js, /port\.postMessage/);
  assert.match(js, /port\.onDisconnect/);
  assert.doesNotMatch(js, /runtime\.sendMessage\(\{\s*type:\s*'mpv:pane-state'/);
});

test('bridge injection and commands are targeted to exact frame and document', () => {
  assert.match(js, /frameIds:\s*\[frameId\]/);
  assert.match(js, /src\/pane\/bridge\.js/);
  assert.match(js, /frameId:\s*record\.frameId/);
  assert.match(js, /documentId:\s*record\.documentId/);
});

test('popup close occurs only after same-session acknowledgement', () => {
  assert.match(js, /mpv:popup-candidate/);
  assert.match(js, /mpv:popup-result/);
  assert.match(js, /pendingPopups/);
  assert.match(js, /tabs\.remove/);
});

test('worker persists and reconciles live workspace bindings', () => {
  assert.match(js, /mpv:workspace-live-bindings/);
  assert.match(js, /persistLiveBindings/);
  assert.match(js, /restoreLiveBindings/);
  assert.match(js, /reconcileOpenWorkspaces/);
  assert.match(js, /webNavigation\.getAllFrames/);
  assert.match(js, /tabs\.onRemoved/);
  assert.match(js, /markWorkspaceClosedForTab/);
});

test('worker announces readiness over the owning grid port for restart recovery', () => {
  assert.match(js, /port\.postMessage\(\{\s*type:\s*'mpv:background-ready',\s*sessionId\s*\}\)/s);
});

test('port disconnect clears ephemeral state but does not mark workspace closed', () => {
  const start = js.indexOf('port.onDisconnect.addListener');
  const end = js.indexOf("port.postMessage({ type: 'mpv:background-ready'", start);
  assert.ok(start >= 0 && end > start, 'disconnect block found');
  const block = js.slice(start, end);
  assert.doesNotMatch(block, /markClosed|markWorkspaceClosedForTab/);
});

test('cross-host commit publishes detached pane state before removing enhanced frame mapping', () => {
  const publishIndex = js.indexOf("publishPane({ ...previous, url: details.url, loading: false }, { detached: true })");
  const removeIndex = js.indexOf('registry.removeFrame(details.tabId, details.frameId)');
  assert.ok(publishIndex >= 0, 'cross-host detached pane state must be published');
  assert.ok(removeIndex >= 0, 'cross-host frame mapping must be removed');
  assert.ok(publishIndex < removeIndex, 'publish detached state before removing the frame mapping');
});
