# Same-host Native-like Panes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in enhanced runtime that makes 2–9 exact-same-host iframe panes behave like independent logical browser tabs while preserving the existing grid and graceful basic-mode fallback.

**Architecture:** Keep the current iframe grid and xAI-styled draggable controls. Add exact-host analysis in shared helpers, a Manifest V3 service worker with a frame/document registry, a small injected pane bridge, and grid/session messaging. Chrome sender/event metadata remains authoritative; same-host popup targets are handed back to the grid only after acknowledgement, while mixed-host or unsafe cases remain native tabs.

**Tech Stack:** Chrome Extension Manifest V3, vanilla HTML/CSS/JavaScript, `chrome.permissions`, `chrome.scripting`, `chrome.webNavigation`, `chrome.runtime`, `chrome.tabs`, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-17-same-host-native-like-panes-design.md`

## Global Constraints

- Only `focus-multi-view-chrome-xtenstion` may change.
- Maximum panes: 9; minimum workspace pane count: 2.
- Same-host means exact `URL.hostname` equality; subdomains do not match each other.
- Enhanced behavior requires runtime host permission for every URL scheme currently used by that exact hostname.
- Runtime host permission requests occur only from an explicit user gesture.
- Permission denial, injection failure, service-worker restart, stale frame/document identity, mixed-host navigation, or unsafe popup routing must fall back to the existing basic iframe behavior without destroying panes.
- `ai-chatweb-supporter` and all other third-party extensions remain unmodified and are not proxied or copied.
- Existing compatibility/header-rewrite mode remains independent from enhanced same-host mode.
- Preserve the current xAI dark-only UI, draggable pane controls, template CRUD, and deferred splitter-resize behavior.
- No high-frequency pane polling and no runtime dependencies.

## File Structure

- `common.js` — URL normalization plus exact-same-host eligibility/origin helpers used by popup and grid.
- `manifest.json` — add `scripting`, `webNavigation`, and the MV3 service worker; optional hosts stay optional.
- `src/background/frame-registry.js` — pure session, committed-document, pane/frame mapping, stale-document validation, loading state, and cleanup.
- `src/background/popup-router.js` — pure popup-to-pane routing policy.
- `src/background/service-worker.js` — session protocol, `webNavigation`, bridge injection, targeted commands, popup routing, and restart notification.
- `src/pane/bridge.js` — pane identity, title/focus reporting, and Back/Forward execution.
- `grid.html`, `grid.css`, `grid.js` — enhanced-mode UI, stable pane IDs, session lifecycle, native-like actions, navigation state, and popup acknowledgement.
- `popup.js` — same-host host-permission request directly from Launch/Open user gestures.
- `tests/common.test.js` — same-host helper behavior.
- `tests/frame-registry.test.js` — registry identity/lifecycle/security behavior.
- `tests/popup-router.test.js` — popup routing decisions.
- `tests/bridge-static.test.js` — bridge security/event behavior.
- `tests/background-static.test.js` — service-worker event/protocol wiring.
- `tests/manifest-static.test.js` — manifest/background/permission packaging.
- `tests/grid-static.test.js` — grid/session/native-like controls and regression coverage.
- `tests/popup-static.test.js` — launch permission flow and popup regressions.
- `tests/fixtures/same-host.html` — deterministic manual browser fixture for same-host SPA/popup testing.

---

### Task 1: Add exact-same-host analysis helpers

**Files:**
- Modify: `common.js`
- Modify: `tests/common.test.js`

**Interfaces:**
- Produces: `MPV.analyzeSameHostUrls(urls)` returning `{ eligible, hostname, urls, origins, reason }`.
- Produces: `MPV.sameHostPermissionOrigins(urls)` returning only the permission-origin array when eligible.

- [ ] **Step 1: Write failing helper tests**

```js
test('analyzeSameHostUrls accepts exact hostname matches and returns scheme-specific origins', () => {
  assert.deepEqual(MPV.analyzeSameHostUrls(['https://chatgpt.com/a', 'http://chatgpt.com/b']), {
    eligible: true,
    hostname: 'chatgpt.com',
    urls: ['https://chatgpt.com/a', 'http://chatgpt.com/b'],
    origins: ['http://chatgpt.com/*', 'https://chatgpt.com/*'],
    reason: '',
  });
});

test('analyzeSameHostUrls rejects subdomain mismatch', () => {
  const result = MPV.analyzeSameHostUrls(['https://app.example.com', 'https://docs.example.com']);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'mixed-host');
});

test('sameHostPermissionOrigins requires two http(s) targets', () => {
  assert.deepEqual(MPV.sameHostPermissionOrigins(['about:blank', 'https://example.com']), []);
  assert.deepEqual(MPV.sameHostPermissionOrigins(['https://example.com']), []);
});
```

- [ ] **Step 2: Verify the tests fail because the helpers are missing**

```bash
node --test tests/common.test.js
```

Expected: FAIL on missing `analyzeSameHostUrls` / `sameHostPermissionOrigins`.

- [ ] **Step 3: Implement and export the helpers**

```js
function parseHttpUrl(value) {
  try {
    const url = new URL(normalizeUrl(value));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function analyzeSameHostUrls(values) {
  const raw = Array.isArray(values) ? values : [];
  if (raw.length < 2) return { eligible: false, hostname: '', urls: [], origins: [], reason: 'count' };
  const parsed = raw.map(parseHttpUrl);
  if (parsed.some((url) => !url)) return { eligible: false, hostname: '', urls: [], origins: [], reason: 'invalid-url' };

  const hostname = parsed[0].hostname.toLowerCase();
  if (!hostname || parsed.some((url) => url.hostname.toLowerCase() !== hostname)) {
    return { eligible: false, hostname: '', urls: parsed.map((url) => url.href), origins: [], reason: 'mixed-host' };
  }

  const urls = parsed.map((url) => url.href);
  const origins = [...new Set(parsed.map((url) => `${url.protocol}//${hostname}/*`))].sort();
  return { eligible: true, hostname, urls, origins, reason: '' };
}

function sameHostPermissionOrigins(values) {
  const analysis = analyzeSameHostUrls(values);
  return analysis.eligible ? analysis.origins : [];
}
```

Add both names to the existing `api` export.

- [ ] **Step 4: Run focused verification**

```bash
node --test tests/common.test.js
node --check common.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add common.js tests/common.test.js
git commit -m "feat: add same-host analysis helpers"
```

---

### Task 2: Add a stale-safe frame/document registry

**Files:**
- Create: `src/background/frame-registry.js`
- Create: `tests/frame-registry.test.js`

**Interfaces:**
- Produces `MPVFrameRegistry.FrameRegistry`.
- `registerSession({ tabId, sessionId, hostname, paneIds })`.
- `recordCommittedDocument({ tabId, frameId, documentId, url })`.
- `registerPaneFrame({ tabId, frameId, documentId, paneId, url, title, focused })`.
- `updatePaneFrame(...)`, `setFrameLoading(tabId, frameId, loading)`.
- `getPane(tabId, paneId)`, `findPaneByFrame(tabId, frameId)`, `getSession(tabId)`.
- `updateSessionPanes(tabId, sessionId, paneIds)`, `removeFrame(tabId, frameId)`, `removeSession(tabId)`.

- [ ] **Step 1: Write failing registry tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameRegistry } = require('../src/background/frame-registry.js');

function makeRegistry() {
  const registry = new FrameRegistry();
  registry.registerSession({ tabId: 10, sessionId: 's1', hostname: 'chatgpt.com', paneIds: ['p1', 'p2'] });
  return registry;
}

test('registerPaneFrame accepts only the currently committed document', () => {
  const registry = makeRegistry();
  assert.equal(registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/c/1' }), true);
  const record = registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/c/1', title: 'One' });
  assert.equal(record.paneId, 'p1');
});

test('a new commit invalidates the old pane document but keeps the new commit registrable', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/1' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/1' });
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd2', url: 'https://chatgpt.com/2' });
  assert.equal(registry.getPane(10, 'p1'), null);
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/1' }), null);
  assert.ok(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd2', paneId: 'p1', url: 'https://chatgpt.com/2' }));
});

test('one live frame cannot claim two pane ids', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  assert.ok(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' }));
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p2', url: 'https://chatgpt.com/' }), null);
});

test('new session id clears stale mappings and committed documents', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'd1', url: 'https://chatgpt.com/' });
  registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' });
  registry.registerSession({ tabId: 10, sessionId: 's2', hostname: 'chatgpt.com', paneIds: ['p1'] });
  assert.equal(registry.getPane(10, 'p1'), null);
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'd1', paneId: 'p1', url: 'https://chatgpt.com/' }), null);
});
```

- [ ] **Step 2: Verify the module is absent**

```bash
node --test tests/frame-registry.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the registry with separate binding and committed-document cleanup**

```js
(function initFrameRegistry(global) {
  'use strict';

  function safeHostname(value) {
    try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
  }

  class FrameRegistry {
    constructor() {
      this.sessions = new Map();
      this.committed = new Map();
    }

    documentKey(tabId, frameId) { return `${tabId}:${frameId}`; }

    clearCommittedForTab(tabId) {
      for (const key of [...this.committed.keys()]) if (key.startsWith(`${tabId}:`)) this.committed.delete(key);
    }

    registerSession({ tabId, sessionId, hostname, paneIds }) {
      if (!Number.isInteger(tabId) || !sessionId || !hostname) return null;
      const existing = this.sessions.get(tabId);
      if (existing && existing.sessionId !== sessionId) this.clearCommittedForTab(tabId);
      const sameSession = existing?.sessionId === sessionId;
      const session = {
        tabId,
        sessionId,
        hostname: String(hostname).toLowerCase(),
        paneIds: new Set(Array.from(paneIds || []).filter(Boolean)),
        paneById: sameSession ? existing.paneById : new Map(),
        paneIdByFrame: sameSession ? existing.paneIdByFrame : new Map(),
      };
      this.sessions.set(tabId, session);
      this.updateSessionPanes(tabId, sessionId, session.paneIds);
      return this.getSession(tabId);
    }

    getSession(tabId) {
      const session = this.sessions.get(tabId);
      return session ? { tabId, sessionId: session.sessionId, hostname: session.hostname, paneIds: [...session.paneIds] } : null;
    }

    clearFrameBinding(tabId, frameId) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      if (paneId) session.paneById.delete(paneId);
      session?.paneIdByFrame.delete(frameId);
    }

    recordCommittedDocument({ tabId, frameId, documentId, url }) {
      const session = this.sessions.get(tabId);
      if (!session || !Number.isInteger(frameId) || frameId <= 0 || !documentId) return false;
      if (safeHostname(url) !== session.hostname) return false;
      this.clearFrameBinding(tabId, frameId);
      this.committed.set(this.documentKey(tabId, frameId), { documentId, url });
      return true;
    }

    registerPaneFrame(input) {
      const { tabId, frameId, documentId, paneId, url } = input;
      const session = this.sessions.get(tabId);
      const committed = this.committed.get(this.documentKey(tabId, frameId));
      if (!session || !session.paneIds.has(paneId) || !committed || committed.documentId !== documentId) return null;
      if (safeHostname(url) !== session.hostname) return null;
      const claimed = session.paneIdByFrame.get(frameId);
      if (claimed && claimed !== paneId) return null;
      const previous = session.paneById.get(paneId);
      if (previous && previous.frameId !== frameId) session.paneIdByFrame.delete(previous.frameId);
      const record = { tabId, frameId, documentId, paneId, url, title: String(input.title || ''), focused: input.focused === true, loading: false };
      session.paneById.set(paneId, record);
      session.paneIdByFrame.set(frameId, paneId);
      return { ...record };
    }

    updatePaneFrame(input) {
      const current = this.getPane(input.tabId, input.paneId);
      if (!current || current.frameId !== input.frameId || current.documentId !== input.documentId) return null;
      return this.registerPaneFrame({ ...current, ...input });
    }

    setFrameLoading(tabId, frameId, loading) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      const record = paneId ? session.paneById.get(paneId) : null;
      if (!record) return null;
      record.loading = Boolean(loading);
      return { ...record };
    }

    getPane(tabId, paneId) {
      const record = this.sessions.get(tabId)?.paneById.get(paneId);
      return record ? { ...record } : null;
    }

    findPaneByFrame(tabId, frameId) {
      const session = this.sessions.get(tabId);
      const paneId = session?.paneIdByFrame.get(frameId);
      return paneId ? this.getPane(tabId, paneId) : null;
    }

    updateSessionPanes(tabId, sessionId, paneIds) {
      const session = this.sessions.get(tabId);
      if (!session || session.sessionId !== sessionId) return false;
      session.paneIds = new Set(Array.from(paneIds || []).filter(Boolean));
      for (const [paneId, record] of session.paneById) {
        if (!session.paneIds.has(paneId)) {
          session.paneById.delete(paneId);
          session.paneIdByFrame.delete(record.frameId);
        }
      }
      return true;
    }

    removeFrame(tabId, frameId) {
      this.clearFrameBinding(tabId, frameId);
      this.committed.delete(this.documentKey(tabId, frameId));
    }

    removeSession(tabId) {
      this.sessions.delete(tabId);
      this.clearCommittedForTab(tabId);
    }
  }

  const api = { FrameRegistry };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MPVFrameRegistry = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
```

- [ ] **Step 4: Run focused verification**

```bash
node --test tests/frame-registry.test.js
node --check src/background/frame-registry.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/background/frame-registry.js tests/frame-registry.test.js
git commit -m "feat: add pane frame registry"
```

---

### Task 3: Add deterministic popup routing policy

**Files:**
- Create: `src/background/popup-router.js`
- Create: `tests/popup-router.test.js`

**Interfaces:**
- Produces `decidePopupRoute({ sourceRegistered, sessionHostname, targetUrl, paneCount, maxPanes })`.
- Returns `{ action: 'ignore' }`, `{ action: 'native', reason }`, or `{ action: 'pane', targetUrl }`.

- [ ] **Step 1: Write failing router tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decidePopupRoute } = require('../src/background/popup-router.js');

test('same-host popup becomes pane below limit', () => {
  assert.deepEqual(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'https://chatgpt.com/new', paneCount: 4, maxPanes: 9 }), { action: 'pane', targetUrl: 'https://chatgpt.com/new' });
});

test('cross-host and pane-limit popups stay native', () => {
  assert.equal(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'https://example.com', paneCount: 4, maxPanes: 9 }).action, 'native');
  assert.equal(decidePopupRoute({ sourceRegistered: true, sessionHostname: 'chatgpt.com', targetUrl: 'https://chatgpt.com/new', paneCount: 9, maxPanes: 9 }).action, 'native');
});

test('unregistered source is ignored', () => {
  assert.equal(decidePopupRoute({ sourceRegistered: false, sessionHostname: 'chatgpt.com', targetUrl: 'https://chatgpt.com', paneCount: 2, maxPanes: 9 }).action, 'ignore');
});
```

- [ ] **Step 2: Verify failure**

```bash
node --test tests/popup-router.test.js
```

- [ ] **Step 3: Implement the policy**

```js
(function initPopupRouter(global) {
  'use strict';
  function targetHostname(targetUrl) {
    try {
      const url = new URL(targetUrl);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname.toLowerCase() : '';
    } catch { return ''; }
  }

  function decidePopupRoute({ sourceRegistered, sessionHostname, targetUrl, paneCount, maxPanes = 9 }) {
    if (!sourceRegistered) return { action: 'ignore' };
    const hostname = targetHostname(targetUrl);
    if (!hostname) return { action: 'native', reason: 'invalid-target' };
    if (hostname !== String(sessionHostname || '').toLowerCase()) return { action: 'native', reason: 'cross-host' };
    if (paneCount >= maxPanes) return { action: 'native', reason: 'pane-limit' };
    return { action: 'pane', targetUrl };
  }

  const api = { decidePopupRoute };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.MPVPopupRouter = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
```

- [ ] **Step 4: Verify**

```bash
node --test tests/popup-router.test.js
node --check src/background/popup-router.js
```

- [ ] **Step 5: Commit**

```bash
git add src/background/popup-router.js tests/popup-router.test.js
git commit -m "feat: add same-host popup routing policy"
```

---

### Task 4: Add the pane bridge

**Files:**
- Create: `src/pane/bridge.js`
- Create: `tests/bridge-static.test.js`

**Interfaces:**
- Consumes `mpv:bridge-command` with `{ paneId, command }`, where command is `back` or `forward`.
- Emits `mpv:bridge-register` / `mpv:bridge-state` with non-authoritative `{ paneId, url, title, focused }` only.
- SPA `pushState`/`replaceState` URL changes are tracked by `webNavigation.onHistoryStateUpdated`; the bridge does not patch page-world history APIs.

- [ ] **Step 1: Add failing bridge tests**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('src/pane/bridge.js', 'utf8');

test('bridge derives identity from focus-pane window.name', () => {
  assert.match(js, /window\.name/);
  assert.match(js, /focus-pane:/);
  assert.match(js, /mpv:bridge-register/);
});

test('bridge exposes only back and forward commands', () => {
  assert.match(js, /history\.back\(\)/);
  assert.match(js, /history\.forward\(\)/);
  assert.equal(js.includes('eval('), false);
  assert.equal(js.includes('new Function'), false);
});

test('bridge reports title and focus changes without polling', () => {
  assert.match(js, /MutationObserver/);
  assert.match(js, /hashchange/);
  assert.match(js, /popstate/);
  assert.match(js, /pointerdown/);
  assert.equal(js.includes('setInterval'), false);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --test tests/bridge-static.test.js
```

- [ ] **Step 3: Implement the idempotent isolated-world bridge**

```js
(() => {
  'use strict';
  if (globalThis.__mpvPaneBridgeInstalled) return;
  globalThis.__mpvPaneBridgeInstalled = true;

  const prefix = 'focus-pane:';
  const paneId = String(window.name || '').startsWith(prefix) ? String(window.name).slice(prefix.length) : '';
  if (!paneId) return;

  function snapshot(focused = document.hasFocus()) {
    return { paneId, url: location.href, title: document.title || '', focused: Boolean(focused) };
  }

  function send(type, focused) {
    try { chrome.runtime.sendMessage({ type, ...snapshot(focused) }); } catch { /* basic mode remains usable */ }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'mpv:bridge-command' || message.paneId !== paneId) return undefined;
    if (message.command === 'back') history.back();
    else if (message.command === 'forward') history.forward();
    return undefined;
  });

  let lastTitle = document.title;
  const observer = new MutationObserver(() => {
    if (document.title === lastTitle) return;
    lastTitle = document.title;
    send('mpv:bridge-state');
  });
  const title = document.querySelector('title');
  if (title) observer.observe(title, { childList: true, subtree: true, characterData: true });
  else if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('popstate', () => send('mpv:bridge-state'), { passive: true });
  window.addEventListener('hashchange', () => send('mpv:bridge-state'), { passive: true });
  window.addEventListener('focus', () => send('mpv:bridge-state', true), { passive: true });
  document.addEventListener('pointerdown', () => send('mpv:bridge-state', true), { capture: true, passive: true });
  send('mpv:bridge-register');
})();
```

- [ ] **Step 4: Verify**

```bash
node --test tests/bridge-static.test.js
node --check src/pane/bridge.js
```

- [ ] **Step 5: Commit**

```bash
git add src/pane/bridge.js tests/bridge-static.test.js
git commit -m "feat: add pane bridge runtime"
```

---

### Task 5: Add Manifest V3 background orchestration

**Files:**
- Modify: `manifest.json`
- Create: `src/background/service-worker.js`
- Create: `tests/manifest-static.test.js`
- Create: `tests/background-static.test.js`

**Interfaces:**
- Consumes `FrameRegistry` and `decidePopupRoute`.
- Handles `mpv:session-start`, `mpv:session-update`, `mpv:session-stop`, `mpv:pane-command`, `mpv:bridge-register`, `mpv:bridge-state`.
- Emits `mpv:pane-state`, `mpv:popup-candidate`, and `mpv:background-ready`.
- Injects only `src/pane/bridge.js` into eligible subframes of a registered Focus grid tab.

- [ ] **Step 1: Write failing manifest/background tests**

```js
// tests/manifest-static.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));

test('manifest packages enhanced runtime with optional host access', () => {
  assert.ok(manifest.permissions.includes('scripting'));
  assert.ok(manifest.permissions.includes('webNavigation'));
  assert.equal(manifest.background.service_worker, 'src/background/service-worker.js');
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.equal('host_permissions' in manifest, false);
});
```

```js
// tests/background-static.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const js = fs.readFileSync('src/background/service-worker.js', 'utf8');

test('worker installs navigation, popup, cleanup, and restart-ready wiring', () => {
  assert.match(js, /importScripts\('frame-registry\.js', 'popup-router\.js'\)/);
  assert.match(js, /webNavigation\.onCommitted/);
  assert.match(js, /webNavigation\.onHistoryStateUpdated/);
  assert.match(js, /webNavigation\.onCreatedNavigationTarget/);
  assert.match(js, /tabs\.onRemoved/);
  assert.match(js, /mpv:background-ready/);
});

test('bridge injection is frame-targeted and popup close requires acceptance', () => {
  assert.match(js, /frameIds:\s*\[frameId\]/);
  assert.match(js, /src\/pane\/bridge\.js/);
  assert.match(js, /accepted/);
  assert.match(js, /tabs\.remove/);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --test tests/manifest-static.test.js tests/background-static.test.js
```

- [ ] **Step 3: Add manifest permissions/background worker**

Use this permission/background fragment while retaining the current icons/action/version:

```json
"permissions": [
  "storage",
  "tabs",
  "scripting",
  "webNavigation",
  "declarativeNetRequestWithHostAccess"
],
"optional_host_permissions": ["http://*/*", "https://*/*"],
"background": {
  "service_worker": "src/background/service-worker.js"
}
```

- [ ] **Step 4: Implement trusted sender/session helpers and bridge injection**

```js
'use strict';
importScripts('frame-registry.js', 'popup-router.js');

const registry = new MPVFrameRegistry.FrameRegistry();
const MAX_PANES = 9;
const GRID_URL = chrome.runtime.getURL('grid.html');

function senderTabId(sender) {
  return Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
}
function hostnameOf(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}
function isTrustedGridSender(sender) {
  return sender?.url === GRID_URL && Number.isInteger(senderTabId(sender));
}
function publish(record) {
  if (record) chrome.runtime.sendMessage({ type: 'mpv:pane-state', ...record }).catch(() => {});
}
async function injectBridge(tabId, frameId) {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['src/pane/bridge.js'] });
}
async function seedAndInjectSessionFrames(tabId) {
  const session = registry.getSession(tabId);
  if (!session) return;
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  for (const frame of frames || []) {
    if (!Number.isInteger(frame.frameId) || frame.frameId <= 0 || !frame.documentId || hostnameOf(frame.url) !== session.hostname) continue;
    if (!registry.recordCommittedDocument({ tabId, frameId: frame.frameId, documentId: frame.documentId, url: frame.url })) continue;
    try { await injectBridge(tabId, frame.frameId); } catch { /* basic mode remains available */ }
  }
}
```

- [ ] **Step 5: Implement runtime message validation and targeted commands**

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = senderTabId(sender);

  if (message?.type === 'mpv:session-start' && isTrustedGridSender(sender)) {
    const session = registry.registerSession({ tabId, sessionId: message.sessionId, hostname: message.hostname, paneIds: message.paneIds });
    if (!session) { sendResponse({ ok: false }); return false; }
    seedAndInjectSessionFrames(tabId).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'mpv:session-update' && isTrustedGridSender(sender)) {
    sendResponse({ ok: registry.updateSessionPanes(tabId, message.sessionId, message.paneIds) });
    return false;
  }
  if (message?.type === 'mpv:session-stop' && isTrustedGridSender(sender)) {
    const session = registry.getSession(tabId);
    if (session?.sessionId === message.sessionId) registry.removeSession(tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === 'mpv:bridge-register' || message?.type === 'mpv:bridge-state') {
    if (!Number.isInteger(tabId) || !Number.isInteger(sender.frameId) || sender.frameId <= 0 || !sender.documentId) return false;
    const input = { tabId, frameId: sender.frameId, documentId: sender.documentId, paneId: message.paneId, url: message.url, title: message.title, focused: message.focused };
    const record = message.type === 'mpv:bridge-register' ? registry.registerPaneFrame(input) : registry.updatePaneFrame(input);
    publish(record);
    sendResponse({ ok: Boolean(record) });
    return false;
  }
  if (message?.type === 'mpv:pane-command' && isTrustedGridSender(sender)) {
    const record = registry.getPane(tabId, message.paneId);
    if (!record || !['back', 'forward'].includes(message.command)) { sendResponse({ ok: false }); return false; }
    chrome.tabs.sendMessage(
      tabId,
      { type: 'mpv:bridge-command', paneId: record.paneId, command: message.command },
      { documentId: record.documentId },
    ).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
    return true;
  }
  return undefined;
});
```

- [ ] **Step 6: Implement navigation lifecycle including cross-host invalidation**

```js
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId <= 0 || !details.documentId) return;
  const session = registry.getSession(details.tabId);
  if (!session) return;

  const previous = registry.findPaneByFrame(details.tabId, details.frameId);
  if (hostnameOf(details.url) !== session.hostname) {
    if (previous) publish({ ...previous, url: details.url, documentId: details.documentId, loading: false, enhanced: false });
    registry.removeFrame(details.tabId, details.frameId);
    return;
  }

  if (!registry.recordCommittedDocument({ tabId: details.tabId, frameId: details.frameId, documentId: details.documentId, url: details.url })) return;
  injectBridge(details.tabId, details.frameId).catch(() => {});
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  const record = registry.findPaneByFrame(details.tabId, details.frameId);
  if (!record || record.documentId !== details.documentId) return;
  publish(registry.updatePaneFrame({ ...record, url: details.url }));
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId > 0) publish(registry.setFrameLoading(details.tabId, details.frameId, true));
});
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId > 0) publish(registry.setFrameLoading(details.tabId, details.frameId, false));
});
chrome.tabs.onRemoved.addListener((tabId) => registry.removeSession(tabId));
```

- [ ] **Step 7: Implement acknowledged popup handoff and worker-ready broadcast**

```js
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (details) => {
  const source = registry.findPaneByFrame(details.sourceTabId, details.sourceFrameId);
  const session = registry.getSession(details.sourceTabId);
  if (!source || !session) return;
  const route = MPVPopupRouter.decidePopupRoute({ sourceRegistered: true, sessionHostname: session.hostname, targetUrl: details.url, paneCount: session.paneIds.length, maxPanes: MAX_PANES });
  if (route.action !== 'pane') return;

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'mpv:popup-candidate',
      sessionId: session.sessionId,
      sourcePaneId: source.paneId,
      popupTabId: details.tabId,
      targetUrl: route.targetUrl,
    });
    if (response?.accepted === true) await chrome.tabs.remove(details.tabId);
  } catch {
    // Leave the native popup untouched if the grid does not acknowledge it.
  }
});

chrome.runtime.sendMessage({ type: 'mpv:background-ready' }).catch(() => {});
```

- [ ] **Step 8: Verify background/manifest modules**

```bash
node --test tests/manifest-static.test.js tests/background-static.test.js tests/frame-registry.test.js tests/popup-router.test.js
node --check src/background/service-worker.js
python -m json.tool manifest.json > /dev/null
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add manifest.json src/background/service-worker.js tests/manifest-static.test.js tests/background-static.test.js
git commit -m "feat: add enhanced pane background runtime"
```

---

### Task 6: Request exact-host permission directly from launch gestures

**Files:**
- Modify: `popup.js`
- Modify: `tests/popup-static.test.js`

**Interfaces:**
- Consumes `MPV.sameHostPermissionOrigins(urls)`.
- Produces `requestEnhancedPermissionForLaunch(urls)`.
- Denial never prevents grid creation.

- [ ] **Step 1: Add failing static permission-flow test**

```js
test('same-host launch requests only narrowed origins and still creates a grid tab', () => {
  assert.match(js, /requestEnhancedPermissionForLaunch/);
  assert.match(js, /MPV\.sameHostPermissionOrigins/);
  assert.match(js, /chrome\.permissions\.request/);
  assert.match(js, /chrome\.tabs\.create/);
  assert.equal(js.includes("origins: ['http://*/*', 'https://*/*']"), false);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --test tests/popup-static.test.js
```

- [ ] **Step 3: Add a helper that calls `permissions.request` before any asynchronous preflight**

```js
async function requestEnhancedPermissionForLaunch(urls) {
  const origins = MPV.sameHostPermissionOrigins(urls);
  if (!origins.length) return false;
  try { return await chrome.permissions.request({ origins }); }
  catch { return false; }
}
```

In `launchUrls`, call it immediately after validating `cleanUrls.length >= 2` and before the first existing `await`:

```js
await requestEnhancedPermissionForLaunch(cleanUrls);

if (rememberMainForm) {
  await chrome.storage.local.set({ paneCount, paneUrls: cleanUrls });
}
await chrome.storage.session.set({ launchUrls: cleanUrls });
await chrome.tabs.create({ url: chrome.runtime.getURL('grid.html') });
```

This preserves the explicit Launch/Open user activation. Already-granted origins resolve successfully without widening permission scope.

- [ ] **Step 4: Verify popup/shared behavior**

```bash
node --test tests/common.test.js tests/popup-static.test.js
node --check popup.js
```

- [ ] **Step 5: Commit**

```bash
git add popup.js tests/popup-static.test.js
git commit -m "feat: request same-host permission on launch"
```

---

### Task 7: Integrate enhanced sessions and native-like pane controls in the grid

**Files:**
- Modify: `grid.html`
- Modify: `grid.css`
- Modify: `grid.js`
- Modify: `tests/grid-static.test.js`

**Interfaces:**
- Consumes the Task 5 message protocol.
- Produces stable `pane.id`, iframe name `focus-pane:<paneId>`, grid `sessionId`, enhanced lifecycle, Back/Forward/Open-native actions, URL/title/focus updates, popup acknowledgement, and worker-restart re-registration.

- [ ] **Step 1: Add failing grid tests**

```js
test('panes use stable logical ids and focus-pane frame names', () => {
  assert.match(js, /crypto\.randomUUID\(\)/);
  assert.match(js, /focus-pane:/);
  assert.match(js, /sessionId/);
});

test('grid has explicit enhanced activation and session lifecycle messages', () => {
  assert.ok(html.includes('id="enhancedToggle"'));
  assert.match(js, /mpv:session-start/);
  assert.match(js, /mpv:session-update/);
  assert.match(js, /mpv:session-stop/);
  assert.match(js, /mpv:background-ready/);
});

test('enhanced controls include back forward and open-native', () => {
  assert.match(js, /Back/);
  assert.match(js, /Forward/);
  assert.match(js, /Open in native tab/);
  assert.match(js, /mpv:pane-command/);
});

test('popup candidate is acknowledged only after pane creation', () => {
  assert.match(js, /mpv:popup-candidate/);
  assert.match(js, /accepted:\s*true/);
});

test('native popup fallback escapes iframe sandbox', () => {
  assert.match(js, /allow-popups-to-escape-sandbox/);
});
```

- [ ] **Step 2: Verify failure**

```bash
node --test tests/grid-static.test.js
```

- [ ] **Step 3: Add the global Enhanced control**

In `grid.html`, next to Compatibility:

```html
<button id="enhancedToggle" class="panel-button enhanced-button" type="button" title="Enable native-like controls when every pane uses the same exact hostname.">
  <span class="enhanced-dot" aria-hidden="true"></span>
  <span>Enhanced: Off</span>
</button>
```

In `grid.css`:

```css
.enhanced-button.active .enhanced-dot { opacity: 1; }
.enhanced-button:disabled { opacity: .45; cursor: default; }
.pane-control-action.enhanced-only[hidden] { display: none; }
```

- [ ] **Step 4: Add stable pane/session identity**

At module scope:

```js
const enhancedToggle = document.getElementById('enhancedToggle');
const sessionId = crypto.randomUUID();
let enhancedActive = false;
let enhancedHostname = '';

function paneIds() { return panes.map((pane) => pane.id); }
function paneUrls() { return panes.map((pane) => pane.urlInput.value || pane.iframe.src); }
function sameHostAnalysis() { return MPV.analyzeSameHostUrls(paneUrls()); }
```

In `createPane`:

```js
const paneId = crypto.randomUUID();
iframe.name = `focus-pane:${paneId}`;
iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
```

Store `id: paneId` and `urlInput` on the pane record.

- [ ] **Step 5: Add session synchronization and gesture-only permission activation**

```js
async function sendRuntime(message) {
  try { return await chrome.runtime.sendMessage(message); } catch { return null; }
}

async function stopEnhancedSession() {
  if (enhancedActive) await sendRuntime({ type: 'mpv:session-stop', sessionId });
  enhancedActive = false;
  enhancedHostname = '';
  updateEnhancedUi();
}

async function syncEnhancedSession() {
  const analysis = sameHostAnalysis();
  if (!analysis.eligible) { await stopEnhancedSession(); return false; }
  const granted = await chrome.permissions.contains({ origins: analysis.origins });
  if (!granted) { await stopEnhancedSession(); updateEnhancedUi(analysis); return false; }

  const response = await sendRuntime({
    type: enhancedActive ? 'mpv:session-update' : 'mpv:session-start',
    sessionId,
    hostname: analysis.hostname,
    paneIds: paneIds(),
  });
  enhancedActive = response?.ok === true;
  enhancedHostname = enhancedActive ? analysis.hostname : '';
  updateEnhancedUi(analysis);
  return enhancedActive;
}

async function enableEnhancedFromGesture() {
  const analysis = sameHostAnalysis();
  if (!analysis.eligible) return false;
  const granted = await chrome.permissions.request({ origins: analysis.origins });
  if (!granted) return false;
  return syncEnhancedSession();
}
```

`updateEnhancedUi(analysis = sameHostAnalysis())` must display exactly `Enhanced: On`, `Enhanced: Off`, or `Enhanced: Mixed hosts`; it also shows/hides `.enhanced-only` pane actions.

Wire only the explicit button to `permissions.request`:

```js
enhancedToggle.addEventListener('click', () => { enableEnhancedFromGesture().catch(console.error); });
```

Call `syncEnhancedSession()` after pane add/remove, typed URL navigation, background pane-state updates, and initialization; never call `permissions.request` from those automatic paths.

- [ ] **Step 6: Add Back/Forward/Open-native pane actions**

Inside `createPane`:

```js
function enhancedAction(label, title, command) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pane-control-action enhanced-only';
  button.hidden = !enhancedActive;
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.addEventListener('click', () => sendRuntime({ type: 'mpv:pane-command', sessionId, paneId, command }));
  return button;
}

const backBtn = enhancedAction('‹', 'Back', 'back');
const forwardBtn = enhancedAction('›', 'Forward', 'forward');
const nativeBtn = document.createElement('button');
nativeBtn.type = 'button';
nativeBtn.className = 'pane-control-action enhanced-only';
nativeBtn.hidden = !enhancedActive;
nativeBtn.textContent = '↗';
nativeBtn.title = 'Open in native tab';
nativeBtn.setAttribute('aria-label', 'Open in native tab');
nativeBtn.addEventListener('click', () => chrome.tabs.create({ url: urlInput.value || iframe.src }));
```

Append: Back, Forward, URL field, Reload, Open-native, Close.

- [ ] **Step 7: Consume pane state, cross-host invalidation, popup candidates, and worker-ready events**

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'mpv:background-ready') {
    syncEnhancedSession().catch(() => {});
    return undefined;
  }

  if (message?.type === 'mpv:pane-state') {
    const pane = panes.find((item) => item.id === message.paneId);
    if (!pane) return undefined;
    if (message.url) pane.urlInput.value = message.url;
    pane.wrapper.dataset.title = message.title || '';
    pane.wrapper.classList.toggle('loading', message.loading === true);
    if (message.focused) panes.forEach((item) => item.wrapper.classList.toggle('logical-active', item === pane));
    syncEnhancedSession().catch(() => {});
    return undefined;
  }

  if (message?.type === 'mpv:popup-candidate' && message.sessionId === sessionId) {
    if (!enhancedActive || panes.length >= MAX_PANES) { sendResponse({ accepted: false }); return false; }
    const analysis = MPV.analyzeSameHostUrls([...paneUrls(), message.targetUrl]);
    if (!analysis.eligible || analysis.hostname !== enhancedHostname) { sendResponse({ accepted: false }); return false; }
    addPane(message.targetUrl);
    syncEnhancedSession().then(() => sendResponse({ accepted: true })).catch(() => sendResponse({ accepted: false }));
    return true;
  }

  return undefined;
});
```

On `beforeunload`, send `mpv:session-stop` best-effort. Update the URL-input Enter path to call `syncEnhancedSession()` after changing that pane URL.

- [ ] **Step 8: Verify grid regressions**

```bash
node --test tests/grid-static.test.js tests/common.test.js
node --check grid.js
```

Expected: PASS, including existing xAI, draggable-control, compatibility, and deferred-resize checks.

- [ ] **Step 9: Commit**

```bash
git add grid.html grid.css grid.js tests/grid-static.test.js
git commit -m "feat: add native-like same-host pane controls"
```

---

### Task 8: Harden recovery and protocol edge cases

**Files:**
- Modify: `tests/frame-registry.test.js`
- Modify: `tests/background-static.test.js`
- Modify: `tests/grid-static.test.js`
- Modify only if tests expose a defect: `src/background/frame-registry.js`, `src/background/service-worker.js`, `grid.js`.

**Interfaces:**
- Existing message names and registry APIs remain stable.
- Required recovery path: service worker starts -> emits `mpv:background-ready` -> surviving grid calls `syncEnhancedSession()` -> worker seeds current frames with `getAllFrames()` -> bridge injection is idempotent.

- [ ] **Step 1: Add explicit recovery/security regression tests**

```js
test('new session cannot reuse committed identity from the previous session', () => {
  const registry = makeRegistry();
  registry.recordCommittedDocument({ tabId: 10, frameId: 3, documentId: 'old', url: 'https://chatgpt.com/' });
  registry.registerSession({ tabId: 10, sessionId: 's2', hostname: 'chatgpt.com', paneIds: ['p1'] });
  assert.equal(registry.registerPaneFrame({ tabId: 10, frameId: 3, documentId: 'old', paneId: 'p1', url: 'https://chatgpt.com/' }), null);
});
```

Add static assertions that the worker emits `mpv:background-ready`, the grid reacts to it with `syncEnhancedSession`, and cross-host `onCommitted` publishes the new URL before removing the frame mapping.

- [ ] **Step 2: Run recovery/security tests**

```bash
node --test tests/frame-registry.test.js tests/background-static.test.js tests/grid-static.test.js
```

Expected: PASS if Tasks 2, 5, and 7 were implemented exactly; otherwise fix only the failing protocol edge.

- [ ] **Step 3: Run background/bridge syntax checks**

```bash
node --check src/background/frame-registry.js
node --check src/background/popup-router.js
node --check src/background/service-worker.js
node --check src/pane/bridge.js
```

Expected: all exit 0.

- [ ] **Step 4: Commit only if this task required code/test corrections**

```bash
git add tests/frame-registry.test.js tests/background-static.test.js tests/grid-static.test.js src/background/frame-registry.js src/background/service-worker.js grid.js
git commit -m "fix: harden enhanced pane lifecycle recovery"
```

If no files changed, do not create an empty commit.

---

### Task 9: Add deterministic browser fixture and complete acceptance verification

**Files:**
- Create: `tests/fixtures/same-host.html`
- Modify: `README.md` if enhanced-mode usage is not documented.
- Test: all `tests/*.test.js`.

**Interfaces:**
- No new production interface. Fixture provides same-host SPA, same-host popup, and cross-host popup actions for repeatable manual testing.

- [ ] **Step 1: Create the manual test fixture**

```html
<!doctype html>
<meta charset="utf-8">
<title>Focus same-host fixture</title>
<h1 id="state">Same-host fixture</h1>
<button id="spa">SPA navigation</button>
<a id="samePopup" href="/same-host.html?popup=1" target="_blank">Same-host popup</a>
<a id="crossPopup" href="http://127.0.0.1:8765/same-host.html?cross=1" target="_blank">Cross-host popup</a>
<script>
  document.getElementById('spa').addEventListener('click', () => {
    history.pushState({}, '', `?spa=${Date.now()}`);
    document.title = `SPA ${Date.now()}`;
    document.getElementById('state').textContent = location.href;
  });
</script>
```

- [ ] **Step 2: Run the complete automated suite**

```bash
node --test tests/*.test.js
node --check common.js
node --check popup.js
node --check grid.js
node --check src/background/frame-registry.js
node --check src/background/popup-router.js
node --check src/background/service-worker.js
node --check src/pane/bridge.js
python -m json.tool manifest.json > /dev/null
```

Expected: all tests PASS; syntax checks exit 0; manifest parses.

- [ ] **Step 3: Serve the fixture and run browser acceptance**

Run:

```bash
python -m http.server 8765 --directory tests/fixtures
```

Then load the repository as an unpacked extension and verify:

```text
1. Launch two http://localhost:8765/same-host.html panes and accept the exact-host permission.
2. Confirm Enhanced: On and independent pane identity.
3. Click SPA navigation in one pane; confirm only that pane URL/title state updates.
4. Test Back, Forward, Reload, Close, URL navigation, and Open in native tab.
5. Click Same-host popup below 9 panes; confirm a new Focus pane appears and the temporary native popup closes only after acknowledgement.
6. Fill the workspace to 9 panes; Same-host popup must remain a native Chrome tab.
7. Click Cross-host popup (`127.0.0.1` vs `localhost`); it must remain a native tab.
8. Navigate one pane to `http://127.0.0.1:8765/same-host.html`; Enhanced must fall back without destroying panes.
9. Navigate every pane back to `http://localhost:8765/same-host.html`; re-enable if needed and confirm recovery.
10. Revoke/deny permission on a fresh host; basic iframe mode must remain usable.
11. Reload the extension service worker while the grid stays open; `mpv:background-ready` must cause session re-registration and bridge recovery.
12. Resize splitters repeatedly; deferred resize must remain smooth with no continuous iframe relayout regression.
13. Toggle Compatibility independently; it must not change Enhanced state.
```

- [ ] **Step 4: Document the user-facing mode if README lacks it**

```md
## Enhanced same-host panes

When every pane uses the same exact hostname, Focus Multi View can request permission for that host and enable native-like Back, Forward, Reload, popup-to-pane routing, and Open in native tab controls. Permission is optional; denying it leaves the normal iframe grid unchanged. Mixed-host workspaces fall back to basic pane mode.
```

- [ ] **Step 5: Re-run automated tests after fixture/documentation changes**

```bash
node --test tests/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit fixture/documentation**

```bash
git add tests/fixtures/same-host.html README.md
git commit -m "docs: document enhanced same-host panes"
```

If README already contains equivalent text, commit only the fixture:

```bash
git add tests/fixtures/same-host.html
git commit -m "test: add same-host browser fixture"
```

---

## Implementation Order and Review Gates

Implement Tasks 1–9 in order. Each task uses a focused red/green test cycle and ends with an independently reviewable result. After Tasks 5, 7, 8, and 9, run the broader regression commands shown there. Do not merge until the browser acceptance checklist passes or browser-only limitations are documented explicitly in the PR.

## Spec Coverage Self-Review

- Exact-host matching and scheme-specific runtime permissions: Tasks 1 and 6.
- Explicit user gesture for permission requests: Tasks 6 and 7.
- Stable pane identity and `focus-pane:<paneId>`: Task 7.
- Frame/document registry, duplicate-claim prevention, stale-document rejection, and cleanup: Tasks 2 and 8.
- Specific-frame injection and exact-document command targeting: Tasks 4 and 5.
- SPA URL/title tracking without polling: Tasks 4, 5, and 9 using `webNavigation.onHistoryStateUpdated` plus bridge title/focus events.
- Back/Forward/Reload/Open-native/Close controls: Task 7.
- Same-host popup-to-pane acknowledgement and safe native fallback: Tasks 3, 5, 7, and 9.
- Nine-pane limit: Tasks 3, 7, and 9.
- Cross-host navigation detection and basic-mode fallback: Tasks 5, 7, and 9.
- Service-worker restart recovery: Tasks 5, 7, 8, and 9.
- Compatibility mode independence: Tasks 7 and 9.
- Existing resize/xAI/template behavior preserved: Tasks 7 and 9.
- No changes to `ai-chatweb-supporter`: global constraint and final verification.
