/**
 * Puts a request summary and status on the approval page. Every value is set with `textContent`;
 * this module never parses markup.
 */

import type { Status } from './login-status.js';
import type { Row, Summary } from './login-view.js';

const IDS = [
  'title',
  'pair',
  'summary',
  'amount',
  'rows',
  'message-box',
  'message-label',
  'message',
  'terms-box',
  'terms',
  'warnings',
  'note',
  'wallet-field',
  'approve',
  'status',
  'action',
] as const;
export type PageElements = Record<(typeof IDS)[number], HTMLElement>;

export function pageElements(doc: Document): PageElements {
  return Object.fromEntries(
    IDS.map((id) => [id, doc.getElementById(id) as HTMLElement]),
  ) as PageElements;
}

function rows(doc: Document, target: HTMLElement, list: readonly Row[]): HTMLElement[] {
  const values = list.map((r) => {
    const row = doc.createElement('div');
    const dt = doc.createElement('dt');
    const dd = doc.createElement('dd');
    row.className = 'row';
    dt.textContent = r.label;
    dd.textContent = r.value;
    if (r.mono) dd.className = 'mono';
    row.append(dt, dd);
    return [row, dd] as const;
  });
  target.replaceChildren(...values.map(([row]) => row));
  return values.map(([, dd]) => dd);
}

/** Shows one request. Returns the element the caller updates with the time left. */
export function renderSummary(
  doc: Document,
  el: PageElements,
  s: Summary,
  technical: string,
): HTMLElement {
  el.title.textContent = s.title;
  el.amount.textContent = s.amount ?? '';
  el.amount.hidden = !s.amount;
  const dds = rows(doc, el.rows, [...s.rows, { label: 'Expires', value: '' }]);
  el['message-box'].hidden = !s.message;
  el['message-label'].textContent = s.message?.label ?? '';
  el.message.textContent = s.message?.text ?? '';
  el['terms-box'].hidden = s.terms.length === 0;
  rows(doc, el.terms, s.terms);
  el.warnings.replaceChildren(
    ...s.warnings.map((w) => {
      const li = doc.createElement('li');
      li.textContent = w;
      return li;
    }),
  );
  el.warnings.hidden = s.warnings.length === 0;
  el.note.textContent = s.note;
  el.action.textContent = technical;
  el.summary.hidden = false;
  return dds[dds.length - 1] as HTMLElement;
}

export function showStatus(el: PageElements, status: Status): void {
  el.status.textContent = status.text;
  el.status.className = `status ${status.tone}`;
}
