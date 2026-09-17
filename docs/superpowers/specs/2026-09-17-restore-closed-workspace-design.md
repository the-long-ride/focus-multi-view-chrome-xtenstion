# Restore Closed Split-View Workspaces

Date: 2026-09-17
Branch: `feature/restore-closed-workspace`
Repository: `the-long-ride/focus-multi-view-chrome-xtenstion`

## Goal

When a user closes a Focus Multi View split-view tab and presses `Ctrl + Shift + T`, Chrome should reopen the same Focus workspace and Focus should reconstruct that workspace instead of starting fresh.

The restored workspace must preserve:

- every pane that existed when the tab was closed;
- the current URL of every pane;
- retained Back/Forward URL history for every pane;
- each pane's selected history position;
- pane order;
- split-column and split-row sizes;
- pane-control positions;
- active/focused pane where known;
- enhanced-mode opt-in state;
- compatibility-mode state for that workspace;
- floating control position and panel visibility.

History and workspace storage must remain bounded over time.

## Restoration boundary

Focus restores the browser-visible workspace model, not arbitrary page memory.

It does not promise restoration of unsaved cross-origin form contents, JavaScript heap state, DOM mutations that are not represented by a URL, media playback position, inaccessible cross-origin scroll position, page bodies, or authentication state beyond what the browser/site already persists.

If a site is unavailable, requires login, or refuses framing, the pane and its retained URL/history still restore; the site determines what the iframe displays.

## User-visible behavior

### Stable workspace identity

Every newly launched split view receives a stable workspace UUID before the grid tab opens.

The outer tab URL becomes:

```text
chrome-extension://<extension-id>/grid.html?workspace=<workspace-id>
```

Only the opaque workspace UUID is placed in the outer URL. Pane URLs and browsing history are never encoded into it.

### Close and Ctrl+Shift+T

Chrome continues to own normal tab-close and `Ctrl + Shift + T` behavior. Focus does not replace the shortcut and does not require the `sessions` permission for this flow.

When Chrome restores the closed outer extension tab, it restores the same `grid.html?workspace=<workspace-id>` URL. Focus sees the existing workspace ID, reloads that workspace record, clears its closed marker, and rebuilds the panes and layout.

Repeated close/restore cycles reuse the same workspace record. They do not create duplicate workspaces or duplicate retained history merely because the outer tab was reopened.

### Back/Forward after restoration

Each pane has Focus-managed retained URL history. This history survives destruction of the iframe process when the outer tab closes.

A restored pane opens `history[historyIndex]`. Back moves the index backward and navigates the pane to the stored URL. Forward moves it ahead and navigates to the stored URL.

If the user goes Back and then navigates somewhere new, the previous forward branch is discarded, matching normal browser history semantics.

Example:

```text
[A, B, C]
    ^
```

Navigating from `B` to `D` becomes:

```text
[A, B, D]
       ^
```

## Approved retention limits

- maximum 50 retained history entries per pane;
- maximum 20 closed workspaces;
- maximum 9 panes per workspace, unchanged;
- 6 MiB soft budget for Focus workspace-record keys only.

When entry 51 is added to a pane, remove the oldest retained entry and adjust `historyIndex`.

Cleanup order:

1. Never delete an active workspace.
2. Keep only the 20 newest closed workspaces.
3. If workspace-record keys still exceed 6 MiB, delete the oldest closed workspaces until below budget where possible.
4. If still oversized, trim oldest retained pane-history entries while preserving every pane's current URL and current history position.
5. Do not use `unlimitedStorage`.

Budget checks use `chrome.storage.local.getBytesInUse()` for the workspace keys, not the extension's unrelated local settings/templates.

## Data model

Use versioned records in `chrome.storage.local`, one key per workspace plus a compact index.

```text
mpv:workspace:<workspace-id>
mpv:workspace-index
```

Suggested schema:

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
      history: [{ url }]
    }
  ]
}
```

The workspace index contains only metadata needed for lookup and cleanup. Page HTML, cookies, authorization data, form values, response bodies, and arbitrary DOM text are never persisted.

## Persistence ownership

After a workspace becomes active, the background service worker is the single durable persistence coordinator for that workspace.

This avoids lost-update races between `grid.js` and `webNavigation` events.

Responsibilities are split as follows:

- popup: create the initial workspace before opening the grid;
- grid: render state and send completed UI-state changes through its dedicated Port;
- service worker: serialize all active workspace mutations, navigation history changes, closed/open lifecycle changes, and persistence;
- workspace-store module: validation, history mutation helpers, storage access, schema handling, retention cleanup.

The service worker maintains a per-workspace mutation queue so two events for the same workspace cannot read the same old snapshot and overwrite each other.

The grid does not directly replace the durable workspace record after registration.

## Launch flow

Current popup launches rely on transient `chrome.storage.session` values. The new flow persists a workspace first:

```text
popup
  -> normalize 2..9 URLs
  -> create workspaceId
  -> create initial snapshot
  -> persist snapshot
  -> open grid.html?workspace=<workspaceId>
```

Each initial pane starts with one retained history entry and index 0.

Transient launch storage can remain temporarily as a migration/fallback path, but Ctrl+Shift+T restoration must depend on the workspace record, not `launchUrls`.

## Grid startup

The grid parses `workspace` from its own URL and opens its dedicated background Port.

The first workspace registration request includes that workspace ID. The service worker:

1. validates and loads the workspace;
2. verifies whether another live tab already owns it;
3. marks it active for the current tab;
4. clears `closedAt`;
5. returns the normalized snapshot to the grid.

The grid then restores stable pane IDs, pane URLs at their current history indices, layout sizes, control positions, active pane, and agreed UI state.

If the workspace record is missing or unrecoverably invalid, create a fresh safe workspace rather than leaving a broken grid.

## Duplicate live-tab handling

The same workspace record must never be mutated simultaneously by two live outer tabs.

If `grid.html?workspace=X` opens while workspace X is already owned by another live grid tab, clone X into a new workspace UUID and rewrite the duplicate tab to that new workspace ID.

A Ctrl+Shift+T restore does not clone because the original workspace no longer has a live owner.

## Reliable pane/frame identity in every mode

History capture must work when Enhanced Mode is off, so pane identity cannot depend on same-host script injection.

Each pane iframe starts on an extension-owned bootstrap URL containing only opaque IDs:

```text
pane-bootstrap.html?workspace=<workspace-id>&pane=<pane-id>
```

The remote target URL is not placed in the bootstrap query string.

Flow:

1. grid creates the iframe with the bootstrap URL;
2. service worker observes the extension-owned direct-child navigation and binds `tabId + frameId` to `workspaceId + paneId`;
3. bootstrap announces readiness to the parent grid;
4. grid sends the intended target URL to the bootstrap via a same-extension message/postMessage;
5. bootstrap uses `location.replace(target)` so the bootstrap page itself does not become retained pane history;
6. subsequent navigations keep the frame binding for that pane.

Only direct children of the grid (`parentFrameId === 0`) can become pane bindings. Nested site iframes are ignored.

Existing Enhanced Mode may add document metadata when permission is available, but basic pane history never requires host injection.

## Navigation tracking

The extension already declares `webNavigation`. The service worker records navigation for bound direct-pane frames.

Use:

- `webNavigation.onCommitted` for normal document navigations;
- `webNavigation.onHistoryStateUpdated` for SPA History API URL changes;
- `webNavigation.onReferenceFragmentUpdated` for same-document fragment changes.

Load/error events may update pane status but must not create retained history entries by themselves.

### Normalization and duplicate suppression

The recorder normalizes URLs before changing retained history.

Do not append another retained entry when the new URL equals the current retained URL because of reloads or multiple Chrome events representing one logical navigation.

Redirect handling must settle on the effective committed URL without growing the retained stack through duplicate consecutive entries.

### Traversal intent

Focus-managed Back/Forward sends a traversal request for the target pane to the service worker before navigation.

The request identifies the expected target index and URL. When the matching navigation arrives, the service worker updates `historyIndex` instead of appending a new history entry.

An unexpected navigation cancels the traversal intent and is recorded as a normal new navigation.

## Universal Back/Forward controls

Back/Forward becomes a retained-workspace capability rather than an Enhanced-Mode-only capability.

Buttons are enabled based on the retained history index. Navigation may reload the stored URL; the persisted URL stack, not the destroyed iframe's native history stack, is authoritative for post-restore behavior.

Enhanced Mode may still provide richer same-host behavior, but it cannot be required for retained history.

## Snapshot update rules

Persist meaningful completed state changes, coalesced with a short debounce where appropriate.

Persist after:

- committed pane navigation;
- SPA/history URL change;
- history-index change;
- pane add/remove;
- splitter resize completion;
- pane-control drag completion;
- active-pane change;
- floating control move completion;
- floating-panel open/close;
- enhanced opt-in change;
- compatibility-mode change.

Never persist every pointer-move or resize-preview event.

`beforeunload` may request one final best-effort flush, but correctness cannot depend on it. Normal completed interactions and navigation events must already be durable.

## Service-worker suspension and frame recovery

Manifest V3 service workers can suspend. Persist lightweight live frame bindings in `chrome.storage.session`:

```text
outerTabId -> workspaceId -> paneId -> frameId/documentId/currentUrl
```

After service-worker startup/wake:

1. reload session bindings;
2. validate live outer grid tabs;
3. validate stored frame IDs with `webNavigation.getAllFrames()` where needed;
4. discard stale bindings;
5. notify the owning grid Port of unresolved panes.

If a pane binding cannot be recovered, reload only that pane through the extension bootstrap at its current retained URL to establish a new frame binding.

Loss of in-memory worker state must not lose the durable workspace snapshot.

## Closed workspace lifecycle

The service worker maintains `tabId -> workspaceId` for active grid tabs.

On registration:

- set `activeTabId`;
- clear `closedAt`;
- update `lastSeenAt`.

On `tabs.onRemoved` for a known grid tab:

- set `activeTabId = null`;
- set `closedAt = Date.now()`;
- persist index metadata;
- run retention cleanup.

If Chrome exits or crashes before this event is observed, startup reconciliation queries currently open grid tabs. A workspace marked active with no matching live grid tab is converted to a closed record using its last-seen/reconciliation time.

When Chrome later restores the outer URL with Ctrl+Shift+T, the same workspace becomes active again.

## Compatibility mode restore

Compatibility mode uses session DNR rules scoped to an outer tab ID. A restored tab gets a new tab ID, so its previous rule cannot simply be reused.

If the workspace says Compatibility was On and the required permission is still granted, recreate the session DNR rule for the new outer tab ID.

If permission is no longer granted, restore all workspace state but show Compatibility Off. Do not prompt for permission without a user gesture.

## Enhanced mode restore

Persist the workspace's enhanced opt-in hostname.

On restore, Enhanced Mode may reactivate only when:

- current pane URLs still satisfy exact-host eligibility;
- the saved opt-in hostname matches;
- the required host permission is still granted.

Otherwise restore in basic mode without losing pane/history state.

## Corruption and schema handling

All workspace records are validated before use.

Recovery order:

1. preserve a workspace when safe;
2. discard only malformed fields/panes where possible;
3. preserve each pane's valid current URL;
4. clamp invalid history indices;
5. cap excessive history to 50 entries;
6. reject unsupported future schema versions instead of guessing their meaning.

If no valid panes remain, create a safe default workspace rather than crashing the grid.

## Security and privacy

Persisted URLs may be sensitive.

Requirements:

- store only URL/navigation metadata needed for restoration;
- never store page bodies, credentials, cookies, authorization headers, DOM text, or form values;
- never put pane URLs/history in the outer grid query string;
- bootstrap query strings contain only workspace/pane IDs, not target URLs;
- retain at most 50 entries per pane and 20 closed workspaces;
- enforce the 6 MiB soft workspace budget;
- do not add `unlimitedStorage`;
- do not broaden optional host permissions for this feature.

## Testing strategy

### Unit tests

Cover:

- workspace schema validation;
- 50-entry cap and index adjustment;
- backward/forward traversal;
- forward-branch truncation;
- duplicate/reload suppression;
- SPA and fragment history mutation;
- malformed-record recovery;
- 20-closed-workspace cleanup;
- active-workspace protection;
- byte-budget cleanup ordering;
- serialized per-workspace mutation ordering;
- clone behavior for duplicate live workspace URLs.

### Static integration tests

Cover:

- popup creates a workspace before opening grid;
- outer grid URL contains only a workspace UUID;
- stable pane IDs restore;
- bootstrap URL contains no target URL;
- bootstrap uses `location.replace()` after receiving its target;
- only direct child frames register as panes;
- committed/history-state/fragment navigation listeners are present;
- tab-close lifecycle updates closed metadata;
- grid Port routing is workspace-scoped;
- compatibility rules rebind to restored tab IDs;
- `unlimitedStorage` is not added.

### Manual Chrome acceptance checklist

1. Open two panes, navigate several URLs in each, resize the split, move controls, close the outer tab, press Ctrl+Shift+T, and confirm the workspace restores.
2. Confirm Back/Forward traverses retained URLs from before closure.
3. Repeat with nine panes.
4. Exceed 50 URLs in one pane and confirm the oldest entries are removed.
5. Go Back then navigate somewhere new; confirm the prior forward branch disappears.
6. Reload repeatedly and confirm retained history does not grow.
7. Confirm SPA `pushState` and fragment changes are recorded once each.
8. Restore mixed-host/basic-mode panes and confirm retained history still works.
9. Restore an eligible enhanced same-host workspace with permission still granted.
10. Remove enhanced host permission before restore and confirm safe basic-mode fallback.
11. Restore Compatibility mode and confirm its DNR rule binds to the new tab ID.
12. Restart the service worker while a workspace is open and confirm frame tracking recovers.
13. Keep multiple Focus workspaces open, close/restore one, and confirm the others are unchanged.
14. Duplicate a live workspace URL and confirm the duplicate receives a cloned workspace UUID.
15. Create more than 20 closed workspaces and confirm oldest closed records are removed while active records remain.

## Acceptance criteria

The feature is complete when:

- Ctrl+Shift+T restores the same Focus workspace by stable workspace ID;
- every pane returns to its current retained URL;
- Back/Forward URL history survives close/restore for up to 50 entries per pane;
- layout and agreed Focus UI state restore;
- history tracking works in mixed-host/basic mode without host injection;
- repeated close/restore cycles do not duplicate workspace records;
- no more than 20 closed workspaces are retained;
- workspace-record storage stays under the 6 MiB soft budget where cleanup can achieve that without deleting active workspaces;
- service-worker suspension does not permanently break pane tracking;
- multiple workspaces remain isolated;
- no page content or credentials are persisted.
