/**
 * The NEAR wallet picker: the WAI-ARIA APG "select-only combobox" (a focusable combobox element
 * and a listbox popup), so the list is styled by the page instead of drawn as an OS menu. The
 * options are fixed here; the chosen value is still validated where it is used (login-wallet.ts).
 */

export interface WalletOption {
  /** Element id of the option in the page shell. */
  id: string;
  value: string;
  label: string;
}
export const WALLET_OPTIONS: readonly WalletOption[] = [
  { id: 'near-wallet-meteor', value: 'meteor-wallet', label: 'Meteor Wallet' },
  { id: 'near-wallet-hot', value: 'hot-wallet', label: 'HOT Wallet' },
];

export interface PickerState {
  open: boolean;
  /** The highlighted option while open. */
  active: number;
  selected: number;
}

/** The next enabled option from `from` in `step` direction, or `from` when there is none. */
function move(from: number, step: 1 | -1, disabled: readonly boolean[]): number {
  for (let i = from + step; i >= 0 && i < disabled.length; i += step) if (!disabled[i]) return i;
  return from;
}
const first = (disabled: readonly boolean[]) => move(-1, 1, disabled);
const last = (disabled: readonly boolean[]) => move(disabled.length, -1, disabled);

/**
 * One key on the combobox. Returns the next state, or undefined when the key is not handled.
 * Closed: ArrowDown/ArrowUp/Enter/Space open on the selection, Home/End open on the first/last.
 * Open: arrows, Home and End move; Enter, Space and Tab choose an enabled option; Escape closes.
 */
export function pickerKey(
  s: PickerState,
  key: string,
  disabled: readonly boolean[],
): PickerState | undefined {
  if (!s.open) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(key))
      return { ...s, open: true, active: s.selected };
    if (key === 'Home') return { ...s, open: true, active: first(disabled) };
    if (key === 'End') return { ...s, open: true, active: last(disabled) };
    return undefined;
  }
  if (key === 'ArrowDown') return { ...s, active: move(s.active, 1, disabled) };
  if (key === 'ArrowUp') return { ...s, active: move(s.active, -1, disabled) };
  if (key === 'Home') return { ...s, active: first(disabled) };
  if (key === 'End') return { ...s, active: last(disabled) };
  if (key === 'Escape') return { ...s, open: false };
  if (key === 'Enter' || key === ' ' || key === 'Tab')
    return {
      ...s,
      open: false,
      selected: disabled[s.active] ? s.selected : s.active,
    };
  return undefined;
}

/** Binds the picker to the page shell: `#near-wallet` (combobox) and `#near-wallet-list` (listbox). */
export function walletPicker(doc: Document, onChange: () => void) {
  const combo = doc.getElementById('near-wallet') as HTMLElement;
  const list = doc.getElementById('near-wallet-list') as HTMLElement;
  const label = doc.getElementById('near-wallet-value') as HTMLElement;
  const options = WALLET_OPTIONS.map((o) => doc.getElementById(o.id) as HTMLElement);
  const disabled = WALLET_OPTIONS.map(() => false);
  let state: PickerState = { open: false, active: 0, selected: 0 };
  let locked = false;

  const render = () => {
    combo.setAttribute('aria-expanded', String(state.open));
    combo.setAttribute('aria-disabled', String(locked));
    list.hidden = !state.open;
    if (state.open)
      combo.setAttribute('aria-activedescendant', WALLET_OPTIONS[state.active]?.id ?? '');
    else combo.removeAttribute('aria-activedescendant');
    options.forEach((o, i) => {
      o.setAttribute('aria-selected', String(i === state.selected));
      o.setAttribute('aria-disabled', String(disabled[i]));
      o.className = `option${i === state.active && state.open ? ' active' : ''}`;
    });
    label.textContent = WALLET_OPTIONS[state.selected]?.label ?? '';
  };
  const update = (next: PickerState) => {
    const changed = next.selected !== state.selected;
    state = next;
    render();
    if (changed) onChange();
  };
  combo.onkeydown = (e: KeyboardEvent) => {
    if (locked) return;
    const next = pickerKey(state, e.key, disabled);
    if (!next) return;
    if (e.key !== 'Tab') e.preventDefault();
    update(next);
  };
  combo.onclick = () => {
    if (!locked) update({ ...state, open: !state.open, active: state.selected });
  };
  options.forEach((o, i) => {
    o.onclick = () => {
      if (locked || disabled[i]) return;
      update({ open: false, active: i, selected: i });
      combo.focus();
    };
  });
  // Close on any press outside the picker.
  doc.addEventListener?.('pointerdown', (e: Event) => {
    const target = e.target as Node | null;
    if (state.open && !combo.contains(target) && !list.contains(target))
      update({ ...state, open: false });
  });
  render();

  return {
    value: (): string => WALLET_OPTIONS[state.selected]?.value ?? '',
    /** Disable one option, e.g. HOT Wallet off mainnet. The selection is kept and refused on use. */
    setDisabled(value: string, off: boolean) {
      const i = WALLET_OPTIONS.findIndex((o) => o.value === value);
      if (i >= 0) disabled[i] = off;
      render();
    },
    /** While a wallet is open or the request is finished, the choice cannot change. */
    setLocked(on: boolean) {
      locked = on;
      if (on) state = { ...state, open: false };
      render();
    },
  };
}
