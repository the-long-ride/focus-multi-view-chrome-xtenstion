const test = require('node:test');
const assert = require('node:assert/strict');
const WS = require('../src/workspace/workspace-store.js');

function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (typeof keys === 'string') return { [keys]: data[keys] };
      const result = {};
      for (const key of keys || Object.keys(data)) result[key] = data[key];
      return result;
    },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of [].concat(keys)) delete data[key]; },
    async getBytesInUse(keys) {
      const selected = [].concat(keys || Object.keys(data));
      const value = Object.fromEntries(selected.filter((key) => key in data).map((key) => [key, data[key]]));
      return Buffer.byteLength(JSON.stringify(value));
    },
  };
}

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
});

test('normalizeWorkspace rejects future schemas and clamps recoverable history state', () => {
  assert.equal(WS.normalizeWorkspace({ schemaVersion: 2, workspaceId: 'future' }), null);
  const normalized = WS.normalizeWorkspace({
    schemaVersion: 1,
    workspaceId: 'w', createdAt: 1, updatedAt: 1, lastSeenAt: 1,
    closedAt: null, activeTabId: null,
    layout: { cols: 1, rows: 1, colSizes: [1], rowSizes: [1] },
    activePaneId: 'p',
    ui: { floatingTriggerPosition: { x: 8, y: 8 } },
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

test('markActive and markClosed reuse the same workspace record', async () => {
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({ localArea, now: () => 1000, makeWorkspaceId: () => 'w1', makePaneId: () => 'p1' });
  const created = await store.create(['https://example.com']);
  await store.markActive(created.workspaceId, 42);
  const closed = await store.markClosed(created.workspaceId);
  assert.equal(closed.activeTabId, null);
  assert.equal(closed.closedAt, 1000);
  assert.equal((await store.listIndex()).length, 1);
});

test('clone creates independent workspace and pane ids while preserving history', async () => {
  let workspaceId = 0;
  let paneId = 0;
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({
    localArea,
    now: () => 5,
    makeWorkspaceId: () => `w${++workspaceId}`,
    makePaneId: () => `p${++paneId}`,
  });
  const source = await store.create(['https://example.com/a']);
  const clone = await store.clone(source.workspaceId);
  assert.notEqual(clone.workspaceId, source.workspaceId);
  assert.notEqual(clone.panes[0].paneId, source.panes[0].paneId);
  assert.deepEqual(clone.panes[0].history, source.panes[0].history);
});

test('cleanup retains only 20 newest closed records and preserves active records', async () => {
  let clock = 0;
  let pane = 0;
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({
    localArea,
    now: () => ++clock,
    makeWorkspaceId: () => `generated-${clock}`,
    makePaneId: () => `pane-${++pane}`,
  });
  for (let i = 0; i < 23; i += 1) {
    const item = await store.create([`https://example.com/${i}`], { workspaceId: `closed-${i}` });
    await store.markClosed(item.workspaceId);
  }
  const active = await store.create(['https://active.example'], { workspaceId: 'active' });
  await store.markActive(active.workspaceId, 99);
  await store.cleanup();
  const index = await store.listIndex();
  assert.equal(index.filter((entry) => entry.closedAt != null).length, 20);
  assert.ok(index.some((entry) => entry.workspaceId === 'active' && entry.activeTabId === 99));
});

test('budget cleanup deletes closed workspaces before trimming active history', async () => {
  const localArea = makeStorage();
  let forcedBytes = WS.SOFT_BUDGET_BYTES + 1;
  const store = new WS.WorkspaceStore({
    localArea,
    now: () => 100,
    makeWorkspaceId: () => 'generated',
    makePaneId: (() => { let id = 0; return () => `p-${++id}`; })(),
    getBytesInUse: async () => forcedBytes,
  });
  const closed = await store.create(['https://closed.example'], { workspaceId: 'closed' });
  await store.markClosed(closed.workspaceId);
  let active = await store.create(['https://active.example/0'], { workspaceId: 'active' });
  active = WS.recordNavigation(active, active.panes[0].paneId, 'https://active.example/1').workspace;
  await store.save({ ...active, activeTabId: 9 });

  const originalRemove = localArea.remove.bind(localArea);
  localArea.remove = async (keys) => {
    await originalRemove(keys);
    if ([].concat(keys).includes(WS.workspaceKey('closed'))) forcedBytes = 0;
  };

  await store.cleanup();
  assert.equal(await store.load('closed'), null);
  const kept = await store.load('active');
  assert.equal(kept.panes[0].history.length, 2);
  assert.equal(kept.panes[0].history[kept.panes[0].historyIndex].url, 'https://active.example/1');
});
