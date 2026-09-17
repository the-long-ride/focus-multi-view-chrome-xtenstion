const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePopupRoute } = require('../src/background/popup-router.js');

test('same-host popup becomes a pane below the limit', () => {
  assert.deepEqual(decidePopupRoute({
    sourceRegistered: true,
    sessionHostname: 'chatgpt.com',
    targetUrl: 'https://chatgpt.com/c/new',
    paneCount: 4,
    maxPanes: 9,
  }), { action: 'pane', targetUrl: 'https://chatgpt.com/c/new' });
});

test('cross-host and ninth-plus popup remain native tabs', () => {
  assert.equal(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'https://example.com', paneCount: 4, maxPanes: 9 }).action, 'native');
  assert.equal(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'https://chatgpt.com/new', paneCount: 9, maxPanes: 9 }).action, 'native');
});

test('unregistered sources are ignored and invalid targets stay native', () => {
  assert.equal(decidePopupRoute({ sourceRegistered: false, sessionHostname: 'chatgpt.com', targetUrl: 'https://chatgpt.com', paneCount: 1, maxPanes: 9 }).action, 'ignore');
  assert.equal(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'about:blank', paneCount: 1, maxPanes: 9 }).action, 'native');
});
