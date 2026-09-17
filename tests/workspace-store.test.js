const test = require('node:test');
const assert = require('node:assert/strict');
const WS = require('../src/workspace/workspace-store.js');

test('createWorkspaceFromUrls creates pane history and the correct initial grid dimensions', () => {
  let pane = 0;
  const workspace = WS.createWorkspaceFromUrls(
    ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'],
    {
      workspaceId: 'w1',
      now: 1000,
      makePaneId: () => `p${++pane}`,
      ui: { enhancedOptInHostname: 'example.com', compatibilityEnabled: false },
    },
  );
  assert.equal(workspace.schemaVersion, 1);
  assert.equal(workspace.workspaceId, 'w1');
  assert.deepEqual(workspace.layout, { cols: 2, rows: 2, colSizes: [1, 1], rowSizes: [1, 1] });
  assert.deepEqual(workspace.panes.map((item) => [item.paneId, item.historyIndex, item.history[0].url]), [
    ['p1', 0, 'https://example.com/a'],
    ['p2', 0, 'https://example.com/b'],
    ['p3', 0, 'https://example.com/c'],
  ]);
  assert.equal(workspace.ui.enhancedOptInHostname, 'example.com');
  assert.equal(workspace.closedAt, null);
  assert.equal(workspace.activeTabId, null);
});

test('normalizeWorkspace rejects future schemas and clamps recoverable history state', () => {
  assert.equal(WS.normalizeWorkspace({ schemaVersion: 2, workspaceId: 'future' }), null);
  const normalized = WS.normalizeWorkspace({
    schemaVersion: 1,
    workspaceId: 'w',
    createdAt: 1,
    updatedAt: 1,
    lastSeenAt: 1,
    closedAt: null,
    activeTabId: null,
    layout: { cols: 1, rows: 1, colSizes: [1], rowSizes: [1] },
    activePaneId: 'p',
    ui: { floatingTriggerPosition: { x: 8, y: 8 }, floatingPanelOpen: false, enhancedOptInHostname: '', compatibilityEnabled: false },
    panes: [{ paneId: 'p', controlPosition: { x: 8, y: 8 }, historyIndex: 99, history: [{ url: 'https://example.com' }] }],
  });
  assert.equal(normalized.panes[0].historyIndex, 0);
});

test('Back then new navigation truncates the forward branch', () => {
  let workspace = WS.createWorkspaceFromUrls(['https://example.com/a'], { workspaceId: 'w', now: 1, makePaneId: () => 'p' });
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/b').workspace;
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/c').workspace;
  const target = WS.prepareTraversal(workspace, 'p', 'back');
  workspace = WS.confirmTraversal(workspace, 'p', target.index, target.url).workspace;
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/d').workspace;
  assert.deepEqual(workspace.panes[0].history.map((entry) => entry.url), [
    'https://example.com/a', 'https://example.com/b', 'https://example.com/d',
  ]);
});

test('duplicate current URL does not grow retained history', () => {
  let workspace = WS.createWorkspaceFromUrls(['https://example.com/a'], { workspaceId: 'w', now: 1, makePaneId: () => 'p' });
  const result = WS.recordNavigation(workspace, 'p', 'https://example.com/a');
  assert.equal(result.changed, false);
  assert.equal(result.workspace.panes[0].history.length, 1);
});

test('history keeps only the newest 50 entries and adjusts the index', () => {
  let workspace = WS.createWorkspaceFromUrls(['https://example.com/0'], { workspaceId: 'w', now: 1, makePaneId: () => 'p' });
  for (let i = 1; i <= 60; i += 1) workspace = WS.recordNavigation(workspace, 'p', `https://example.com/${i}`).workspace;
  const pane = workspace.panes[0];
  assert.equal(pane.history.length, 50);
  assert.equal(pane.history[0].url, 'https://example.com/11');
  assert.equal(pane.historyIndex, 49);
});
