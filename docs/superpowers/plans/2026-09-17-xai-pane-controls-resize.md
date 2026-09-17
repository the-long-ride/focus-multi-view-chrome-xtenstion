# xAI Pane Controls and Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an xAI-styled, dark-only extension with draggable per-pane controls and low-jank deferred splitter resizing.

**Architecture:** Keep the dependency-free Manifest V3 architecture. Pane controls become per-pane overlay state managed by `grid.js`; splitter resizing uses one pointer controller and requestAnimationFrame preview transforms with a single grid commit on release. Existing popup/template/storage behavior remains intact while the shared theme layer is removed.

**Tech Stack:** Chrome Extension Manifest V3, vanilla HTML/CSS/JavaScript, Chrome storage/tabs/declarativeNetRequest APIs, Node.js `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-17-xai-pane-controls-resize-design.md`

## Global Constraints

- Maximum panes: 9.
- Minimum launch/template URL count: 2.
- Maximum saved templates: 10.
- Preserve compatibility mode and template CRUD behavior.
- No runtime dependencies or proprietary fonts.
- Dark-only xAI-inspired interface.
- Minimum pane track size: 120 px.

---

### Task 1: Lock behavior with failing tests

**Files:**
- Modify: `tests/grid-static.test.js`
- Modify: `tests/popup-static.test.js`
- Modify: `tests/common.test.js`

**Interfaces:**
- Produces: checks for draggable pane controls, deferred resize controller, iframe interaction suppression, dark-only xAI tokens, and removal of theme state.

- [ ] Add failing static tests for `.pane-control`, `.pane-control-grip`, pointer drag handlers, clamping to pane bounds, requestAnimationFrame resize preview, commit-on-release, and `.resizing .pane-iframe { pointer-events: none; }`.
- [ ] Add failing popup tests for xAI colors, pill controls, no `[data-theme]`, and no theme toggle.
- [ ] Add failing common test asserting theme helpers/state are absent.
- [ ] Run `node --test tests/*.test.js` and confirm failures are due to the missing new behavior.

### Task 2: Implement draggable per-pane controls

**Files:**
- Modify: `grid.js`
- Modify: `grid.css`

**Interfaces:**
- Produces: `beginPaneControlDrag`, `movePaneControl`, `endPaneControlDrag`, `clampPaneControl`, compact/expanded pane pill UI.

- [ ] Replace the full-width hover toolbar with a compact floating pane control pill.
- [ ] Add a dedicated grip button/element and pointer capture drag flow.
- [ ] Clamp control position inside its pane on drag and window/pane resize.
- [ ] Keep URL navigation, refresh, close, keyboard focus, and iframe full-viewport behavior.
- [ ] Run `node --test tests/grid-static.test.js` and `node --check grid.js`.

### Task 3: Implement deferred splitter resize

**Files:**
- Modify: `grid.js`
- Modify: `grid.css`

**Interfaces:**
- Produces: shared `resizeDragState`, `beginResize`, `moveResize`, `finishResize`, requestAnimationFrame transform preview, one grid-template commit.

- [ ] Replace per-splitter mouse listeners with delegated pointerdown plus shared pointermove/pointerup controller.
- [ ] Compute valid delta from fractional track weights and the 120 px minimum.
- [ ] Preview only with splitter transform during movement.
- [ ] Commit `colSizes`/`rowSizes` once on release, clear transform/state, and re-clamp pane controls.
- [ ] Disable iframe pointer events while resizing.
- [ ] Run grid tests and syntax checks.

### Task 4: Apply dark-only xAI styling

**Files:**
- Modify: `common.js`
- Modify: `grid.html`
- Modify: `grid.css`
- Modify: `popup.html`
- Modify: `popup.css`
- Modify: `popup.js`

**Interfaces:**
- Produces: xAI token system, dark-only popup/grid, no theme persistence/toggle.

- [ ] Remove shared theme constants/functions/listeners and popup theme toggle markup/logic.
- [ ] Apply `#0a0a0a`, `#191919`, `#212327`, white/muted text, outline pills, 8 px cards, no shadows, weight-400 sans, tracked mono labels.
- [ ] Keep popup selector, template CRUD, version, launch behavior, compatibility controls, and 9-pane limits unchanged.
- [ ] Run all tests and syntax checks.

### Task 5: Seed GitHub baseline and open feature PR

**Files:**
- GitHub repository root sources/tests/docs.

**Interfaces:**
- Produces: populated `main`, feature branch `feature/xai-draggable-pane-controls`, open PR.

- [ ] Verify local full suite and manifest JSON.
- [ ] Seed the pre-xAI 9-pane baseline into empty `main`.
- [ ] Create `feature/xai-draggable-pane-controls` from main.
- [ ] Upload verified redesigned files to the feature branch.
- [ ] Open PR to `main` with test evidence and design summary.
