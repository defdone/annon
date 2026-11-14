import { describe, expect, it, vi } from 'vitest';
import { type PickerState, pickerKey, walletPicker } from './login-dropdown.js';

const closed: PickerState = { open: false, active: 0, selected: 0 };
const none = [false, false];

describe('picker keys', () => {
  it('opens on arrows, Enter and Space with the selection active; Home and End pick an edge', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', ' '])
      expect(pickerKey({ ...closed, selected: 1 }, key, none)).toEqual({
        open: true,
        active: 1,
        selected: 1,
      });
    expect(pickerKey(closed, 'End', none)).toEqual({ open: true, active: 1, selected: 0 });
    expect(pickerKey({ ...closed, selected: 1 }, 'Home', none)).toMatchObject({ active: 0 });
    expect(pickerKey(closed, 'a', none)).toBeUndefined();
    expect(pickerKey(closed, 'Escape', none)).toBeUndefined();
  });

  it('moves within bounds, skips disabled options and chooses only an enabled one', () => {
    const open = { open: true, active: 0, selected: 0 };
    expect(pickerKey(open, 'ArrowDown', none)).toMatchObject({ active: 1 });
    expect(pickerKey({ ...open, active: 1 }, 'ArrowDown', none)).toMatchObject({ active: 1 });
    expect(pickerKey(open, 'ArrowUp', none)).toMatchObject({ active: 0 });
    expect(pickerKey(open, 'ArrowDown', [false, true])).toMatchObject({ active: 0 });
    expect(pickerKey(open, 'End', [false, true])).toMatchObject({ active: 0 });
    expect(pickerKey({ ...open, active: 1 }, 'Enter', none)).toEqual({
      open: false,
      active: 1,
      selected: 1,
    });
    expect(pickerKey({ ...open, active: 1 }, ' ', [false, true])).toMatchObject({ selected: 0 });
    expect(pickerKey({ ...open, active: 1 }, 'Tab', none)).toMatchObject({
      open: false,
      selected: 1,
    });
    expect(pickerKey({ ...open, active: 1 }, 'Escape', none)).toEqual({
      open: false,
      active: 1,
      selected: 0,
    });
  });
});

class Element {
  textContent = '';
  className = '';
  hidden = false;
  attributes = new Map<string, string>();
  onkeydown?: (e: { key: string; preventDefault(): void }) => void;
  onclick?: () => void;
  focus = vi.fn();
  constructor(readonly id: string) {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  contains(other: unknown) {
    return other === this;
  }
}
function page() {
  const ids = new Map<string, Element>();
  const listeners: ((e: { target: unknown }) => void)[] = [];
  const get = (id: string) => {
    if (!ids.has(id)) ids.set(id, new Element(id));
    return ids.get(id) as Element;
  };
  const doc = {
    getElementById: get,
    addEventListener: (_: string, fn: (e: { target: unknown }) => void) => listeners.push(fn),
  } as unknown as Document;
  const onChange = vi.fn();
  const picker = walletPicker(doc, onChange);
  const press = (key: string) => {
    const preventDefault = vi.fn();
    get('near-wallet').onkeydown?.({ key, preventDefault });
    return preventDefault;
  };
  const outside = () => {
    for (const fn of listeners) fn({ target: {} });
  };
  return { get, picker, press, onChange, outside };
}

describe('wallet picker', () => {
  it('starts on Meteor Wallet with closed, labelled ARIA state', () => {
    const { get, picker } = page();
    expect(picker.value()).toBe('meteor-wallet');
    expect(get('near-wallet-value').textContent).toBe('Meteor Wallet');
    expect(get('near-wallet').attributes.get('aria-expanded')).toBe('false');
    expect(get('near-wallet').attributes.has('aria-activedescendant')).toBe(false);
    expect(get('near-wallet-list').hidden).toBe(true);
    expect(get('near-wallet-meteor').attributes.get('aria-selected')).toBe('true');
    expect(get('near-wallet-hot').attributes.get('aria-selected')).toBe('false');
  });

  it('chooses with the keyboard and tracks the active option', () => {
    const { get, picker, press, onChange } = page();
    expect(press('ArrowDown')).toHaveBeenCalled();
    expect(get('near-wallet').attributes.get('aria-expanded')).toBe('true');
    expect(get('near-wallet-list').hidden).toBe(false);
    expect(get('near-wallet').attributes.get('aria-activedescendant')).toBe('near-wallet-meteor');
    press('End');
    expect(get('near-wallet').attributes.get('aria-activedescendant')).toBe('near-wallet-hot');
    expect(get('near-wallet-hot').className).toBe('option active');
    press('Enter');
    expect(picker.value()).toBe('hot-wallet');
    expect(get('near-wallet-value').textContent).toBe('HOT Wallet');
    expect(get('near-wallet-hot').attributes.get('aria-selected')).toBe('true');
    expect(get('near-wallet-list').hidden).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    // Escape closes without changing the choice; an unhandled key is left to the browser.
    press(' ');
    press('Home');
    press('Escape');
    expect(picker.value()).toBe('hot-wallet');
    expect(press('x')).not.toHaveBeenCalled();
  });

  it('a disabled option cannot be chosen by keyboard or click, and keeps its reason', () => {
    const { get, picker, press } = page();
    picker.setDisabled('hot-wallet', true);
    expect(get('near-wallet-hot').attributes.get('aria-disabled')).toBe('true');
    press('ArrowDown');
    press('ArrowDown');
    press('Enter');
    get('near-wallet-hot').onclick?.();
    expect(picker.value()).toBe('meteor-wallet');
    picker.setDisabled('hot-wallet', false);
    get('near-wallet-hot').onclick?.();
    expect(picker.value()).toBe('hot-wallet');
    expect(get('near-wallet').focus).toHaveBeenCalled();
  });

  it('opens on click, closes on an outside press, and ignores input while locked', () => {
    const { get, picker, press, outside } = page();
    get('near-wallet').onclick?.();
    expect(get('near-wallet-list').hidden).toBe(false);
    outside();
    expect(get('near-wallet-list').hidden).toBe(true);
    get('near-wallet').onclick?.();
    picker.setLocked(true);
    expect(get('near-wallet-list').hidden).toBe(true);
    expect(get('near-wallet').attributes.get('aria-disabled')).toBe('true');
    press('ArrowDown');
    press('Enter');
    get('near-wallet').onclick?.();
    get('near-wallet-hot').onclick?.();
    expect(picker.value()).toBe('meteor-wallet');
    expect(get('near-wallet-list').hidden).toBe(true);
  });
});
