import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { signingRequest } from '../node/signing.js';
import { pageElements, renderSummary, showStatus } from './login-dom.js';
import { STATUS } from './login-status.js';
import { describeRequest, technicalDetails } from './login-view.js';

/** An element that records text and refuses any markup assignment. */
class Element {
  textContent = '';
  className = '';
  hidden = true;
  children: Element[] = [];
  attributes = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  constructor(readonly tag: string) {}
  set innerHTML(_: string) {
    throw new Error('markup assignment');
  }
  set outerHTML(_: string) {
    throw new Error('markup assignment');
  }
  insertAdjacentHTML() {
    throw new Error('markup assignment');
  }
  append(...c: Element[]) {
    this.children.push(...c);
  }
  replaceChildren(...c: Element[]) {
    this.children = c;
  }
}
const page = () => {
  const ids = new Map<string, Element>();
  const doc = {
    getElementById: (id: string) => {
      if (!ids.has(id)) ids.set(id, new Element(id));
      return ids.get(id);
    },
    createElement: (tag: string) => new Element(tag),
  } as unknown as Document;
  return { doc, ids };
};
const texts = (e: Element): string[] => [e.textContent, ...e.children.flatMap(texts)];

it('renders hostile request values only as text', () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const q = signingRequest('near.nep413', 'near:mainnet', `${hostile}.near`, {
    message: hostile,
    recipient: hostile,
    nonce: Array(32).fill(7),
  });
  const { doc, ids } = page();
  const el = pageElements(doc);
  const expiry = renderSummary(doc, el, describeRequest(q), technicalDetails(q));
  expect(ids.get('message')?.textContent).toBe(hostile);
  const rows = texts(ids.get('rows') as Element);
  expect(rows).toContain(`${hostile}.near`);
  expect(rows).toContain(hostile);
  expect(ids.get('action')?.textContent).toContain(`0x${'07'.repeat(32)}`);
  expect(ids.get('summary')?.hidden).toBe(false);
  expect(ids.get('terms-box')?.hidden).toBe(true);
  expect(expiry.textContent).toBe('');
  expect((expiry as unknown as Element).tag).toBe('dd');
  showStatus(el, STATUS.signed);
  expect(ids.get('status')?.textContent).toBe(STATUS.signed.text);
  expect(ids.get('status')?.className).toBe('status ok');
});

it('shows warnings and the payment headline for a payment request', () => {
  const q = signingRequest('near.signTransaction', 'near:mainnet', 'buyer.near', {
    receiverId: 'unknown-token.near',
    method: 'ft_transfer_call',
    args: { receiver_id: 'annon.near', amount: '5', msg: '' },
    gas: '150000000000000',
    deposit: '1',
  });
  const { doc, ids } = page();
  renderSummary(doc, pageElements(doc), describeRequest(q), technicalDetails(q));
  expect(ids.get('amount')?.textContent).toBe('5 base units of unknown-token.near');
  expect(ids.get('amount')?.hidden).toBe(false);
  expect(ids.get('warnings')?.hidden).toBe(false);
  expect(texts(ids.get('warnings') as Element).join(' ')).toContain('does not recognise');
});

it('page modules never parse markup', async () => {
  for (const file of [
    'login.ts',
    'login-dom.ts',
    'login-view.ts',
    'login-terms.ts',
    'login-format.ts',
    'login-status.ts',
    'login-wallet.ts',
  ]) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    expect(source, file).not.toMatch(
      /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/,
    );
  }
});
