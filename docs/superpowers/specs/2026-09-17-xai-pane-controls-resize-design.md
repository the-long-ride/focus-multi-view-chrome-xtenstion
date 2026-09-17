# xAI Pane Controls and Resize Design

## Goal

Restyle the extension around the supplied xAI design language, move pane chrome into compact draggable controls that do not permanently cover website UI, and reduce resize jank by deferring expensive grid relayout until the resize gesture completes.

## Pane controls

Each pane owns a draggable floating control pill positioned inside its viewport. The compact state shows a grip and pane index. Hover or keyboard focus expands the same pill to expose the address field, refresh, and close actions. The grip is the only drag handle so text editing does not move the bar. The pill position is clamped to the pane bounds during drag and whenever the pane is resized. Pane control positions are runtime-only because panes are ephemeral and may be reordered or removed.

The iframe remains absolute and fills the pane. Pane controls overlay the iframe rather than reserving layout space.

## Resize performance

Splitters use pointer events and one shared resize controller. Pointer movement updates only a transform on the splitter preview, scheduled through requestAnimationFrame. The grid-template columns/rows and iframe sizes remain unchanged while dragging. On pointer release, the final delta is converted to fractional track sizes and committed once.

While resizing, iframe pointer events are disabled to keep pointer handling stable across embedded sites. Minimum track size remains 120 px.

## xAI visual system

Use the supplied xAI design guidance as the source of truth: near-black #0a0a0a canvas, white primary text, #191919 cards, #212327 hairlines, weight-400 typography, tracked mono labels, pill-shaped controls, 8 px cards, and no shadows. Inter/system sans and ui-monospace are used as safe substitutes for proprietary font assets.

The extension becomes dark-only. The previous light/dark toggle and theme persistence are removed.

## Popup and templates

Keep the existing 2–9 pane selector and template CRUD behavior. Restyle the popup, custom listbox, table, modal, inputs, and buttons with xAI tokens. The real manifest version remains visible.

## GitHub delivery

Seed the approved 9-pane baseline into `the-long-ride/focus-multi-view-chrome-xtenstion` main because the repository is empty. Create `feature/xai-draggable-pane-controls`, apply this design there, verify tests and syntax, and open a pull request to main.
