const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('src/pane/bridge.js', 'utf8');

test('bridge derives pane identity only from focus-pane window.name', () => {
  assert.match(js, /window\.name/);
  assert.match(js, /focus-pane:/);
  assert.match(js, /mpv:bridge-register/);
});

test('bridge supports back and forward without exposing a generic command executor', () => {
  assert.match(js, /history\.back\(\)/);
  assert.match(js, /history\.forward\(\)/);
  assert.equal(js.includes('eval('), false);
  assert.equal(js.includes('new Function'), false);
});

test('bridge reports event-driven title and focus state', () => {
  assert.match(js, /MutationObserver/);
  assert.match(js, /hashchange/);
  assert.match(js, /popstate/);
  assert.match(js, /pointerdown/);
  assert.equal(js.includes('setInterval'), false);
});

test('bridge installation is idempotent', () => {
  assert.match(js, /__mpvPaneBridgeInstalled/);
});
