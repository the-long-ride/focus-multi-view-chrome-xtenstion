const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('src/background/service-worker.js', 'utf8');

test('service worker imports registry/router and listens for navigation and popup events', () => {
  assert.match(js, /importScripts\('frame-registry\.js', 'popup-router\.js'\)/);
  assert.match(js, /webNavigation\.onCommitted/);
  assert.match(js, /webNavigation\.onHistoryStateUpdated/);
  assert.match(js, /webNavigation\.onCreatedNavigationTarget/);
  assert.match(js, /webNavigation\.onBeforeNavigate/);
  assert.match(js, /webNavigation\.onCompleted/);
});

test('grid sessions use dedicated ports instead of extension-wide sendMessage broadcasts', () => {
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

test('session start reseeds existing frames for service worker recovery', () => {
  assert.match(js, /getAllFrames/);
  assert.match(js, /seedAndInjectSessionFrames/);
});

test('worker announces readiness over the owning grid port for restart recovery', () => {
  assert.match(js, /port\.postMessage\(\{\s*type:\s*'mpv:background-ready',\s*sessionId\s*\}\)/s);
});

test('cross-host commit publishes detached pane state before removing the frame mapping', () => {
  const publishIndex = js.indexOf("publishPane({ ...previous, url: details.url, loading: false }, { detached: true })");
  const removeIndex = js.indexOf('registry.removeFrame(details.tabId, details.frameId)');
  assert.ok(publishIndex >= 0, 'cross-host detached pane state must be published');
  assert.ok(removeIndex >= 0, 'cross-host frame mapping must be removed');
  assert.ok(publishIndex < removeIndex, 'publish detached state before removing the frame mapping');
});
