const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceFrameRegistry } = require('../src/background/workspace-frame-registry.js');

test('registered pane keeps the same frame binding across documents', () => {
  const registry = new WorkspaceFrameRegistry();
  assert.equal(registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] }), true);
  const bound = registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd1', workspaceId: 'w', paneId: 'p' });
  assert.equal(bound.paneId, 'p');
  const updated = registry.updateDocument({ tabId: 7, frameId: 3, documentId: 'd2', url: 'https://example.com/a' });
  assert.equal(updated.documentId, 'd2');
  assert.equal(updated.url, 'https://example.com/a');
  assert.equal(registry.findPaneByFrame(7, 3).paneId, 'p');
});

test('unregistered pane id cannot claim a frame', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] });
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd', workspaceId: 'w', paneId: 'other' }), null);
});

test('conflicting frame and pane claims are rejected', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['a', 'b'] });
  assert.ok(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd1', workspaceId: 'w', paneId: 'a' }));
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd2', workspaceId: 'w', paneId: 'b' }), null);
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 4, documentId: 'd3', workspaceId: 'w', paneId: 'a' }), null);
});

test('replacePaneIds removes bindings for deleted panes', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['a', 'b'] });
  registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd1', workspaceId: 'w', paneId: 'a' });
  registry.bindBootstrap({ tabId: 7, frameId: 4, documentId: 'd2', workspaceId: 'w', paneId: 'b' });
  assert.equal(registry.replacePaneIds(7, 'w', ['b']), true);
  assert.equal(registry.getPane(7, 'a'), null);
  assert.equal(registry.findPaneByFrame(7, 3), null);
  assert.equal(registry.getPane(7, 'b').frameId, 4);
});

test('serialize and restore retain valid recovery bindings', () => {
  const first = new WorkspaceFrameRegistry();
  first.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] });
  first.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd1', workspaceId: 'w', paneId: 'p' });
  first.updateDocument({ tabId: 7, frameId: 3, documentId: 'd2', url: 'https://example.com/a' });

  const second = new WorkspaceFrameRegistry();
  second.restore(first.serialize());
  assert.deepEqual(second.getWorkspace(7), { tabId: 7, workspaceId: 'w', paneIds: ['p'] });
  assert.deepEqual(second.getPane(7, 'p'), {
    tabId: 7,
    workspaceId: 'w',
    paneId: 'p',
    frameId: 3,
    documentId: 'd2',
    url: 'https://example.com/a',
  });
});

test('restore ignores malformed workspace and frame records', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.restore({
    version: 1,
    workspaces: [
      { tabId: 'bad', workspaceId: 'w', paneIds: ['p'], frames: [] },
      {
        tabId: 9,
        workspaceId: 'valid',
        paneIds: ['p'],
        frames: [
          { tabId: 9, workspaceId: 'valid', paneId: 'other', frameId: 2, documentId: 'd', url: 'https://example.com' },
          { tabId: 9, workspaceId: 'valid', paneId: 'p', frameId: 2, documentId: '', url: 'https://example.com' },
        ],
      },
    ],
  });
  assert.equal(registry.getWorkspace(7), null);
  assert.deepEqual(registry.getWorkspace(9), { tabId: 9, workspaceId: 'valid', paneIds: ['p'] });
  assert.equal(registry.getPane(9, 'p'), null);
});
