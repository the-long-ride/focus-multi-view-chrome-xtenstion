# Restore Closed Split-View Workspaces

Date: 2026-09-17
Branch: `feature/restore-closed-workspace`
Repository: `the-long-ride/focus-multi-view-chrome-xtenstion`

## Goal

When a user closes a Focus Multi View split-view tab and presses `Ctrl + Shift + T`, Chrome should reopen the same Focus workspace and Focus should reconstruct the workspace state instead of starting a fresh split view.

The restored workspace must preserve:

- every pane that existed when the tab was closed;
- the current URL of every pane;
- retained Back/Forward URL history for every pane;
- the selected history position for every pane;
- pane order;
- split-column and split-row sizes;
- pane-control positions;
- active/focused pane where known;
- enhanced-mode opt-in state;
- compatibility-mode state for that workspace;
- floating control position and panel visibility.

The feature must remain bounded in storage usage. History must not grow indefinitely.

## Non-goals and restoration boundary

Focus will restore the browser-visible workspace model, not arbitrary page memory.

It will not serialize or promise restoration of:

- unsaved form contents owned by a cross-origin page;
- JavaScript heap state;
- DOM mutations not represented by a URL;
- media playback position;
- cross-origin scroll position when Focus cannot legally access it;
- authentication state beyond what the browser/site already persists;
- page contents themselves.

If a site is no longer available, requires login, or refuses framing, the pane and its URL/history still restore and the site determines what the iframe displays.

## User-visible behavior

### Creating a workspace

A new split-view launch creates a stable workspace UUID before opening the grid.

The grid URL becomes:

```text
chrome-extension://<extension-id>/grid.html?workspace=<workspace-id>
```

The workspace ID is stable for the lifetime of that workspace.

### Closing and reopening

Chrome continues to own normal tab-close and `Ctrl + Shift + T` behavior. Focus does not replace the shortcut and does not require the `sessions` permission for the core flow.

When Chrome restores the closed outer extension tab, it restores the same `grid.html?workspace=<workspace-id>` URL. Focus reads the workspace ID, loads its persisted snapshot, clears its closed marker, and reconstructs the panes and layout.

Closing and restoring the same workspace repeatedly updates the same record. It never creates another workspace copy solely because the user reopened it.

### Back/Forward after restoration

Each pane gets Focus-managed retained history. Back and Forward operate on that retained history even though the original iframe process was destroyed when the outer tab closed.

A pane restored at history index `n` opens the URL at index `n`. Back decrements the index and navigates the pane to the stored URL. Forward increments the index and navigates to the stored URL.

If the user navigates back and then opens a new URL, the old forward branch is discarded, matching normal browser-history semantics.

Example:

```text
A -> B -> C
     ^ Back
```

History remains `[A, B, C]` with index at `B`.

Navigating from `B` to `D` produces:

```text
[A, B, D]
       ^
```

`C` is discarded.

## Retention limits

The approved limits are:

- maximum 50 history entries per pane;
- maximum 20 closed workspaces;
- maximum 9 panes per workspace, unchanged from the current extension;
- 6 MiB soft global budget for persisted Focus workspace data.

When a pane receives entry 51, the oldest retained history entry is removed and the history index is adjusted.

Workspace cleanup order:

1. Keep all active workspaces.
2. Keep only the 20 newest closed workspaces.
3. If workspace storage still exceeds the 6 MiB soft budget, delete the oldest closed workspaces until below budget where possible.
4. If still above budget, trim oldest pane-history entries while preserving every active pane's current URL and selected history position.
5. Never delete an active workspace as part of automatic retention cleanup.

The implementation should use `chrome.storage.local.getBytesInUse()` for budget checks rather than estimating serialized size manually.

## Persistent data model

Use versioned workspace records stored in `chrome.storage.local` under one key per workspace plus a compact index.

Suggested keys:

```text
mpv:workspace:<workspace-id>
mpv:workspace-index
```

Suggested workspace schema:

```js
{
  schemaVersion: 1,
  workspaceId,
  createdAt,
  updatedAt,
  lastSeenAt,
  closedAt: null | number,
  activeTabId: null | number,

  layout: {
    cols,
    rows,
    colSizes: number[],
    rowSizes: number[]
  },

  activePaneId: null | string,

  ui: {
    floatingTriggerPosition: { x, y },
    floatingPanelOpen: boolean,
    enhancedOptInHostname: string,
    compatibilityEnabled: boolean
  },

  panes: [
    {
      paneId,
      controlPosition: { x, y },
      historyIndex,
      history: [
        { url }
      ]
    }
  ]
}
```

Only data necessary to reconstruct Focus state is persisted. Page HTML, cookies, response bodies, arbitrary page text, and DOM state are not persisted.

The workspace index stores only metadata needed for cleanup and lookup, such as workspace ID, updated time, closed time, and active state. Individual workspace snapshots remain separate to avoid rewriting all workspaces after every navigation.

## Workspace store module

Introduce a focused workspace-store module rather than placing persistence logic directly into `grid.js` or the service worker.

Responsibilities:

- validate and normalize workspace records;
- create workspace IDs;
- load/save/delete workspace snapshots;
- update workspace-index metadata;
- enforce the 50-entry pane cap;
- enforce the 20-closed-workspace cap;
- enforce the 6 MiB soft budget;
- migrate or reject unsupported schema versions safely;
- preserve current URLs if malformed or oversized records need trimming.

The grid and background service worker use this module through explicit operations instead of manipulating raw storage keys independently.

## Launch flow

The current popup writes transient `launchUrls` data to `chrome.storage.session` and opens `grid.html`. The new flow creates and persists a workspace before opening the grid.

Conceptually:

```text
popup launch
  -> normalize 2..9 URLs
  -> create workspaceId
  -> create initial workspace snapshot
  -> persist snapshot
  -> open grid.html?workspace=<workspaceId>
```

The initial workspace records one history entry per pane at index 0.

Transient launch storage can remain temporarily for migration/fallback while the feature is introduced, but restored workspaces must not depend on `launchUrls`.

## Grid initialization

On startup, `grid.js` parses `workspace` from its own URL.

If the workspace exists and validates:

1. mark it active and attach the current outer tab ID;
2. restore pane IDs rather than generating new ones;
3. restore the current URL from each pane's `history[historyIndex]`;
4. restore layout sizes and pane-control positions;
5. restore selected Focus UI state;
6. register the workspace with the background Port session;
7. persist a refreshed `lastSeenAt` and clear `closedAt`.

If the workspace ID is missing or the record is unrecoverably invalid, use the existing safe launch/default behavior and create a new workspace instead of leaving a broken grid.

## Reliable pane/frame identity for all modes

History restoration must work even when Enhanced Mode is off. Therefore pane identity cannot depend only on the injected same-host bridge.

Each iframe is created through an extension-owned bootstrap document before navigating to the remote target URL.

Example:

```text
pane-bootstrap.html?pane=<pane-id>&target=<encoded-url>
```

The iframe element is created once. The bootstrap document immediately performs `location.replace(target)`.

Because the bootstrap navigation is extension-owned, the background service worker can bind the direct child `frameId` to the stable `paneId` before the frame moves to the remote website. The same direct iframe frame remains associated with the pane across later navigations.

Rules:

- only direct child frames of the grid (`parentFrameId === 0`) can become panes;
- nested site iframes are ignored;
- a pane ID can own only one live frame binding per outer tab;
- stale frame/document bindings are replaced only after validation;
- bindings are scoped by outer tab ID and workspace ID.

Existing Enhanced Mode may continue to add document-level bridge metadata when permission is available, but basic history tracking must not require host injection.

## Navigation tracking

The extension already has the `webNavigation` permission. The service worker uses direct-pane frame bindings to observe pane navigation independently of Enhanced Mode.

Track relevant events:

- `webNavigation.onCommitted` for normal document navigations;
- `webNavigation.onHistoryStateUpdated` for History API / SPA URL changes;
- `webNavigation.onReferenceFragmentUpdated` for same-document fragment changes;
- relevant load/error events only for pane status, not as extra history entries.

A navigation recorder normalizes URL events before mutating retained history.

### Duplicate suppression

Do not append another retained entry when the new normalized URL is an accidental duplicate of the current retained entry caused by multiple Chrome events for one logical navigation.

Reloading the same URL does not create another retained history entry.

Redirect chains should settle on the final committed URL without inflating retained history with duplicate consecutive entries. If preserving distinct redirect hops later becomes desirable, that is a separate feature.

### Traversal intent

Focus-managed Back/Forward sets a short-lived traversal intent for the target pane before navigating it to the stored target URL.

When the expected navigation arrives, the recorder moves `historyIndex` instead of appending a new entry.

Unexpected navigation during a traversal intent cancels that intent and is handled as a new navigation.

## Universal pane Back/Forward

Back/Forward becomes a workspace-history capability rather than an Enhanced-Mode-only capability.

The buttons may be visible whenever a pane has retained backward/forward history. Enhanced Mode can still use its bridge for richer same-host behavior, but persisted workspace history is authoritative for restore semantics.

This keeps restored history available for mixed-host and basic iframe sessions too.

## Snapshot updates

Persist after meaningful state changes, using short debouncing/coalescing to avoid excessive writes.

Meaningful changes include:

- pane committed navigation;
- SPA/history URL change;
- history index change;
- pane add/remove;
- pane reorder if such behavior is added later;
- splitter resize completion;
- pane-control drag completion;
- active pane change;
- floating-control position change;
- floating-panel visibility change;
- enhanced opt-in change;
- compatibility-mode change.

Pointer-move events and resize previews must never trigger storage writes. Persist only the completed state.

Before tab unload, request one final best-effort flush. Correctness must not rely solely on `beforeunload`; the debounced snapshots during normal use are the durable source of truth.

## Service-worker lifecycle and recovery

Manifest V3 service workers can suspend, so live state must be reconstructible.

Persist lightweight live bindings in `chrome.storage.session`:

```text
outerTabId -> workspaceId -> paneId -> frameId/documentId/currentUrl
```

On service-worker startup or wake:

1. reload the session binding map;
2. validate outer grid tabs that still exist;
3. use `webNavigation.getAllFrames()` where needed to validate frame existence;
4. discard bindings for removed tabs or frames;
5. notify connected grid Ports if a pane needs rebinding.

If a pane binding cannot be recovered, the grid reloads that pane through the extension bootstrap using its current retained URL. That re-establishes identity at the cost of reloading only that pane rather than losing workspace tracking.

## Closed workspace lifecycle

The service worker maintains `tabId -> workspaceId` for live grid tabs.

On grid registration:

- set `activeTabId` to the current tab;
- clear `closedAt`;
- update `lastSeenAt`.

On `tabs.onRemoved` for a known grid tab:

- set `activeTabId = null`;
- set `closedAt = Date.now()`;
- flush index metadata;
- run retention cleanup.

If Chrome exits or crashes before `tabs.onRemoved` is observed, startup reconciliation queries currently open grid tabs. Workspace records marked active but with no matching live grid tab are converted to closed records using `lastSeenAt`/current reconciliation time.

When `Ctrl + Shift + T` restores the tab, the same workspace ID is registered again and the record becomes active instead of creating a duplicate.

## Compatibility mode restoration

Compatibility mode uses session DNR rules scoped to the outer tab ID. Since a restored Chrome tab receives a new tab ID, its old rule cannot simply survive as-is.

If the workspace snapshot says compatibility mode was enabled and the required permission still exists, the restored grid recreates the session rule for the new outer tab ID.

If permission is no longer present, the workspace remains restored but Compatibility is shown Off rather than prompting without a user gesture.

## Enhanced mode restoration

Persist the workspace's enhanced opt-in hostname, but do not bypass Chrome permission rules.

On restore:

- if the workspace URLs still satisfy exact-host eligibility;
- and the saved opt-in hostname still matches;
- and the necessary host permission is still granted;
- then Enhanced Mode may reactivate automatically.

If any condition fails, restore the workspace in basic mode without losing panes or retained history.

## Multiple simultaneous workspaces

Every outer grid tab has a different stable workspace ID.

All background routing and persistence is scoped by both outer tab ID and workspace ID. The existing dedicated grid Port/session model remains the communication boundary so updates for one Focus tab cannot mutate another workspace.

A workspace ID already active in one live tab must not silently attach to a second live tab. If Chrome or a user duplicates the extension URL while the original workspace is still active, create a cloned workspace with a new UUID rather than letting two tabs race on the same persistent record.

A Ctrl+Shift+T restore is distinguishable because the original workspace no longer has a live tab association.

## Corruption and schema handling

All loaded records are validated.

Recovery priorities:

1. preserve the workspace when safe;
2. discard only malformed pane fields where possible;
3. preserve each pane's valid current URL;
4. clamp invalid history indices;
5. cap excessive history at 50 entries;
6. discard unsupported future schema versions rather than guessing their meaning.

If no valid panes remain, create a safe default workspace instead of crashing the grid.

## Security and privacy

Persisted workspace history is local extension data and may contain sensitive URLs.

Requirements:

- store only URL/navigation metadata required for restoration;
- do not store page bodies, credentials, cookies, authorization headers, DOM text, or form values;
- never place pane history into the outer grid query string;
- keep only the opaque workspace UUID in `grid.html?workspace=...`;
- enforce the bounded retention limits automatically;
- do not add `unlimitedStorage` for this feature;
- do not broaden optional host permissions for restoration.

## Testing strategy

### Unit tests

Cover pure workspace/history behavior:

- workspace schema validation;
- 50-entry pane-history cap;
- correct index adjustment after trimming oldest entries;
- backward and forward traversal;
- forward-branch truncation after new navigation;
- duplicate consecutive URL suppression;
- reload suppression;
- SPA URL recording;
- fragment URL recording;
- malformed record recovery;
- 20-closed-workspace cleanup;
- active workspaces never removed by cleanup;
- byte-budget cleanup ordering;
- workspace clone behavior when the same ID is already active.

### Static integration tests

Cover wiring:

- popup creates workspace before opening grid;
- grid URL contains only `workspace=<uuid>` and not pane URLs;
- grid restores stable pane IDs;
- pane bootstrap resource exists and redirects with `location.replace`;
- service worker tracks direct child frames only;
- service worker listens to committed/history-state/fragment navigation events;
- tab-close lifecycle updates closed metadata;
- grid Port messages are workspace-scoped;
- compatibility mode is rebound to the restored tab ID;
- no `unlimitedStorage` permission is added.

### Browser acceptance checklist

Manually verify in Chrome:

1. Open a 2-pane workspace, navigate several pages in each pane, resize the split, move controls, close the outer tab, press `Ctrl + Shift + T`, and confirm state restoration.
2. Verify pane Back/Forward traverses retained pre-close URLs.
3. Repeat with 9 panes.
4. Navigate more than 50 URLs in one pane and confirm only the newest 50 remain.
5. Go Back and then navigate to a new URL; confirm the prior forward branch is gone.
6. Confirm reload does not grow retained history.
7. Confirm SPA `pushState` and fragment changes are retained once each.
8. Restore a mixed-host/basic-mode workspace and confirm history still works.
9. Restore an enhanced same-host workspace with permission still granted.
10. Restore one after removing its host permission and confirm safe basic-mode fallback.
11. Restore compatibility mode and confirm the DNR rule is rebound to the new tab ID.
12. Kill/restart the service worker while a workspace is open and confirm pane tracking recovers.
13. Open multiple Focus workspaces, close one, restore it, and confirm the other workspace is unchanged.
14. Duplicate a live `grid.html?workspace=...` tab and confirm it receives a cloned workspace ID rather than sharing mutable state.
15. Accumulate more than 20 closed workspaces and verify oldest closed records are removed while active workspaces remain.

## Acceptance criteria

The feature is complete when:

- closing a Focus split-view tab and pressing `Ctrl + Shift + T` reconstructs the same workspace by stable workspace ID;
- every pane restores its current retained URL;
- Back/Forward history survives the close/restore cycle for up to 50 entries per pane;
- layout and agreed Focus UI state restore;
- mixed-host/basic-mode panes are tracked without requiring host injection;
- repeated close/restore cycles do not create duplicate workspace records;
- at most 20 closed workspaces are retained;
- persisted workspace data is kept under the 6 MiB soft budget where cleanup can achieve that without deleting active workspaces;
- service-worker suspension does not permanently break pane tracking;
- multiple Focus workspaces remain isolated;
- no page contents or credentials are persisted.
