# Restore Closed Split-View Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Ctrl + Shift + T` restore the same Focus Multi View workspace, including every pane, current URL, retained Back/Forward URL history, layout, pane-control positions, active pane, and supported Focus mode/UI state, without unbounded history growth.

**Architecture:** Every grid tab has a stable opaque UUID in `grid.html?workspace=<uuid>`. Versioned workspace snapshots live in `chrome.storage.local`; after registration, the Manifest V3 service worker is the single durable mutation coordinator. Every pane first loads an extension-owned bootstrap page so the worker can bind the direct child `frameId` to a stable pane ID without host permission, then `webNavigation` records URL history in basic, mixed-host, and Enhanced modes alike.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Chrome `storage`, `tabs`, `webNavigation`, `declarativeNetRequest`, `runtime.Port`, Node.js `node:test` and `assert`.

**Spec:** `docs/superpowers/specs/2026-09-17-restore-closed-workspace-design.md`

## Global Constraints

- Retain at most **50 history entries per pane**.
- Retain at most **20 closed workspaces**.
- Keep the existing **9-pane maximum**.
- Use a **6 MiB soft budget** for Focus workspace keys only, measured with `chrome.storage.local.getBytesInUse(keys)`.
- Never automatically delete an active workspace.
- Do not add `sessions` or `unlimitedStorage` permissions.
- Persist URL/navigation metadata and Focus state only; never persist page bodies, credentials, cookies, authorization headers, arbitrary DOM text, or form values.
- Outer grid URLs contain only `workspace=<opaque uuid>`; pane URLs/history never appear in the outer URL.
- Bootstrap URLs contain only opaque `workspace` and `pane` IDs; the remote target URL is sent after bootstrap readiness.
- Basic/mixed-host history tracking must not require optional host permission or page-script injection.
- Preserve templates, 2–9 pane launch, compatibility mode, Enhanced same-host mode, same-host popup routing, draggable pane controls, and deferred splitter resizing.
- After a workspace is registered, only the service worker writes its durable workspace record.
- All live routing is scoped by outer tab plus workspace/session identity.

---

## File Map

**Create**

- `src/workspace/workspace-store.js` — schema, pure history operations, storage adapter, retention cleanup, create/clone/open/close operations.
- `src/background/workspace-frame-registry.js` — universal direct-pane frame bindings and JSON-safe recovery snapshots.
- `pane-bootstrap.html` — extension-owned pane bootstrap document.
- `pane-bootstrap.js` — validates parent target message and calls `location.replace(targetUrl)`.
- `tests/workspace-store.test.js` — history/schema/storage/retention tests.
- `tests/workspace-frame-registry.test.js` — universal frame binding/recovery tests.
- `tests/workspace-restore-static.test.js` — launch/grid/bootstrap/background/permission regression wiring.

**Modify**

- `popup.html`, `popup.js`
- `grid.js`
- `src/background/service-worker.js`
- `tests/background-static.test.js`
- `tests/grid-static.test.js`
- `tests/grid-enhanced-static.test.js`
- `tests/popup-static.test.js`
- `tests/popup-enhanced-static.test.js`
- `tests/manifest-static.test.js`
- `README.md`

`src/background/frame-registry.js` stays focused on Enhanced same-host bridge state unless a compatibility change is proven necessary by tests.

---

### Task 1: Implement the versioned bounded workspace/history model

**Files:**
- Create: `src/workspace/workspace-store.js`
- Create: `tests/workspace-store.test.js`

**Interfaces:**

`MPVWorkspaceStore` exports both CommonJS and `globalThis.MPVWorkspaceStore` with:

```text
SCHEMA_VERSION = 1
MAX_HISTORY_ENTRIES = 50
MAX_CLOSED_WORKSPACES = 20
SOFT_BUDGET_BYTES = 6 * 1024 * 1024
INDEX_KEY = 'mpv:workspace-index'
workspaceKey(workspaceId) -> string
createWorkspaceFromUrls(urls, options) -> workspace
normalizeWorkspace(value) -> workspace | null
cloneWorkspace(workspace, options) -> workspace
recordNavigation(workspace, paneId, url) -> { workspace, changed }
prepareTraversal(workspace, paneId, direction) -> { index, url } | null
confirmTraversal(workspace, paneId, expectedIndex, expectedUrl) -> { workspace, changed }
trimPaneHistory(pane) -> pane
```

`createWorkspaceFromUrls()` options are exactly:

```js
{
  workspaceId,
  now,
  makePaneId,
  ui: {
    enhancedOptInHostname,
    compatibilityEnabled,
  },
}
```

- [ ] **Step 1: Write failing creation/schema tests**

Create `tests/workspace-store.test.js`:

```js
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
```

- [ ] **Step 2: Verify RED**

```bash
node --test tests/workspace-store.test.js
```

Expected: FAIL because `src/workspace/workspace-store.js` does not exist.

- [ ] **Step 3: Implement constants, grid dimensions, creation, and normalization**

Use the repository's IIFE/CommonJS pattern. Compute initial dimensions exactly like the current grid:

```js
function computeDims(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows };
}
```

`normalizeWorkspace()` must accept only schema version 1, valid workspace/pane IDs, 1–9 valid panes, finite positive layout sizes, valid HTTP/S history URLs, and clamp `historyIndex`. Drop malformed fields/panes when recovery is safe; return `null` if no valid pane remains.

- [ ] **Step 4: Write failing navigation tests**

```js
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
```

- [ ] **Step 5: Verify RED, then implement history helpers**

```bash
node --test tests/workspace-store.test.js
```

`recordNavigation()` must truncate entries after the current index before appending, suppress a consecutive duplicate/reload, trim oldest entries above 50, and adjust the index. `prepareTraversal()` does not mutate. `confirmTraversal()` mutates only when the expected retained index still contains the expected URL.

Core traversal implementation:

```js
function prepareTraversal(workspace, paneId, direction) {
  const pane = workspace.panes.find((item) => item.paneId === paneId);
  if (!pane) return null;
  const delta = direction === 'back' ? -1 : direction === 'forward' ? 1 : 0;
  const index = pane.historyIndex + delta;
  if (!delta || index < 0 || index >= pane.history.length) return null;
  return { index, url: pane.history[index].url };
}
```

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test tests/workspace-store.test.js
node --test tests/*.test.js
git add src/workspace/workspace-store.js tests/workspace-store.test.js
git commit -m "feat: add bounded workspace history model"
```

---

### Task 2: Implement durable workspace storage, cloning, and retention cleanup

**Files:**
- Modify: `src/workspace/workspace-store.js`
- Modify: `tests/workspace-store.test.js`

**Interfaces:**

```text
new WorkspaceStore({ localArea, now, makeWorkspaceId, makePaneId, getBytesInUse })
create(urls, options = {}) -> Promise<workspace>
load(workspaceId) -> Promise<workspace | null>
save(workspace) -> Promise<workspace>
clone(workspaceId) -> Promise<workspace | null>
markActive(workspaceId, tabId) -> Promise<workspace | null>
markClosed(workspaceId) -> Promise<workspace | null>
listIndex() -> Promise<indexEntry[]>
cleanup() -> Promise<void>
```

`create()` forwards `options.workspaceId` and `options.ui` to `createWorkspaceFromUrls()`. `clone()` creates a new workspace UUID, new pane IDs, remaps `activePaneId`, preserves URLs/history/layout/UI, clears `activeTabId`/`closedAt`, and refreshes timestamps.

- [ ] **Step 1: Add in-memory storage fake and failing persistence tests**

```js
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
      return Buffer.byteLength(JSON.stringify(Object.fromEntries(selected.map((key) => [key, data[key]]))));
    },
  };
}

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
  let id = 0;
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({ localArea, now: () => 5, makeWorkspaceId: () => `w${++id}`, makePaneId: () => `p${++id}` });
  const source = await store.create(['https://example.com/a']);
  const clone = await store.clone(source.workspaceId);
  assert.notEqual(clone.workspaceId, source.workspaceId);
  assert.notEqual(clone.panes[0].paneId, source.panes[0].paneId);
  assert.deepEqual(clone.panes[0].history, source.panes[0].history);
});
```

- [ ] **Step 2: Verify RED and implement create/load/save/index/clone/open/close**

```bash
node --test tests/workspace-store.test.js
```

`save()` must normalize before write and update one compact index entry. `markActive()` clears `closedAt`, sets `activeTabId`, and refreshes `lastSeenAt`/`updatedAt`. `markClosed()` sets `activeTabId=null` and `closedAt=now()`.

- [ ] **Step 3: Add failing 20-workspace retention test**

```js
test('cleanup retains only 20 newest closed records and preserves active records', async () => {
  let clock = 0;
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({
    localArea,
    now: () => ++clock,
    makeWorkspaceId: () => `generated-${clock}`,
    makePaneId: () => `pane-${clock}`,
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
```

- [ ] **Step 4: Add failing byte-budget ordering test**

Inject `getBytesInUse(keys)` so the test can report an over-budget value until the oldest closed key is removed, then report a second over-budget value until non-current history is trimmed. Assert:

```js
assert.equal(localArea.data['mpv:workspace:old-closed'], undefined);
assert.equal(activeAfter.panes[0].history[activeAfter.panes[0].historyIndex].url, currentUrlBefore);
assert.ok(activeAfter.panes[0].history.length >= 1);
```

- [ ] **Step 5: Implement deterministic cleanup order**

`cleanup()` performs exactly:

1. normalize index entries;
2. delete closed records older than the newest 20;
3. compute bytes using `[INDEX_KEY, ...workspaceKeys]` only;
4. while over 6 MiB and closed records remain, delete the oldest closed record;
5. if still over budget, iterate active workspaces oldest `updatedAt` first and remove the oldest non-current history entry from panes round-robin, preserving each pane's current entry and at least one entry;
6. stop when under budget or no legal trim remains;
7. never delete an active workspace.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test tests/workspace-store.test.js
node --test tests/*.test.js
git add src/workspace/workspace-store.js tests/workspace-store.test.js
git commit -m "feat: persist and prune workspace snapshots"
```

---

### Task 3: Launch new split views as persisted workspace URLs

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `tests/popup-static.test.js`
- Modify: `tests/popup-enhanced-static.test.js`
- Create: `tests/workspace-restore-static.test.js`

**Interfaces:**

Popup consumes `MPVWorkspaceStore.WorkspaceStore`. The normal launch result is only:

```text
chrome-extension://<id>/grid.html?workspace=<uuid>
```

- [ ] **Step 1: Write failing static tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const popupHtml = fs.readFileSync('popup.html', 'utf8');
const popupJs = fs.readFileSync('popup.js', 'utf8');

test('popup loads workspace store before popup script', () => {
  assert.match(popupHtml, /src\/workspace\/workspace-store\.js[\s\S]*popup\.js/);
});

test('launch persists a workspace and opens an opaque workspace URL', () => {
  assert.match(popupJs, /new MPVWorkspaceStore\.WorkspaceStore/);
  assert.match(popupJs, /searchParams\.set\(['"]workspace['"]/);
  assert.doesNotMatch(popupJs, /searchParams\.set\(['"]url/);
});
```

Update `tests/popup-enhanced-static.test.js` so it requires the granted exact-host opt-in to be stored as `ui.enhancedOptInHostname` in the initial workspace rather than relying on transient `launchEnhancedHostname` for durability.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/workspace-restore-static.test.js tests/popup-static.test.js tests/popup-enhanced-static.test.js
```

- [ ] **Step 3: Load workspace store in `popup.html`**

```html
<script src="common.js"></script>
<script src="src/workspace/workspace-store.js"></script>
<script src="popup.js"></script>
```

- [ ] **Step 4: Persist before opening the grid**

At module scope:

```js
const workspaceStore = new MPVWorkspaceStore.WorkspaceStore({
  localArea: chrome.storage.local,
  getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
});
```

In `launchUrls()` after the existing user-gesture Enhanced permission request:

```js
const workspace = await workspaceStore.create(cleanUrls, {
  ui: { enhancedOptInHostname: launchEnhancedHostname },
});
const gridUrl = new URL(chrome.runtime.getURL('grid.html'));
gridUrl.searchParams.set('workspace', workspace.workspaceId);
await chrome.tabs.create({ url: gridUrl.toString() });
```

Keep popup form/template persistence unchanged. Stop writing normal launches to transient `launchUrls`/`launchEnhancedHostname`; Task 6 retains a read-only legacy fallback for already-open old grid URLs.

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test tests/workspace-restore-static.test.js tests/popup-static.test.js tests/popup-enhanced-static.test.js
node --test tests/*.test.js
git add popup.html popup.js tests/popup-static.test.js tests/popup-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: launch grids with stable workspace ids"
```

---

### Task 4: Add universal pane bootstrap and frame binding

**Files:**
- Create: `pane-bootstrap.html`
- Create: `pane-bootstrap.js`
- Create: `src/background/workspace-frame-registry.js`
- Create: `tests/workspace-frame-registry.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

`MPVWorkspaceFrameRegistry.WorkspaceFrameRegistry`:

```text
registerWorkspace({ tabId, workspaceId, paneIds }) -> boolean
bindBootstrap({ tabId, frameId, documentId, workspaceId, paneId }) -> record | null
updateDocument({ tabId, frameId, documentId, url }) -> record | null
findPaneByFrame(tabId, frameId) -> record | null
getPane(tabId, paneId) -> record | null
replacePaneIds(tabId, workspaceId, paneIds) -> boolean
removeFrame(tabId, frameId) -> void
removeWorkspace(tabId) -> void
serialize() -> object
restore(snapshot) -> void
```

Bootstrap messages:

```js
{ type: 'mpv:pane-bootstrap-ready', workspaceId, paneId }
{ type: 'mpv:pane-bootstrap-target', workspaceId, paneId, targetUrl }
```

- [ ] **Step 1: Write failing registry tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceFrameRegistry } = require('../src/background/workspace-frame-registry.js');

test('registered pane keeps the same frame binding across documents', () => {
  const registry = new WorkspaceFrameRegistry();
  assert.equal(registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] }), true);
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd1', workspaceId: 'w', paneId: 'p' }).paneId, 'p');
  assert.equal(registry.updateDocument({ tabId: 7, frameId: 3, documentId: 'd2', url: 'https://example.com/a' }).documentId, 'd2');
  assert.equal(registry.findPaneByFrame(7, 3).paneId, 'p');
});

test('unregistered pane id cannot claim a frame', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] });
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'd', workspaceId: 'w', paneId: 'other' }), null);
});
```

- [ ] **Step 2: Verify RED, then implement registry**

```bash
node --test tests/workspace-frame-registry.test.js
```

Follow `frame-registry.js`'s IIFE/CommonJS style. A record is exactly `{ tabId, workspaceId, paneId, frameId, documentId, url }`. Reject duplicate conflicting frame/pane claims. `serialize()` returns JSON-safe data only; `restore()` ignores malformed rows.

- [ ] **Step 3: Write failing bootstrap static test**

```js
const bootstrapHtml = fs.readFileSync('pane-bootstrap.html', 'utf8');
const bootstrapJs = fs.readFileSync('pane-bootstrap.js', 'utf8');
assert.match(bootstrapHtml, /pane-bootstrap\.js/);
assert.match(bootstrapJs, /mpv:pane-bootstrap-ready/);
assert.match(bootstrapJs, /mpv:pane-bootstrap-target/);
assert.match(bootstrapJs, /location\.replace\(targetUrl\)/);
assert.doesNotMatch(bootstrapJs, /searchParams\.get\(['"]target/);
```

- [ ] **Step 4: Implement bootstrap without leaking targets or losing the listener on unrelated messages**

`pane-bootstrap.html` loads only `pane-bootstrap.js`.

```js
'use strict';

const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspace') || '';
const paneId = params.get('pane') || '';

parent.postMessage({ type: 'mpv:pane-bootstrap-ready', workspaceId, paneId }, location.origin);

function onTarget(event) {
  if (event.source !== parent || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.type !== 'mpv:pane-bootstrap-target') return;
  if (message.workspaceId !== workspaceId || message.paneId !== paneId) return;
  const targetUrl = String(message.targetUrl || '');
  if (!/^https?:\/\//i.test(targetUrl)) return;
  window.removeEventListener('message', onTarget);
  location.replace(targetUrl);
}

window.addEventListener('message', onTarget);
```

- [ ] **Step 5: Verify GREEN and commit**

```bash
node --test tests/workspace-frame-registry.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
git add pane-bootstrap.html pane-bootstrap.js src/background/workspace-frame-registry.js tests/workspace-frame-registry.test.js tests/workspace-restore-static.test.js
git commit -m "feat: add universal pane frame bootstrap"
```

---

### Task 5: Make the service worker the workspace coordinator

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

Additional grid Port requests:

```text
mpv:workspace-register { workspaceId }
  -> { ok, workspaceId, workspace, cloned }
mpv:workspace-recover { urls }
  -> { ok, workspaceId, workspace }
mpv:workspace-ui-patch { patch }
mpv:workspace-pane-patch { paneId, controlPosition }
mpv:workspace-pane-add { paneId, url }
mpv:workspace-pane-remove { paneId }
```

Background push:

```js
{ type: 'mpv:workspace-state', workspace }
```

Worker state:

```text
workspaceQueues: Map<workspaceId, Promise>
tabToWorkspace: Map<tabId, workspaceId>
workspaceFrames: WorkspaceFrameRegistry
workspaceStore: WorkspaceStore
```

- [ ] **Step 1: Write failing static tests**

Add assertions that worker source contains:

```js
assert.match(worker, /\.\.\/workspace\/workspace-store\.js/);
assert.match(worker, /workspace-frame-registry\.js/);
assert.match(worker, /mpv:workspace-register/);
assert.match(worker, /mpv:workspace-recover/);
assert.match(worker, /mpv:workspace-pane-patch/);
assert.match(worker, /queueWorkspaceMutation/);
assert.match(worker, /new URL\(port\.sender\.url\)/);
assert.doesNotMatch(worker, /port\.sender\.url === GRID_URL/);
```

- [ ] **Step 2: Verify RED**

```bash
node --test tests/background-static.test.js tests/workspace-restore-static.test.js
```

- [ ] **Step 3: Import and instantiate workspace infrastructure**

```js
importScripts('../workspace/workspace-store.js', 'workspace-frame-registry.js', 'frame-registry.js', 'popup-router.js');

const workspaceStore = new MPVWorkspaceStore.WorkspaceStore({
  localArea: chrome.storage.local,
  getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
});
const workspaceFrames = new MPVWorkspaceFrameRegistry.WorkspaceFrameRegistry();
const workspaceQueues = new Map();
const tabToWorkspace = new Map();
```

Replace exact `port.sender.url === GRID_URL` trust with `isGridUrl(url)` that compares parsed `origin` and `pathname` to `chrome.runtime.getURL('grid.html')`, allowing only the `workspace` query parameter.

- [ ] **Step 4: Implement a correct per-workspace mutation queue**

Use this exact pattern so an older completion cannot remove a newer queued promise:

```js
function queueWorkspaceMutation(workspaceId, mutation) {
  const previous = workspaceQueues.get(workspaceId) || Promise.resolve();
  let tracked;
  const next = previous.catch(() => {}).then(mutation);
  tracked = next.finally(() => {
    if (workspaceQueues.get(workspaceId) === tracked) workspaceQueues.delete(workspaceId);
  });
  workspaceQueues.set(workspaceId, tracked);
  return tracked;
}
```

- [ ] **Step 5: Implement workspace registration and duplicate-live cloning**

`mpv:workspace-register`:

1. load requested record;
2. if missing, return `{ ok:false, missing:true }`;
3. if `activeTabId` points to another tab, call `chrome.tabs.get(activeTabId)`;
4. if that tab still exists and is a grid owning the same workspace, clone with `workspaceStore.clone()`;
5. if `chrome.tabs.get()` rejects, treat the old owner as stale and reuse the same workspace;
6. mark the effective workspace active for sender tab;
7. set `tabToWorkspace`;
8. register pane IDs in `workspaceFrames`;
9. return normalized snapshot and effective ID.

`mpv:workspace-recover` is only for a missing/legacy grid startup. It normalizes 1–9 supplied fallback URLs, creates a fresh workspace through `workspaceStore.create()`, marks it active for the sender tab, registers its pane IDs, and returns it.

- [ ] **Step 6: Implement serialized UI and structural mutations**

Every mutation first verifies `tabToWorkspace.get(tabId) === requested/effective workspaceId`, then runs inside `queueWorkspaceMutation()` and loads the latest snapshot before changing it.

Whitelisted `mpv:workspace-ui-patch.patch` fields are exactly:

```js
{
  layout: { cols, rows, colSizes, rowSizes },
  activePaneId,
  ui: {
    floatingTriggerPosition,
    floatingPanelOpen,
    enhancedOptInHostname,
    compatibilityEnabled,
  },
}
```

`mpv:workspace-pane-patch` changes only one pane's `controlPosition`.

`mpv:workspace-pane-add` appends one pane with one history URL at index 0, rejects duplicate IDs and >9 panes, saves, then calls `workspaceFrames.replacePaneIds()`.

`mpv:workspace-pane-remove` removes one pane, refuses to remove the final pane, repairs `activePaneId`, saves, then calls `workspaceFrames.replacePaneIds()`.

After each successful mutation, push `mpv:workspace-state` only to that outer tab's dedicated Port.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test tests/background-static.test.js tests/workspace-restore-static.test.js tests/workspace-store.test.js
node --test tests/*.test.js
git add src/background/service-worker.js tests/background-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: coordinate durable workspace state"
```

---

### Task 6: Restore the grid from a workspace snapshot and persist completed UI state

**Files:**
- Modify: `grid.js`
- Modify: `tests/grid-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

```text
workspaceIdFromLocation() -> string
registerWorkspace() -> Promise<workspace>
restoreWorkspace(snapshot) -> void
bootstrapUrlForPane(paneId) -> string
navigatePaneTo(pane, url, { bootstrap = false } = {}) -> void
sendWorkspaceUiPatch(patch) -> Promise<boolean>
createPane(url, options = {})
```

`createPane()` accepts `options.paneId`, `controlPosition`, `history`, and `historyIndex`.

- [ ] **Step 1: Write failing grid restore tests**

```js
assert.match(gridJs, /new URLSearchParams\(location\.search\)/);
assert.match(gridJs, /mpv:workspace-register/);
assert.match(gridJs, /mpv:workspace-recover/);
assert.match(gridJs, /pane-bootstrap\.html/);
assert.match(gridJs, /options\.paneId/);
assert.match(gridJs, /restoreWorkspace/);
```

- [ ] **Step 2: Verify RED**

```bash
node --test tests/grid-static.test.js tests/workspace-restore-static.test.js
```

- [ ] **Step 3: Make pane construction use stable IDs and bootstrap URLs**

```js
function createPane(url, options = {}) {
  const paneId = options.paneId || crypto.randomUUID();
  // existing DOM construction
  iframe.name = `focus-pane:${paneId}`;
  iframe.src = bootstrapUrlForPane(paneId);
  const pane = {
    // existing fields
    id: paneId,
    history: (options.history || [{ url }]).map((entry) => ({ ...entry })),
    historyIndex: Number.isInteger(options.historyIndex) ? options.historyIndex : 0,
    pendingTargetUrl: url,
  };
  return pane;
}
```

`bootstrapUrlForPane()` adds only `workspace` and `pane` parameters. A single grid `message` listener finds the matching pane by `event.source === pane.iframe.contentWindow`, verifies extension origin and exact IDs, then posts the target URL to that iframe.

- [ ] **Step 4: Register before creating panes**

Startup order:

```text
connect Port
-> wait for mpv:background-ready
-> parse workspace UUID
-> mpv:workspace-register
-> if cloned: history.replaceState() to effective UUID
-> if missing/no UUID: read legacy launchUrls/default URLs and call mpv:workspace-recover
-> restore panes/layout/UI
-> initialize Compatibility/Enhanced state
```

Do not build default panes before workspace registration/recovery completes.

- [ ] **Step 5: Restore persisted layout without resetting it**

Refactor `layoutPanes({ preserveTrackSizes = false } = {})`. During restore, compute expected row/column counts, validate persisted arrays have the correct lengths and positive finite values, assign them, and call `layoutPanes({ preserveTrackSizes:true })`.

On splitter release only:

```js
await sendWorkspaceUiPatch({
  layout: { cols, rows, colSizes: [...colSizes], rowSizes: [...rowSizes] },
});
```

Never persist resize pointer-move previews.

- [ ] **Step 6: Persist completed control/UI state**

After pane-control drag ends:

```js
portRequest('mpv:workspace-pane-patch', {
  paneId: pane.id,
  controlPosition: { ...pane.controlPosition },
});
```

After active pane change, floating trigger drag completion, panel open/close, explicit Enhanced opt-in change, and successful Compatibility toggle, send only the corresponding allowed `mpv:workspace-ui-patch` field.

- [ ] **Step 7: Reconcile `mpv:workspace-state` pushes without unnecessary iframe reloads**

Update each existing pane's `history`, `historyIndex`, control/button metadata, layout, and UI state. Structural pane additions/removals update DOM once. A history metadata update must not reset `iframe.src` unless the worker explicitly requests traversal/rebind.

- [ ] **Step 8: Verify GREEN and commit**

```bash
node --test tests/grid-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
git add grid.js tests/grid-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: restore grid workspace snapshots"
```

---

### Task 7: Record universal navigation and make retained Back/Forward authoritative

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `grid.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/grid-static.test.js`
- Modify: `tests/grid-enhanced-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

```text
mpv:history-traverse { paneId, direction: 'back' | 'forward' }
  -> { ok, paneId, index, url }
pendingTraversals key = `${tabId}:${paneId}`
value = { index, url, expiresAt }
```

- [ ] **Step 1: Write failing navigation/static tests**

```js
assert.match(worker, /webNavigation\.onCommitted/);
assert.match(worker, /webNavigation\.onHistoryStateUpdated/);
assert.match(worker, /webNavigation\.onReferenceFragmentUpdated/);
assert.match(worker, /mpv:history-traverse/);
assert.match(gridJs, /mpv:history-traverse/);
```

Also assert Back/Forward buttons are no longer `enhanced-only`.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
```

- [ ] **Step 3: Bind direct bootstrap commits before Enhanced-mode navigation logic**

In `webNavigation.onCommitted`:

```js
if (details.frameId > 0 && details.parentFrameId === 0 && isPaneBootstrapUrl(details.url)) {
  const ids = parsePaneBootstrapUrl(details.url);
  const record = workspaceFrames.bindBootstrap({
    tabId: details.tabId,
    frameId: details.frameId,
    documentId: details.documentId,
    workspaceId: ids.workspaceId,
    paneId: ids.paneId,
  });
  if (record) persistLiveBindingsSoon();
  return;
}
```

Nested frames never bind. For later HTTP/S commits, first look up `workspaceFrames.findPaneByFrame(tabId, frameId)` and record universal history; then continue the existing Enhanced-mode hostname/bridge logic independently.

- [ ] **Step 4: Use one navigation recorder for committed, SPA, and fragment events**

`recordPaneNavigation(details)` does:

1. require an existing universal pane binding;
2. require HTTP/S URL;
3. update frame document/url metadata;
4. inspect pending traversal intent;
5. if expected index+URL match, call `confirmTraversal()`;
6. otherwise clear the intent and call `recordNavigation()`;
7. if `changed`, save through `queueWorkspaceMutation()` and push `mpv:workspace-state`.

`onHistoryStateUpdated` and `onReferenceFragmentUpdated` call the same recorder. Reload/same-current URL produces `changed:false` and no durable history growth.

- [ ] **Step 5: Implement traversal intent without pre-advancing durable history**

On `mpv:history-traverse`, load the current workspace, call `prepareTraversal()`, and if valid:

```js
pendingTraversals.set(`${tabId}:${paneId}`, {
  index: target.index,
  url: target.url,
  expiresAt: Date.now() + 5000,
});
postResult(port, message.requestId, true, {
  paneId,
  index: target.index,
  url: target.url,
});
```

Expired intents are removed before use. If the next navigation URL differs, clear the intent and record it as a normal new navigation, which correctly truncates the old forward branch.

- [ ] **Step 6: Make Back/Forward controls universal in `grid.js`**

Enable Back when `historyIndex > 0`; enable Forward when `historyIndex < history.length - 1`.

```js
const response = await portRequest('mpv:history-traverse', {
  paneId: pane.id,
  direction: 'back',
});
if (response?.ok && response.url) navigatePaneTo(pane, response.url);
```

Do not use the Enhanced bridge's `history.back()`/`history.forward()` for these controls. Keep Enhanced title/focus reporting, same-host popup routing, and native-tab escape unchanged.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test tests/workspace-store.test.js tests/workspace-frame-registry.test.js tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
git add src/background/service-worker.js grid.js tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: retain pane navigation history"
```

---

### Task 8: Persist close/restore lifecycle and service-worker recovery

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/background/workspace-frame-registry.js`
- Modify: `tests/workspace-frame-registry.test.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

```text
SESSION_BINDINGS_KEY = 'mpv:workspace-live-bindings'
persistLiveBindingsSoon()
restoreLiveBindings()
reconcileOpenWorkspaces()
markWorkspaceClosedForTab(tabId)
```

Port disconnect does **not** mark a workspace closed. `tabs.onRemoved` owns normal close detection.

- [ ] **Step 1: Write failing restart/close tests**

```js
assert.match(worker, /mpv:workspace-live-bindings/);
assert.match(worker, /tabs\.onRemoved/);
assert.match(worker, /markWorkspaceClosedForTab/);
assert.match(worker, /reconcileOpenWorkspaces/);
assert.match(worker, /webNavigation\.getAllFrames/);
```

Add registry tests proving `serialize()` then `restore()` preserves valid records and ignores malformed records.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
```

- [ ] **Step 3: Persist live frame bindings in `chrome.storage.session`**

Coalesce writes after workspace registration, bootstrap bind, document update, frame removal, pane-list replacement, and tab removal:

```js
await chrome.storage.session.set({
  [SESSION_BINDINGS_KEY]: workspaceFrames.serialize(),
});
```

This is recovery metadata only; durable history remains in local workspace records.

- [ ] **Step 4: Restore and validate live bindings after worker wake/start**

1. load `SESSION_BINDINGS_KEY`;
2. `workspaceFrames.restore(snapshot)`;
3. for each stored tab, call `chrome.webNavigation.getAllFrames({ tabId })`;
4. remove frame records whose `frameId` no longer exists;
5. persist the cleaned registry;
6. when a connected grid lacks a binding for a retained pane, push `{ type:'mpv:pane-rebind', paneId }`.

Grid handles `mpv:pane-rebind` by setting that pane back to its bootstrap URL and then sending the current retained target when bootstrap signals readiness.

- [ ] **Step 5: Mark closed only from actual tab removal**

```js
function markWorkspaceClosedForTab(tabId) {
  const workspaceId = tabToWorkspace.get(tabId);
  if (!workspaceId) return Promise.resolve();
  return queueWorkspaceMutation(workspaceId, async () => {
    await workspaceStore.markClosed(workspaceId);
    await workspaceStore.cleanup();
  }).finally(() => {
    tabToWorkspace.delete(tabId);
    workspaceFrames.removeWorkspace(tabId);
    persistLiveBindingsSoon();
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  markWorkspaceClosedForTab(tabId).catch(() => {});
  // preserve existing pending-popup cleanup
});
```

The grid Port `onDisconnect` only clears ephemeral Port/Enhanced-session state; it does not call `markClosed()`.

- [ ] **Step 6: Reconcile stale active records after startup**

`reconcileOpenWorkspaces()`:

1. `chrome.tabs.query({})`;
2. keep tabs where `isGridUrl(tab.url)` is true;
3. parse each open workspace UUID;
4. compare with `workspaceStore.listIndex()`;
5. for records with `activeTabId != null` but no matching open grid tab, call `markClosed(workspaceId)`;
6. call `workspaceStore.cleanup()` after reconciliation.

A later Ctrl+Shift+T registration clears `closedAt` again. If tab removal marking raced with restore, `workspace-register` checks the old `activeTabId` with `chrome.tabs.get()` and reuses the same record when that tab no longer exists.

- [ ] **Step 7: Verify GREEN and commit**

```bash
node --test tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
git add src/background/service-worker.js src/background/workspace-frame-registry.js tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: recover closed workspace lifecycle"
```

---

### Task 9: Restore Compatibility, Enhanced opt-in, active pane, and floating UI safely

**Files:**
- Modify: `grid.js`
- Modify: `tests/grid-enhanced-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**

Snapshot fields:

```text
ui.compatibilityEnabled
ui.enhancedOptInHostname
ui.floatingTriggerPosition
ui.floatingPanelOpen
activePaneId
```

- [ ] **Step 1: Write failing state-restore tests**

Require `grid.js` to read the snapshot fields above, use `chrome.permissions.contains()` for automatic restore, and never call `chrome.permissions.request()` from the automatic restore function.

- [ ] **Step 2: Verify RED**

```bash
node --test tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
```

- [ ] **Step 3: Restore Compatibility without prompting**

After `chrome.tabs.getCurrent()` gives the restored tab ID:

```js
if (workspace.ui.compatibilityEnabled) {
  const granted = await chrome.permissions.contains(COMPAT_ORIGINS);
  if (granted) await enableCompatRules();
  else setCompatibilityUi(false);
}
```

A successful user toggle persists `ui.compatibilityEnabled`. Because the DNR rule is recreated with the new outer tab ID, Ctrl+Shift+T does not depend on the old session rule.

- [ ] **Step 4: Restore Enhanced opt-in without prompting**

Initialize `enhancedOptInHostname` from the snapshot. After panes exist, call existing `syncEnhancedSession()`, which must continue to require exact-host eligibility plus already-granted permission via `chrome.permissions.contains()`. Only the explicit Enhanced button may call `permissions.request()`; after success persist `ui.enhancedOptInHostname`.

- [ ] **Step 5: Restore active/floating UI after layout measurement**

Apply the active pane class, trigger position, and floating panel visibility after pane/layout construction. Persist later changes only after interaction completion.

- [ ] **Step 6: Verify GREEN and commit**

```bash
node --test tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
git add grid.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: restore workspace mode and ui state"
```

---

### Task 10: Lock privacy/retention acceptance, documentation, and final verification

**Files:**
- Modify: `tests/manifest-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`
- Modify: `README.md`
- Verify: `manifest.json`
- Verify: all JavaScript files

- [ ] **Step 1: Add failing manifest/privacy acceptance tests**

```js
test('workspace restore adds no sessions or unlimitedStorage permissions', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.permissions.includes('sessions'), false);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
```

In `tests/workspace-restore-static.test.js`, assert:

```text
MAX_HISTORY_ENTRIES === 50
MAX_CLOSED_WORKSPACES === 20
SOFT_BUDGET_BYTES === 6 * 1024 * 1024
outer grid URL builder sets only workspace
bootstrap URL builder sets only workspace and pane
tabs.onRemoved invokes close marking
Port disconnect does not invoke workspaceStore.markClosed
basic-mode navigation recorder is not gated by Enhanced permission
```

- [ ] **Step 2: Run acceptance tests and fix only demonstrated gaps**

```bash
node --test tests/manifest-static.test.js tests/workspace-restore-static.test.js
```

Do not add permissions or unrelated refactors.

- [ ] **Step 3: Update README restoration boundary**

Document that Ctrl+Shift+T restores pane URLs, retained Back/Forward URL history, pane order/layout/control positions, active pane, and supported Focus mode/UI intent. Document 50 entries/pane, 20 closed workspaces, and 6 MiB soft budget. State that arbitrary cross-origin form/DOM/heap/media state is not serialized.

- [ ] **Step 4: Run complete automated verification**

```bash
node --test tests/*.test.js
node --check common.js
node --check popup.js
node --check grid.js
node --check pane-bootstrap.js
node --check src/workspace/workspace-store.js
node --check src/background/workspace-frame-registry.js
node --check src/background/frame-registry.js
node --check src/background/popup-router.js
node --check src/background/service-worker.js
node --check src/pane/bridge.js
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8')); console.log('manifest ok')"
```

Expected: all tests pass, every syntax check exits 0, and `manifest ok` prints.

- [ ] **Step 5: Run the 15-item manual Chrome checklist from the spec when browser execution is available**

At minimum cover: 2-pane close/restore, retained Back/Forward, 9 panes, >50 navigations, Back-then-new-navigation branch truncation, reload suppression, SPA/fragment URLs, mixed-host/basic mode, Enhanced permission present/removed, Compatibility rebind, worker restart, multiple workspaces, duplicate live workspace cloning, and >20 closed-workspace cleanup.

If Chrome manual execution is unavailable, report it explicitly and do not claim browser acceptance passed.

- [ ] **Step 6: Commit Task 10**

```bash
git add README.md tests/manifest-static.test.js tests/workspace-restore-static.test.js
git commit -m "test: harden workspace restore coverage"
```

---

## Final Verification Gate

Before opening a PR or claiming completion:

- [ ] Run `node --test tests/*.test.js` fresh and report exact pass/fail counts.
- [ ] Run every `node --check` command from Task 10 fresh.
- [ ] Parse `manifest.json` fresh.
- [ ] Compare `feature/restore-closed-workspace` against `main` and confirm only intended files changed.
- [ ] Re-read every spec acceptance criterion and map it to passing automation or an explicitly unperformed manual-browser item.
- [ ] Confirm `sessions` and `unlimitedStorage` are absent.
- [ ] Confirm no other repository/extension was modified.
