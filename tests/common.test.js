const test = require('node:test');
const assert = require('node:assert/strict');

const MPV = require('../common.js');

test('clampFloatingPosition keeps a floating control fully inside the viewport', () => {
  assert.deepEqual(
    MPV.clampFloatingPosition(
      { x: 790, y: -30 },
      { width: 80, height: 40 },
      { width: 800, height: 600 },
      12,
    ),
    { x: 708, y: 12 },
  );
});

test('computeFloatingPanelPosition flips above and left when below-right would overflow', () => {
  assert.deepEqual(
    MPV.computeFloatingPanelPosition(
      { left: 740, top: 540, right: 790, bottom: 590, width: 50, height: 50 },
      { width: 280, height: 220 },
      { width: 800, height: 600 },
      12,
      8,
    ),
    { x: 508, y: 312 },
  );
});

test('normalizeTemplates trims fields, removes invalid records and duplicate ids, and caps at 10', () => {
  const records = Array.from({ length: 12 }, (_, index) => ({
    id: `id-${index}`,
    name: ` Template ${index} `,
    urls: [' example.com ', 'https://openai.com'],
  }));
  records.splice(2, 0, { id: 'id-1', name: 'Duplicate id', urls: ['a.com', 'b.com'] });
  records.splice(3, 0, { id: 'bad', name: ' ', urls: ['only-one.com'] });

  const normalized = MPV.normalizeTemplates(records);
  assert.equal(normalized.length, 10);
  assert.equal(normalized[0].name, 'Template 0');
  assert.deepEqual(normalized[0].urls, ['example.com', 'https://openai.com']);
  assert.equal(normalized.filter((item) => item.id === 'id-1').length, 1);
  assert.equal(normalized.some((item) => item.id === 'bad'), false);
});

test('validateTemplateDraft rejects blank names', () => {
  const result = MPV.validateTemplateDraft('   ', ['a.com', 'b.com'], []);
  assert.equal(result.valid, false);
  assert.match(result.error, /name/i);
});

test('MAX_PANES is 9 and validateTemplateDraft requires between 2 and 9 URLs', () => {
  assert.equal(MPV.MAX_PANES, 9);
  assert.equal(MPV.validateTemplateDraft('One', ['a.com'], []).valid, false);
  assert.equal(MPV.validateTemplateDraft('Nine', Array.from({ length: 9 }, (_, i) => `${i}.example.com`), []).valid, true);
  assert.equal(MPV.validateTemplateDraft('Ten', Array.from({ length: 10 }, (_, i) => `${i}.example.com`), []).valid, false);
  assert.match(MPV.validateTemplateDraft('Ten', Array.from({ length: 10 }, (_, i) => `${i}.example.com`), []).error, /2 to 9 URLs/);
});

test('validateTemplateDraft blocks creating an eleventh template but allows editing at the limit', () => {
  const existing = Array.from({ length: 10 }, (_, index) => ({
    id: `id-${index}`,
    name: `Template ${index}`,
    urls: ['a.com', 'b.com'],
  }));

  assert.equal(MPV.validateTemplateDraft('New', ['a.com', 'b.com'], existing).valid, false);
  assert.equal(MPV.validateTemplateDraft('Edited', ['a.com', 'b.com'], existing, 'id-0').valid, true);
});

test('validateTemplateDraft trims URLs and ignores empty URL rows', () => {
  const result = MPV.validateTemplateDraft(' Work ', [' a.com ', '', ' https://b.com '], []);
  assert.equal(result.valid, true);
  assert.equal(result.name, 'Work');
  assert.deepEqual(result.urls, ['a.com', 'https://b.com']);
});

test('normalizeUrl adds https for domains and uses Google search for plain text', () => {
  assert.equal(MPV.normalizeUrl('example.com'), 'https://example.com');
  assert.equal(MPV.normalizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(MPV.normalizeUrl('hello world'), 'https://www.google.com/search?q=hello%20world');
  assert.equal(MPV.normalizeUrl(''), 'about:blank');
});
