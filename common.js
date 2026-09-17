(function initMultiPaneCommon(global) {
  'use strict';

  const MAX_PANES = 9;
  const MAX_TEMPLATES = 10;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function clampFloatingPosition(position, size, viewport, padding = 12) {
    const maxX = Math.max(padding, viewport.width - size.width - padding);
    const maxY = Math.max(padding, viewport.height - size.height - padding);
    return {
      x: clamp(position.x, padding, maxX),
      y: clamp(position.y, padding, maxY),
    };
  }

  function computeFloatingPanelPosition(triggerRect, panelSize, viewport, padding = 12, gap = 8) {
    let x = triggerRect.left;
    let y = triggerRect.bottom + gap;

    if (x + panelSize.width > viewport.width - padding) x = triggerRect.right - panelSize.width;
    if (y + panelSize.height > viewport.height - padding) y = triggerRect.top - panelSize.height - gap;

    return clampFloatingPosition({ x, y }, panelSize, viewport, padding);
  }

  function normalizeUrl(value) {
    const v = String(value || '').trim();
    if (!v) return 'about:blank';
    if (/^https?:\/\//i.test(v)) return v;
    if (/^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(v)) return `https://${v}`;
    return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
  }

  function cleanUrls(urls) {
    if (!Array.isArray(urls)) return [];
    return urls.map((url) => String(url || '').trim()).filter(Boolean);
  }

  function normalizeTemplates(value) {
    if (!Array.isArray(value)) return [];
    const seenIds = new Set();
    const normalized = [];

    for (const record of value) {
      if (!record || typeof record !== 'object') continue;
      const id = String(record.id || '').trim();
      const name = String(record.name || '').trim();
      const urls = cleanUrls(record.urls);
      if (!id || seenIds.has(id) || !name || urls.length < 2 || urls.length > MAX_PANES) continue;
      seenIds.add(id);
      normalized.push({ id, name, urls });
      if (normalized.length === MAX_TEMPLATES) break;
    }

    return normalized;
  }

  function validateTemplateDraft(name, urls, existingTemplates = [], editingId = null) {
    const cleanName = String(name || '').trim();
    const clean = cleanUrls(urls);
    const existing = normalizeTemplates(existingTemplates);

    if (!cleanName) return { valid: false, name: cleanName, urls: clean, error: 'Template name is required.' };
    if (clean.length < 2 || clean.length > MAX_PANES) {
      return { valid: false, name: cleanName, urls: clean, error: 'A template must contain 2 to 9 URLs.' };
    }
    if (!editingId && existing.length >= MAX_TEMPLATES) {
      return { valid: false, name: cleanName, urls: clean, error: 'You can save up to 10 templates.' };
    }
    if (editingId && !existing.some((template) => template.id === editingId)) {
      return { valid: false, name: cleanName, urls: clean, error: 'The template being edited no longer exists.' };
    }

    return { valid: true, name: cleanName, urls: clean, error: '' };
  }

  const api = {
    MAX_PANES,
    MAX_TEMPLATES,
    clamp,
    clampFloatingPosition,
    computeFloatingPanelPosition,
    normalizeUrl,
    normalizeTemplates,
    validateTemplateDraft,
  };

  global.MPV = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : this));
