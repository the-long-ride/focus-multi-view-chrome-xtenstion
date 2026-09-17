const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameRegistry } = require('../src/background/frame-registry.js');

function makeRegistry() {
  const registry = new FrameRegistry();
  registry.registerSession({ tabId: 10, sessionId: 's1', hostname: 'chatgpt.com', paneIds: ['p1', 'p2'] });
  return registry;
}

test('registerPaneFrame accepts only a currently committed document on the session hostname', () => {
  const registry = makeRegistry();
  assert.equal(registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/c/1' }), true);
  const record = registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/c/1', title: 'One', focused: false });
  assert.equal(record.paneId, 'p1');
  assert.equal(record.documentId, 'd1');
});

test('new commit invalidates old pane mapping but preserves new committed identity', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/1' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/1' });
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd2', url: 'https://chatgpt.com/2' });
  assert.equal(registry.getPane(10, 'p1'), null);
  const next = registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd2', paneId: 'p1', url: 'https://chatgpt.com/2' });
  assert.equal(next.documentId, 'd2');
});

test('registerPaneFrame rejects stale document identity and cross-host claims', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'new', url: 'https://chatgpt.com/c/2' });
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'old', paneId: 'p1', url: 'https://chatgpt.com/c/1' }), null);
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'new', paneId: 'p1', url: 'https://example.com/' }), null);
});

test('one live frame cannot claim two pane ids', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  assert.ok(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' }));
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p2', url: 'https://chatgpt.com/' }), null);
});

test('updateSessionPanes prunes removed panes and removeSession clears tab state', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' });
  registry.updateSessionPanes(10, 's1', ['p2']);
  assert.equal(registry.getPane(10, 'p1'), null);
  registry.removeSession(10);
  assert.equal(registry.getSession(10), null);
});

test('new session id replaces stale pane and committed mappings', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' });
  registry.registerSession({ tabId: 10, sessionId: 's2', hostname: 'chatgpt.com', paneIds: ['p1'] });
  assert.equal(registry.getPane(10, 'p1'), null);
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' }), null);
  assert.equal(registry.getSession(10).sessionId, 's2');
});

test('loading state updates only the mapped live frame', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' });
  assert.equal(registry.setFrameLoading(10, 3, true).loading, true);
  assert.equal(registry.setFrameLoading(10, 99, true), null);
});
