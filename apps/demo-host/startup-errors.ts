export type StartupReason =
  | 'storage_uninitialized'
  | 'state_missing'
  | 'state_invalid'
  | 'config_invalid';
export class StartupError extends Error {
  readonly reason: StartupReason;
  constructor(reason: StartupReason) {
    super(reason);
    this.name = 'StartupError';
    this.reason = reason;
  }
}
