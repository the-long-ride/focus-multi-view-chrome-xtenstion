# Restore Closed Split-View Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Ctrl + Shift + T` restore the same Focus Multi View workspace, including every pane, current URLs, retained Back/Forward URL history, pane/layout/UI state, while bounding history to 50 entries per pane, 20 closed workspaces, and a 6 MiB soft workspace-data budget.

**Architecture:** Give every grid tab a stable opaque workspace UUID in `grid.html?workspace=<uuid>`. Persist versioned workspace snapshots in `chrome.storage.local`, with the Manifest V3 service worker as the single mutation coordinator after registration. Bind direct pane iframe frames in every mode through an extension-owned bootstrap page, record navigation through `webNavigation`, and make Focus-managed retained history authoritative for restored Back/Forward behavior.

**Tech Stack:** Chrome Extension Manifest V3, plain JavaScript, Chrome `storage`, `tabs`, `webNavigation`, `declarativeNetRequest`, `runtime.Port`, Node.js `node:test`/`assert` for automated tests.

**Spec:** `docs/superpowers/specs/2026-09-17-restore-closed-workspace-design.md`

## Global Constraints

- Maximum retained history: exactly **50 entries per pane**.
- Maximum retained closed workspaces: exactly **20**.
- Maximum panes per workspace remains **9**.
- Workspace data uses a **6 MiB soft budget** measured with `chrome.storage.local.getBytesInUse()` on workspace keys only.
- Never automatically delete an active workspace.
- Do not add `unlimitedStorage` or `sessions` permissions.
- Persist URL/navigation metadata and Focus UI state only; never persist page bodies, credentials, cookies, authorization headers, arbitrary DOM text, or form values.
- The outer grid URL contains only the opaque `workspace` UUID; pane URLs/history must not appear in it.
- Pane bootstrap URLs contain only opaque workspace/pane IDs; target site URLs must be delivered after bootstrap readiness.
- Basic/mixed-host history tracking must not require optional host permission or injected page scripts.
- Preserve current 2–9 pane launch behavior, templates, compatibility mode, same-host enhanced mode, popup routing, draggable controls, and deferred splitter resizing.
- After a workspace is registered, the service worker is the only writer of the durable workspace snapshot.
- All live grid/background routing remains isolated by outer Chrome tab plus workspace/session identity.

---

## File Structure

### New files

- `src/workspace/workspace-store.js` — versioned workspace model, history mutation helpers, storage adapter, cleanup/retention, clone/create/load/save operations; exports both CommonJS and `globalThis.MPVWorkspaceStore`.
- `src/background/workspace-frame-registry.js` — direct-child pane frame bindings independent of Enhanced Mode, including serializable live-binding snapshots.
- `pane-bootstrap.html` — minimal extension-owned iframe bootstrap document.
- `pane-bootstrap.js` — receives a target URL from its owning grid and uses `location.replace(target)`.
- `tests/workspace-store.test.js` — pure history/schema/storage/retention tests.
- `tests/workspace-frame-registry.test.js` — direct-child frame binding and recovery tests.
- `tests/workspace-restore-static.test.js` — integration/static wiring tests for launch, grid restore, bootstrap, background lifecycle, and manifest constraints.

### Existing files to modify

- `popup.html` — load `src/workspace/workspace-store.js` before `popup.js`.
- `popup.js` — create/persist a workspace before opening a grid tab and open `grid.html?workspace=<uuid>`.
- `grid.js` — register/load workspace, restore stable pane IDs/history/layout/UI, bootstrap remote pane navigation, send completed UI mutations to the service worker, and use retained history for Back/Forward.
- `src/background/service-worker.js` — import the new modules, coordinate workspace lifecycle/mutations/navigation, bind pane frames, reconcile worker restarts, close/restore lifecycle, and retention cleanup while preserving existing enhanced-mode/popup routing.
- `src/background/frame-registry.js` — keep same-host Enhanced Mode responsibilities only; change only if a small interoperability helper is required.
- `manifest.json` — no new permission; only touch if packaging/static resource wiring requires it.
- `tests/background-static.test.js` — assert universal webNavigation/workspace lifecycle integration while preserving current enhanced behavior.
- `tests/grid-enhanced-static.test.js` — ensure Enhanced Mode still coexists with workspace restore.
- `tests/grid-static.test.js` — assert bootstrap/stable-pane/layout wiring.
- `tests/popup-static.test.js` and `tests/popup-enhanced-static.test.js` — assert workspace-first launch and permission flow.
- `tests/manifest-static.test.js` — assert no `sessions`/`unlimitedStorage` permission is introduced.
- `README.md` — document Ctrl+Shift+T restoration boundary and retained-history limits.

---

### Task 1: Build the versioned workspace/history model

**Files:**
- Create: `src/workspace/workspace-store.js`
- Create: `tests/workspace-store.test.js`

**Interfaces:**
- Produces global/CommonJS API `MPVWorkspaceStore` with constants:
  - `SCHEMA_VERSION = 1`
  - `MAX_HISTORY_ENTRIES = 50`
  - `MAX_CLOSED_WORKSPACES = 20`
  - `SOFT_BUDGET_BYTES = 6 * 1024 * 1024`
  - `INDEX_KEY = 'mpv:workspace-index'`
  - `workspaceKey(workspaceId) -> string`
- Produces pure functions:
  - `createWorkspaceFromUrls(urls, options) -> workspace`
  - `normalizeWorkspace(value) -> workspace | null`
  - `cloneWorkspace(workspace, options) -> workspace`
  - `recordNavigation(workspace, paneId, url) -> { workspace, changed }`
  - `prepareTraversal(workspace, paneId, direction) -> { index, url } | null`
  - `confirmTraversal(workspace, paneId, expectedIndex, expectedUrl) -> { workspace, changed }`
  - `trimPaneHistory(pane) -> pane`
- Later tasks consume these exact names.

- [ ] **Step 1: Write failing tests for initial workspace creation and normalization**

Add tests that construct deterministic IDs/timestamps and prove every pane starts with one URL at index 0:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const WS = require('../src/workspace/workspace-store.js');

test('createWorkspaceFromUrls creates stable pane history', () => {
  let pane = 0;
  const workspace = WS.createWorkspaceFromUrls(
    ['https://example.com/a', 'https://example.com/b'],
    {
      workspaceId: 'workspace-1',
      now: 1000,
      makePaneId: () => `pane-${++pane}`,
    },
  );
  assert.equal(workspace.schemaVersion, 1);
  assert.equal(workspace.workspaceId, 'workspace-1');
  assert.deepEqual(workspace.panes.map((item) => ({
    paneId: item.paneId,
    historyIndex: item.historyIndex,
    history: item.history,
  })), [
    { paneId: 'pane-1', historyIndex: 0, history: [{ url: 'https://example.com/a' }] },
    { paneId: 'pane-2', historyIndex: 0, history: [{ url: 'https://example.com/b' }] },
  ]);
  assert.equal(workspace.closedAt, null);
  assert.equal(workspace.activeTabId, null);
});

test('normalizeWorkspace rejects future schemas and clamps recoverable pane data', () => {
  assert.equal(WS.normalizeWorkspace({ schemaVersion: 2, workspaceId: 'x' }), null);
  const normalized = WS.normalizeWorkspace({
    schemaVersion: 1,
    workspaceId: 'x', createdAt: 1, updatedAt: 1, lastSeenAt: 1,
    closedAt: null, activeTabId: null,
    layout: { cols: 1, rows: 1, colSizes: [1], rowSizes: [1] },
    activePaneId: 'pane-1',
    ui: { floatingTriggerPosition: { x: 1, y: 2 }, floatingPanelOpen: false, enhancedOptInHostname: '', compatibilityEnabled: false },
    panes: [{ paneId: 'pane-1', controlPosition: { x: 8, y: 8 }, historyIndex: 99, history: [{ url: 'https://example.com' }] }],
  });
  assert.equal(normalized.panes[0].historyIndex, 0);
});
```

- [ ] **Step 2: Run the new tests and confirm RED**

Run:

```bash
node --test tests/workspace-store.test.js
```

Expected: FAIL because `src/workspace/workspace-store.js` does not exist.

- [ ] **Step 3: Implement the model shell and validation**

Implement an IIFE/CommonJS-compatible module following the repository pattern:

```js
(function initWorkspaceStore(global) {
  'use strict';

  const SCHEMA_VERSION = 1;
  const MAX_HISTORY_ENTRIES = 50;
  const MAX_CLOSED_WORKSPACES = 20;
  const SOFT_BUDGET_BYTES = 6 * 1024 * 1024;
  const INDEX_KEY = 'mpv:workspace-index';

  function workspaceKey(workspaceId) {
    return `mpv:workspace:${workspaceId}`;
  }

  function createWorkspaceFromUrls(urls, options = {}) {
    const now = Number(options.now ?? Date.now());
    const workspaceId = String(options.workspaceId || crypto.randomUUID());
    const makePaneId = options.makePaneId || (() => crypto.randomUUID());
    const panes = urls.slice(0, 9).map((url) => ({
      paneId: makePaneId(),
      controlPosition: { x: 8, y: 8 },
      historyIndex: 0,
      history: [{ url: String(url) }],
    }));
    return {
      schemaVersion: SCHEMA_VERSION,
      workspaceId,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      closedAt: null,
      activeTabId: null,
      layout: { cols: 1, rows: 1, colSizes: [1], rowSizes: [1] },
      activePaneId: panes[0]?.paneId || null,
      ui: {
        floatingTriggerPosition: { x: 0, y: 0 },
        floatingPanelOpen: false,
        enhancedOptInHostname: '',
        compatibilityEnabled: false,
      },
      panes,
    };
  }
```

Implement strict URL/history/pane normalization so malformed fields are dropped or clamped, future schema versions return `null`, and a workspace with no valid panes returns `null`.

- [ ] **Step 4: Write failing tests for navigation semantics**

Append tests for duplicate suppression, Back/Forward preparation/confirmation, forward-branch truncation, and the 50-entry cap:

```js
test('recordNavigation truncates forward history and suppresses consecutive duplicates', () => {
  let workspace = WS.createWorkspaceFromUrls(['https://example.com/a'], { workspaceId: 'w', now: 1, makePaneId: () => 'p' });
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/b').workspace;
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/c').workspace;
  const back = WS.prepareTraversal(workspace, 'p', 'back');
  workspace = WS.confirmTraversal(workspace, 'p', back.index, back.url).workspace;
  workspace = WS.recordNavigation(workspace, 'p', 'https://example.com/d').workspace;
  assert.deepEqual(workspace.panes[0].history.map((entry) => entry.url), [
    'https://example.com/a', 'https://example.com/b', 'https://example.com/d',
  ]);
  const duplicate = WS.recordNavigation(workspace, 'p', 'https://example.com/d');
  assert.equal(duplicate.changed, false);
});

test('history keeps only the newest 50 entries', () => {
  let workspace = WS.createWorkspaceFromUrls(['https://example.com/0'], { workspaceId: 'w', now: 1, makePaneId: () => 'p' });
  for (let index = 1; index <= 60; index += 1) {
    workspace = WS.recordNavigation(workspace, 'p', `https://example.com/${index}`).workspace;
  }
  const pane = workspace.panes[0];
  assert.equal(pane.history.length, 50);
  assert.equal(pane.history[0].url, 'https://example.com/11');
  assert.equal(pane.historyIndex, 49);
});
```

- [ ] **Step 5: Run the focused tests and confirm RED for missing history behavior**

Run:

```bash
node --test tests/workspace-store.test.js
```

Expected: FAIL on `recordNavigation`/`prepareTraversal`/`confirmTraversal` until implemented.

- [ ] **Step 6: Implement history mutation helpers**

Implement immutable-enough workspace updates by cloning only the mutated workspace/pane arrays. `recordNavigation` must normalize URL strings, truncate entries after `historyIndex`, append once, and trim from the oldest side when over 50. `prepareTraversal` returns the target without mutating. `confirmTraversal` changes the index only when both expected index and URL still match retained history.

Core shape:

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

- [ ] **Step 7: Run focused tests and then all existing tests**

Run:

```bash
node --test tests/workspace-store.test.js
node --test tests/*.test.js
```

Expected: all tests PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/workspace/workspace-store.js tests/workspace-store.test.js
git commit -m "feat: add bounded workspace history model"
```

---

### Task 2: Add durable workspace storage and retention cleanup

**Files:**
- Modify: `src/workspace/workspace-store.js`
- Modify: `tests/workspace-store.test.js`

**Interfaces:**
- Extends `MPVWorkspaceStore` with `WorkspaceStore` class constructed as:
  - `new WorkspaceStore({ localArea, now = Date.now, makeWorkspaceId = crypto.randomUUID, getBytesInUse })`
- Produces methods used later:
  - `create(urls, options = {}) -> Promise<workspace>`
  - `load(workspaceId) -> Promise<workspace | null>`
  - `save(workspace) -> Promise<workspace>`
  - `clone(workspaceId) -> Promise<workspace | null>`
  - `markActive(workspaceId, tabId) -> Promise<workspace | null>`
  - `markClosed(workspaceId) -> Promise<workspace | null>`
  - `listIndex() -> Promise<indexEntry[]>`
  - `cleanup() -> Promise<void>`
- All workspace/index writes occur through these methods.

- [ ] **Step 1: Add an in-memory Chrome-storage fake and failing persistence tests**

In `tests/workspace-store.test.js`, add:

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

test('WorkspaceStore create/load/markClosed reuses one workspace record', async () => {
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({ localArea, now: () => 1000, makeWorkspaceId: () => 'w1' });
  const created = await store.create(['https://example.com/a', 'https://example.com/b']);
  await store.markActive(created.workspaceId, 42);
  const closed = await store.markClosed(created.workspaceId);
  assert.equal(closed.activeTabId, null);
  assert.equal(closed.closedAt, 1000);
  assert.equal((await store.listIndex()).length, 1);
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
node --test tests/workspace-store.test.js
```

Expected: FAIL because `WorkspaceStore` is not implemented.

- [ ] **Step 3: Implement `WorkspaceStore` create/load/save/index operations**

Use one workspace key plus `INDEX_KEY`. `save()` always normalizes before writing and updates the matching compact index entry:

```js
async save(workspace) {
  const normalized = normalizeWorkspace(workspace);
  if (!normalized) throw new Error('Invalid workspace');
  await this.localArea.set({ [workspaceKey(normalized.workspaceId)]: normalized });
  await this.updateIndexEntry(normalized);
  return normalized;
}
```

`markActive()` must clear `closedAt`, set `activeTabId`, and update `lastSeenAt`/`updatedAt`. `markClosed()` sets `activeTabId = null` and `closedAt = now()`.

- [ ] **Step 4: Write failing cleanup tests for 20 closed workspaces and active protection**

Add deterministic records and assert cleanup removes oldest closed records but never active records:

```js
test('cleanup keeps only 20 newest closed workspaces and never removes active records', async () => {
  let clock = 0;
  const localArea = makeStorage();
  const store = new WS.WorkspaceStore({ localArea, now: () => ++clock, makeWorkspaceId: () => `w-${clock}` });
  for (let index = 0; index < 23; index += 1) {
    const item = await store.create([`https://example.com/${index}`], { workspaceId: `closed-${index}` });
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

- [ ] **Step 5: Add a failing byte-budget ordering test**

Inject `getBytesInUse` through the constructor so the test can force over-budget state without allocating megabytes. Assert oldest closed records are deleted before any history trim, and active workspace current URLs survive trim.

- [ ] **Step 6: Implement cleanup ordering exactly as the spec**

`cleanup()` must:

1. normalize/index entries;
2. delete closed entries beyond the newest 20;
3. call the injected/default `getBytesInUse(workspaceKeys)`;
4. while over `SOFT_BUDGET_BYTES`, delete oldest remaining closed workspaces;
5. if still over budget, trim oldest non-current history entries from active workspace panes while always retaining `history[historyIndex]` and at least one entry per pane;
6. never delete an active workspace.

Use only workspace keys plus `INDEX_KEY` in byte accounting.

- [ ] **Step 7: Run focused/full tests**

```bash
node --test tests/workspace-store.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/workspace/workspace-store.js tests/workspace-store.test.js
git commit -m "feat: persist and prune workspace snapshots"
```

---

### Task 3: Change popup launch to workspace-first URLs

**Files:**
- Modify: `popup.html`
- Modify: `popup.js`
- Modify: `tests/popup-static.test.js`
- Modify: `tests/popup-enhanced-static.test.js`
- Create: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Consumes `MPVWorkspaceStore.WorkspaceStore`.
- Popup launch result becomes `grid.html?workspace=<workspaceId>`.
- Enhanced permission request remains in the Launch user gesture and initial workspace stores `ui.enhancedOptInHostname` only when permission was granted and exact-host eligibility holds.

- [ ] **Step 1: Write failing static tests for workspace-first launch**

Create `tests/workspace-restore-static.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const popupHtml = fs.readFileSync('popup.html', 'utf8');
const popupJs = fs.readFileSync('popup.js', 'utf8');

test('popup loads workspace store before popup script', () => {
  assert.match(popupHtml, /src\/workspace\/workspace-store\.js[\s\S]*popup\.js/);
});

test('popup persists workspace and opens only an opaque workspace URL', () => {
  assert.match(popupJs, /new MPVWorkspaceStore\.WorkspaceStore/);
  assert.match(popupJs, /grid\.html\?workspace=/);
  assert.doesNotMatch(popupJs, /grid\.html\?[^'"`]*https?:/);
});
```

Update `tests/popup-enhanced-static.test.js` to require `ui.enhancedOptInHostname` persistence instead of transient `launchEnhancedHostname` as the durable path.

- [ ] **Step 2: Run popup/static tests and confirm RED**

```bash
node --test tests/workspace-restore-static.test.js tests/popup-static.test.js tests/popup-enhanced-static.test.js
```

Expected: FAIL because popup does not load/create a workspace yet.

- [ ] **Step 3: Load workspace-store in `popup.html`**

Place scripts in this order near the existing scripts:

```html
<script src="common.js"></script>
<script src="src/workspace/workspace-store.js"></script>
<script src="popup.js"></script>
```

- [ ] **Step 4: Replace transient launch as the primary path**

At module scope:

```js
const workspaceStore = new MPVWorkspaceStore.WorkspaceStore({
  localArea: chrome.storage.local,
  getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
});
```

In `launchUrls()` after optional enhanced permission:

```js
const workspace = await workspaceStore.create(cleanUrls, {
  ui: { enhancedOptInHostname: launchEnhancedHostname },
});
const gridUrl = new URL(chrome.runtime.getURL('grid.html'));
gridUrl.searchParams.set('workspace', workspace.workspaceId);
await chrome.tabs.create({ url: gridUrl.toString() });
```

Extend `WorkspaceStore.create()` in Task 2 if needed so `options.ui` safely overlays only allowed initial UI fields.

Keep `paneCount`/`paneUrls` local form persistence unchanged. Do not put URLs in the outer grid URL. Remove `launchUrls`/`launchEnhancedHostname` session writes from the normal new-launch path; retain read-side migration fallback in `grid.js` until Task 6.

- [ ] **Step 5: Run popup/static and full tests**

```bash
node --test tests/workspace-restore-static.test.js tests/popup-static.test.js tests/popup-enhanced-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add popup.html popup.js tests/popup-static.test.js tests/popup-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: launch grids with stable workspace ids"
```

---

### Task 4: Add extension-owned pane bootstrap and universal frame registry

**Files:**
- Create: `pane-bootstrap.html`
- Create: `pane-bootstrap.js`
- Create: `src/background/workspace-frame-registry.js`
- Create: `tests/workspace-frame-registry.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Produces `MPVWorkspaceFrameRegistry.WorkspaceFrameRegistry`.
- Registry methods:
  - `registerWorkspace({ tabId, workspaceId, paneIds }) -> boolean`
  - `bindBootstrap({ tabId, frameId, documentId, workspaceId, paneId }) -> record | null`
  - `updateDocument({ tabId, frameId, documentId, url }) -> record | null`
  - `findPaneByFrame(tabId, frameId) -> record | null`
  - `getPane(tabId, paneId) -> record | null`
  - `replacePaneIds(tabId, workspaceId, paneIds) -> boolean`
  - `removeFrame(tabId, frameId) -> void`
  - `removeWorkspace(tabId) -> void`
  - `serialize() -> object`
  - `restore(snapshot) -> void`
- Bootstrap message shape from child to grid:
  - `{ type: 'mpv:pane-bootstrap-ready', workspaceId, paneId }`
- Grid-to-bootstrap target message:
  - `{ type: 'mpv:pane-bootstrap-target', workspaceId, paneId, targetUrl }`

- [ ] **Step 1: Write failing frame-registry tests**

Create tests proving only registered panes/direct bootstrap bindings are accepted and stable frame IDs survive document replacement:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceFrameRegistry } = require('../src/background/workspace-frame-registry.js');

test('bootstrap binds one stable pane to a direct child frame', () => {
  const registry = new WorkspaceFrameRegistry();
  assert.equal(registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] }), true);
  const bound = registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'doc-1', workspaceId: 'w', paneId: 'p' });
  assert.equal(bound.paneId, 'p');
  const navigated = registry.updateDocument({ tabId: 7, frameId: 3, documentId: 'doc-2', url: 'https://example.com/a' });
  assert.equal(navigated.documentId, 'doc-2');
  assert.equal(registry.findPaneByFrame(7, 3).paneId, 'p');
});

test('bootstrap rejects pane ids outside the registered workspace', () => {
  const registry = new WorkspaceFrameRegistry();
  registry.registerWorkspace({ tabId: 7, workspaceId: 'w', paneIds: ['p'] });
  assert.equal(registry.bindBootstrap({ tabId: 7, frameId: 3, documentId: 'doc', workspaceId: 'w', paneId: 'other' }), null);
});
```

- [ ] **Step 2: Run and confirm RED**

```bash
node --test tests/workspace-frame-registry.test.js
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement registry with serialization**

Follow the IIFE/CommonJS pattern used by `frame-registry.js`. Records must contain `{ tabId, workspaceId, paneId, frameId, documentId, url }`. Reject conflicting live frame claims and pane IDs not in the registered workspace. `serialize()` must return plain JSON-safe arrays/objects; `restore()` must validate integer tab/frame IDs and non-empty IDs.

- [ ] **Step 4: Write failing bootstrap static tests**

Append:

```js
const bootstrapHtml = fs.readFileSync('pane-bootstrap.html', 'utf8');
const bootstrapJs = fs.readFileSync('pane-bootstrap.js', 'utf8');

test('pane bootstrap contains no target URL query contract and replaces location after target message', () => {
  assert.match(bootstrapHtml, /pane-bootstrap\.js/);
  assert.match(bootstrapJs, /mpv:pane-bootstrap-ready/);
  assert.match(bootstrapJs, /mpv:pane-bootstrap-target/);
  assert.match(bootstrapJs, /location\.replace\(targetUrl\)/);
  assert.doesNotMatch(bootstrapJs, /searchParams\.get\(['"]target/);
});
```

- [ ] **Step 5: Implement `pane-bootstrap.html` and `pane-bootstrap.js`**

`pane-bootstrap.html` is minimal and loads only `pane-bootstrap.js`.

`pane-bootstrap.js`:

```js
'use strict';

const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspace') || '';
const paneId = params.get('pane') || '';

parent.postMessage({ type: 'mpv:pane-bootstrap-ready', workspaceId, paneId }, location.origin);

window.addEventListener('message', (event) => {
  if (event.source !== parent || event.origin !== location.origin) return;
  const message = event.data;
  if (message?.type !== 'mpv:pane-bootstrap-target') return;
  if (message.workspaceId !== workspaceId || message.paneId !== paneId) return;
  const targetUrl = String(message.targetUrl || '');
  if (!/^https?:\/\//i.test(targetUrl)) return;
  location.replace(targetUrl);
}, { once: true });
```

- [ ] **Step 6: Run focused/full tests**

```bash
node --test tests/workspace-frame-registry.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add pane-bootstrap.html pane-bootstrap.js src/background/workspace-frame-registry.js tests/workspace-frame-registry.test.js tests/workspace-restore-static.test.js
git commit -m "feat: add universal pane frame bootstrap"
```

---

### Task 5: Add workspace registration and single-writer mutation coordination to the service worker

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Service worker imports `../workspace/workspace-store.js` and `workspace-frame-registry.js` in addition to existing enhanced modules.
- Grid Port request/response additions:
  - request `mpv:workspace-register` `{ workspaceId }`
  - response via existing `mpv:request-result` with `{ ok, workspaceId, workspace, cloned }`
  - request `mpv:workspace-ui-patch` `{ patch }`
  - request `mpv:workspace-pane-add` `{ paneId, url }`
  - request `mpv:workspace-pane-remove` `{ paneId }`
  - request `mpv:workspace-pane-ids` `{ paneIds }` for frame-registry synchronization if needed after restore
- Background push message:
  - `mpv:workspace-state` `{ workspace }`
- Service worker owns `workspaceQueues: Map<workspaceId, Promise>` and helper `queueWorkspaceMutation(workspaceId, mutation)`.

- [ ] **Step 1: Write failing static tests for imports, trusted queried grid URLs, and mutation queue**

Add assertions:

```js
assert.match(worker, /\.\.\/workspace\/workspace-store\.js/);
assert.match(worker, /workspace-frame-registry\.js/);
assert.match(worker, /mpv:workspace-register/);
assert.match(worker, /mpv:workspace-ui-patch/);
assert.match(worker, /queueWorkspaceMutation/);
assert.match(worker, /new URL\(port\.sender\.url\)/);
```

Also explicitly assert the worker no longer requires `port.sender.url === GRID_URL`, because restored grid URLs contain a query string.

- [ ] **Step 2: Run background tests and confirm RED**

```bash
node --test tests/background-static.test.js tests/workspace-restore-static.test.js
```

Expected: FAIL on missing workspace coordination.

- [ ] **Step 3: Import and instantiate workspace infrastructure**

At the top of `service-worker.js`:

```js
importScripts('../workspace/workspace-store.js', 'workspace-frame-registry.js', 'frame-registry.js', 'popup-router.js');

const workspaceStore = new MPVWorkspaceStore.WorkspaceStore({
  localArea: chrome.storage.local,
  getBytesInUse: (keys) => chrome.storage.local.getBytesInUse(keys),
});
const workspaceFrames = new MPVWorkspaceFrameRegistry.WorkspaceFrameRegistry();
const workspaceQueues = new Map();
```

Add `isGridUrl(value)` that parses the URL and compares `origin + pathname` to `chrome.runtime.getURL('grid.html')`, ignoring query parameters.

- [ ] **Step 4: Implement serialized mutation helper**

Use a per-workspace promise chain that survives a rejected prior mutation:

```js
function queueWorkspaceMutation(workspaceId, mutation) {
  const previous = workspaceQueues.get(workspaceId) || Promise.resolve();
  const next = previous.catch(() => {}).then(mutation);
  workspaceQueues.set(workspaceId, next.finally(() => {
    if (workspaceQueues.get(workspaceId) === next) workspaceQueues.delete(workspaceId);
  }));
  return next;
}
```

If exact identity comparison with `finally()` makes cleanup incorrect, store the chained promise in a local `tracked` variable and compare against that variable. Add a unit/static assertion so queue cleanup cannot remove a newer queued mutation.

- [ ] **Step 5: Implement `mpv:workspace-register` including duplicate-live clone behavior**

Within the trusted grid Port handler:

1. load requested workspace;
2. if missing, return `{ ok:false, missing:true }`;
3. if `activeTabId` is an existing different live tab, clone through `workspaceStore.clone()`;
4. mark effective workspace active for the sender tab;
5. register its pane IDs in `workspaceFrames`;
6. return `{ ok:true, workspaceId: effectiveId, workspace, cloned }`.

Use `chrome.tabs.get(activeTabId)` to distinguish stale `activeTabId` from a genuinely live owner. If stale, reuse the same workspace rather than clone.

- [ ] **Step 6: Implement workspace UI/add/remove mutations**

Each Port message must verify the tab owns the workspace before mutation. The service worker loads the latest record inside `queueWorkspaceMutation()`, applies only whitelisted fields, saves, and pushes `mpv:workspace-state` to the owning grid.

For pane add:

```js
{
  paneId: String(message.paneId),
  controlPosition: { x: 8, y: 8 },
  historyIndex: 0,
  history: [{ url: String(message.url) }],
}
```

Reject duplicate pane IDs and counts above 9. Pane removal must leave at least one pane and update `activePaneId` if necessary.

- [ ] **Step 7: Run focused/full tests**

```bash
node --test tests/background-static.test.js tests/workspace-restore-static.test.js tests/workspace-store.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/background/service-worker.js tests/background-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: coordinate durable workspace state"
```

---

### Task 6: Restore grid panes/layout/UI from the durable workspace snapshot

**Files:**
- Modify: `grid.js`
- Modify: `tests/grid-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Grid startup reads `workspace` from `location.search`.
- `createPane(url, options = {})` accepts:
  - `options.paneId`
  - `options.controlPosition`
  - `options.history`
  - `options.historyIndex`
- Grid functions introduced:
  - `workspaceIdFromLocation() -> string`
  - `registerWorkspace() -> Promise<workspace>`
  - `restoreWorkspace(snapshot) -> void`
  - `bootstrapUrlForPane(paneId) -> string`
  - `sendWorkspaceUiPatch(patch) -> Promise<boolean>`
  - `navigatePaneTo(pane, url, { bootstrap = false } = {}) -> void`

- [ ] **Step 1: Write failing grid static tests**

Assert:

```js
assert.match(gridJs, /new URLSearchParams\(location\.search\)/);
assert.match(gridJs, /mpv:workspace-register/);
assert.match(gridJs, /workspaceIdFromLocation/);
assert.match(gridJs, /pane-bootstrap\.html/);
assert.match(gridJs, /options\.paneId/);
assert.match(gridJs, /restoreWorkspace/);
assert.match(gridJs, /colSizes/);
assert.match(gridJs, /rowSizes/);
```

- [ ] **Step 2: Run grid tests and confirm RED**

```bash
node --test tests/grid-static.test.js tests/workspace-restore-static.test.js
```

Expected: FAIL.

- [ ] **Step 3: Make `createPane` restore stable pane IDs and bootstrap first**

Change:

```js
function createPane(url, options = {}) {
  const paneId = options.paneId || crypto.randomUUID();
  // ...
  iframe.name = `focus-pane:${paneId}`;
  iframe.src = bootstrapUrlForPane(paneId);
```

Keep the desired target URL on the pane object, not in bootstrap query parameters:

```js
const pane = {
  // existing fields
  history: Array.isArray(options.history) ? options.history.map((entry) => ({ ...entry })) : [{ url }],
  historyIndex: Number.isInteger(options.historyIndex) ? options.historyIndex : 0,
  pendingTargetUrl: url,
};
```

Add a `window.message` listener that verifies `event.source === pane.iframe.contentWindow`, workspace ID, pane ID, and extension origin before replying with `mpv:pane-bootstrap-target` and the current target URL.

- [ ] **Step 4: Register workspace before constructing panes**

Startup sequence must become:

```text
connect grid Port
  -> wait for background-ready
  -> mpv:workspace-register(workspaceId)
  -> receive normalized snapshot/effective workspaceId
  -> if cloned, history.replaceState() outer URL to effective workspace UUID
  -> restore panes/layout/UI
  -> initialize Enhanced/Compatibility state
```

Do not build default panes before registration completes.

If requested workspace is missing/invalid, call a service-worker request that creates or returns a safe workspace instead of rendering a broken grid. Keep the legacy transient `launchUrls` read only as migration fallback for extension tabs opened without `?workspace=` during rollout.

- [ ] **Step 5: Restore layout without resetting persisted split sizes**

Refactor `layoutPanes()` to accept an option such as `{ preserveTrackSizes: true }`. During restore, compute dimensions from pane count, validate persisted arrays have the expected lengths and positive finite values, assign them, then call `applyGridTemplate()` without replacing them with all-ones arrays.

Persist resize completion via:

```js
sendWorkspaceUiPatch({
  layout: { cols, rows, colSizes: [...colSizes], rowSizes: [...rowSizes] },
});
```

Do not write on resize pointer moves.

- [ ] **Step 6: Persist completed pane-control/floating-panel state**

After pane-control drag ends, send pane-control position through a dedicated workspace UI/pane-state patch. After floating trigger drag and panel open/close, send the whitelisted UI patch. Existing `floatingTriggerPosition` local setting may remain for non-workspace fallback, but workspace state wins on restore.

- [ ] **Step 7: Handle `mpv:workspace-state` pushes**

When background sends an updated snapshot, update pane retained-history metadata and button enabled state without reconstructing every iframe. Only structural pane differences require add/remove DOM reconciliation.

- [ ] **Step 8: Run focused/full tests**

```bash
node --test tests/grid-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit Task 6**

```bash
git add grid.js tests/grid-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: restore grid workspace snapshots"
```

---

### Task 7: Record universal pane navigation and implement retained Back/Forward

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `grid.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/grid-static.test.js`
- Modify: `tests/grid-enhanced-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Background requests:
  - `mpv:history-traverse` `{ paneId, direction: 'back' | 'forward' }`
  - response `{ ok, paneId, index, url }`
- Background maintains `pendingTraversals` keyed by `${tabId}:${paneId}` with `{ index, url, expiresAt }`.
- Grid Back/Forward buttons use retained workspace history in every mode; they no longer depend on Enhanced Mode bridge commands.

- [ ] **Step 1: Write failing static assertions for all three navigation event types and universal history controls**

Assert the worker listens to:

```js
assert.match(worker, /webNavigation\.onCommitted/);
assert.match(worker, /webNavigation\.onHistoryStateUpdated/);
assert.match(worker, /webNavigation\.onReferenceFragmentUpdated/);
assert.match(worker, /mpv:history-traverse/);
```

Assert `grid.js` Back/Forward controls are not created with the `enhanced-only` class and invoke `mpv:history-traverse`.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
node --test tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
```

Expected: FAIL on universal history wiring.

- [ ] **Step 3: Bind bootstrap commits to universal pane frames**

In `webNavigation.onCommitted` handle direct child frames first:

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
  if (record) persistLiveBindings();
  return;
}
```

Never bind nested frames. After a bound frame commits an HTTP/S URL, call `workspaceFrames.updateDocument(...)` and queue a workspace history mutation.

- [ ] **Step 4: Record normal/SPA/fragment navigation through `recordNavigation`**

For each bound pane navigation:

1. ignore extension bootstrap URLs;
2. normalize to HTTP/S URL;
3. check a pending traversal intent first;
4. if expected URL/index match, call `confirmTraversal`;
5. otherwise clear stale intent and call `recordNavigation`;
6. save through the per-workspace mutation queue;
7. push `mpv:workspace-state` to the grid.

`onHistoryStateUpdated` and `onReferenceFragmentUpdated` use the same recorder. Consecutive duplicate/reload URLs produce no history change because Task 1's pure helper returns `changed:false`.

- [ ] **Step 5: Implement traversal request/timeout**

On `mpv:history-traverse`, load the current workspace, call `prepareTraversal`, store a 5-second pending intent, and return target index/URL without mutating the durable index yet:

```js
pendingTraversals.set(`${tabId}:${paneId}`, {
  index: target.index,
  url: target.url,
  expiresAt: Date.now() + 5000,
});
postResult(port, message.requestId, true, { paneId, index: target.index, url: target.url });
```

Expired intents are ignored/removed on the next event/request. Unexpected committed navigation clears the intent and records a normal branch-changing navigation.

- [ ] **Step 6: Make Back/Forward controls universal in `grid.js`**

Create them as ordinary pane actions. Enable Back when `historyIndex > 0`; enable Forward when `historyIndex < history.length - 1`.

Click flow:

```js
const response = await portRequest('mpv:history-traverse', { paneId: pane.id, direction: 'back' });
if (response?.ok && response.url) navigatePaneTo(pane, response.url);
```

Do not call the Enhanced Mode bridge's native `history.back()`/`history.forward()` for these buttons, because retained history must work after iframe destruction and in mixed-host/basic mode.

- [ ] **Step 7: Preserve Enhanced Mode behavior alongside universal history**

Keep same-host bridge registration, title/focus updates, same-host popup routing, and native-tab escape. Refactor the existing `mpv:pane-command` back/forward path out if no remaining caller exists; otherwise leave only commands still used by Enhanced Mode. Existing enhanced session activation must not gate universal frame binding/history recording.

- [ ] **Step 8: Run focused/full tests**

```bash
node --test tests/workspace-store.test.js tests/workspace-frame-registry.test.js tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 9: Commit Task 7**

```bash
git add src/background/service-worker.js grid.js tests/background-static.test.js tests/grid-static.test.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: retain pane navigation history"
```

---

### Task 8: Persist close/restore lifecycle, worker restart bindings, and retention cleanup

**Files:**
- Modify: `src/background/service-worker.js`
- Modify: `src/background/workspace-frame-registry.js`
- Modify: `tests/workspace-frame-registry.test.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Session key: `mpv:workspace-live-bindings`.
- Helpers:
  - `persistLiveBindings() -> Promise<void>`
  - `restoreLiveBindings() -> Promise<void>`
  - `reconcileOpenWorkspaces() -> Promise<void>`
  - `markWorkspaceClosedForTab(tabId) -> Promise<void>`
- `tabs.onRemoved` marks only known grid workspaces closed; Port disconnect alone does not mark a workspace closed.

- [ ] **Step 1: Write failing tests/static assertions for close/restart behavior**

Add static checks for:

```js
assert.match(worker, /mpv:workspace-live-bindings/);
assert.match(worker, /tabs\.onRemoved/);
assert.match(worker, /markWorkspaceClosedForTab/);
assert.match(worker, /reconcileOpenWorkspaces/);
assert.match(worker, /webNavigation\.getAllFrames/);
```

Add registry unit tests that `serialize()` -> new registry `restore()` retains only valid records and can discard stale tab/frame bindings.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
node --test tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
```

Expected: FAIL.

- [ ] **Step 3: Persist live frame bindings to `chrome.storage.session`**

After workspace registration, bootstrap binding, document update, frame removal, and tab removal, coalesce writes of:

```js
await chrome.storage.session.set({
  'mpv:workspace-live-bindings': workspaceFrames.serialize(),
});
```

This is recovery metadata only; durable browsing history remains in local workspace snapshots.

- [ ] **Step 4: Restore/validate bindings on worker startup**

At worker initialization:

1. load serialized bindings;
2. restore registry structure;
3. for each stored tab ID, call `chrome.webNavigation.getAllFrames({ tabId })`;
4. keep only records whose frame ID still exists;
5. discard records for missing tabs/frames;
6. persist the cleaned snapshot.

When a connected grid owns a pane whose frame binding is unresolved, push `{ type:'mpv:pane-rebind', paneId }`; grid responds by reloading that pane through its bootstrap at the pane's current retained URL.

- [ ] **Step 5: Mark workspace closed only on actual tab removal**

Maintain `tabToWorkspace`. In `tabs.onRemoved`, before deleting mappings:

```js
const workspaceId = tabToWorkspace.get(tabId);
if (workspaceId) {
  await queueWorkspaceMutation(workspaceId, async () => {
    await workspaceStore.markClosed(workspaceId);
    await workspaceStore.cleanup();
  });
}
```

Do not call `markClosed` from Port `onDisconnect`, because service-worker suspension/restart can disconnect Ports while the tab remains open.

- [ ] **Step 6: Reconcile stale active records after startup**

Query open tabs, filter URLs with `isGridUrl`, parse their workspace IDs, and compare to the workspace index. Any workspace indexed as active but not represented by an open grid tab is marked closed using the reconciliation time. Run cleanup after reconciliation.

When an open grid tab registers later, `markActive` clears `closedAt` again. This preserves Ctrl+Shift+T reuse of the same record.

- [ ] **Step 7: Run focused/full tests**

```bash
node --test tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit Task 8**

```bash
git add src/background/service-worker.js src/background/workspace-frame-registry.js tests/workspace-frame-registry.test.js tests/background-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: recover closed workspace lifecycle"
```

---

### Task 9: Restore Compatibility/Enhanced state and finish UI-state durability

**Files:**
- Modify: `grid.js`
- Modify: `src/background/service-worker.js`
- Modify: `tests/grid-enhanced-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`

**Interfaces:**
- Workspace snapshot `ui.compatibilityEnabled` is authoritative intent for that workspace.
- Workspace snapshot `ui.enhancedOptInHostname` replaces sessionStorage as durable restore source, though sessionStorage may remain only as migration fallback.
- Compatibility restore recreates the DNR rule for the new `currentTabId` only if `chrome.permissions.contains(COMPAT_ORIGINS)` is true.
- Enhanced restore calls existing exact-host permission/eligibility logic without prompting.

- [ ] **Step 1: Write failing tests for compatibility/enhanced restore**

Assert `grid.js` reads `workspace.ui.compatibilityEnabled` and `workspace.ui.enhancedOptInHostname`, calls `permissions.contains` during restore, and does not call `permissions.request` from automatic restore paths.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
node --test tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
```

Expected: FAIL.

- [ ] **Step 3: Restore Compatibility intent safely**

After `chrome.tabs.getCurrent()` resolves the new tab ID, if snapshot intent is On:

```js
const alreadyGranted = await chrome.permissions.contains(COMPAT_ORIGINS);
if (alreadyGranted) await enableCompatRules();
else setCompatibilityUi(false);
```

When user toggles compatibility, send `{ ui: { compatibilityEnabled: compatEnabled } }` to background after the action succeeds. Never automatically prompt on restore.

- [ ] **Step 4: Restore Enhanced opt-in safely**

Initialize `enhancedOptInHostname` from snapshot. Existing `syncEnhancedSession()` already checks exact-host eligibility and `chrome.permissions.contains()`; reuse it after panes are restored. Do not request permission during restore. When explicit user enable succeeds, persist the new opt-in hostname through the workspace UI patch.

- [ ] **Step 5: Restore active pane/floating panel state**

On snapshot restore, apply active pane class, trigger position, and floating panel open/closed state after DOM measurement. Persist subsequent changes only when completed.

- [ ] **Step 6: Run focused/full tests**

```bash
node --test tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit Task 9**

```bash
git add grid.js src/background/service-worker.js tests/grid-enhanced-static.test.js tests/workspace-restore-static.test.js
git commit -m "feat: restore workspace mode and ui state"
```

---

### Task 10: Harden packaging, documentation, and end-to-end static coverage

**Files:**
- Modify: `tests/manifest-static.test.js`
- Modify: `tests/workspace-restore-static.test.js`
- Modify: `README.md`
- Verify: `manifest.json`
- Verify: all extension JavaScript files

**Interfaces:**
- No new runtime interface; this task locks acceptance requirements and regression coverage.

- [ ] **Step 1: Add failing manifest/privacy/static acceptance tests**

Extend `tests/manifest-static.test.js`:

```js
test('workspace restore adds no sessions or unlimitedStorage permissions', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.permissions.includes('sessions'), false);
  assert.equal(manifest.permissions.includes('unlimitedStorage'), false);
});
```

Extend `tests/workspace-restore-static.test.js` to assert:

- `MAX_HISTORY_ENTRIES` is 50;
- `MAX_CLOSED_WORKSPACES` is 20;
- `SOFT_BUDGET_BYTES` is `6 * 1024 * 1024`;
- outer grid query construction adds only `workspace`;
- bootstrap query construction adds only `workspace` and `pane`;
- no target URL appears in bootstrap URL construction;
- `tabs.onRemoved` owns close marking;
- Port disconnect does not call `markClosed`;
- basic-mode navigation recording is independent of Enhanced Mode permission checks.

- [ ] **Step 2: Run static tests and confirm failures if any acceptance wiring is still missing**

```bash
node --test tests/manifest-static.test.js tests/workspace-restore-static.test.js
```

Expected before final hardening: any missing acceptance assertion FAILS and is fixed in the next step.

- [ ] **Step 3: Apply only the minimal hardening required by failing acceptance tests**

Do not introduce new permissions or unrelated refactors. If manifest changes are unnecessary, leave `manifest.json` unchanged.

- [ ] **Step 4: Update README with the exact restoration boundary**

Document that Ctrl+Shift+T restores:

- panes/current URLs;
- retained Back/Forward URL history;
- pane order/layout/control positions;
- supported Focus UI/mode intent.

Document limits: 50 history entries/pane, 20 closed workspaces, 6 MiB soft workspace budget. State that arbitrary cross-origin page memory/form/DOM state is not serialized.

- [ ] **Step 5: Run the complete automated verification suite**

Run:

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

Expected: all tests PASS, all syntax checks exit 0, and `manifest ok` prints.

- [ ] **Step 6: Perform the manual Chrome acceptance checklist when a browser environment is available**

Use the 15-item checklist in `docs/superpowers/specs/2026-09-17-restore-closed-workspace-design.md`. At minimum exercise: close + Ctrl+Shift+T with 2 panes, retained Back/Forward, 9 panes, >50 navigations, Back-then-new-navigation branch truncation, reload suppression, SPA/fragment URLs, mixed-host/basic mode, Enhanced permission present/removed, Compatibility rebind, worker restart, multiple workspaces, duplicate live URL cloning, and >20 closed workspace cleanup.

If manual Chrome is unavailable in the execution environment, report that limitation explicitly; do not claim browser acceptance passed.

- [ ] **Step 7: Commit Task 10**

```bash
git add README.md tests/manifest-static.test.js tests/workspace-restore-static.test.js manifest.json
git commit -m "test: harden workspace restore coverage"
```

---

## Final Verification Gate

Before opening a PR or claiming completion:

- [ ] Run `node --test tests/*.test.js` fresh and report exact pass/fail counts.
- [ ] Run every `node --check` command from Task 10 fresh.
- [ ] Parse `manifest.json` fresh.
- [ ] Compare the feature branch against `main` and confirm only intended files changed.
- [ ] Re-read the design spec acceptance criteria and map each criterion to passing tests or an explicitly unperformed manual-browser item.
- [ ] Confirm no `sessions` or `unlimitedStorage` permission was added.
- [ ] Confirm the branch remains isolated from unrelated repositories/extensions.
