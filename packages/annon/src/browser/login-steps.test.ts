import { expect, it } from 'vitest';
import { type FakeElement, fakeDocument } from '../../test/login-page.js';
import { pageElements } from './login-dom.js';
import { approvalSteps } from './login-steps.js';

it('collapses the done step and preserves read-only review text alongside the current step', () => {
  const elements = new Map<string, FakeElement>();
  const doc = fakeDocument(elements) as unknown as Document;
  const el = pageElements(doc);
  el.title.textContent = 'Recovery proof';
  el.action.textContent = 'exact proof';
  approvalSteps(doc, el).finish();
  el.title.textContent = 'Transfer';
  const step = elements.get('steps')?.children[0];
  expect(step?.tag).toBe('details');
  expect(step?.attributes.has('open')).toBe(false);
  expect(step?.children[0]?.children.map((e) => e.textContent)).toEqual([
    '✓ Done',
    'Recovery proof',
  ]);
  step?.setAttribute('open', '');
  expect(step?.children[2]?.textContent).toBe('exact proof');
  expect(step?.children.some((e) => e.tag === 'button')).toBe(false);
  expect(el.title.textContent).toBe('Transfer');
});
