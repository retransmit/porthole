/**
 * Who is allowed to type, when several people share one stdin.
 *
 * Default is free-for-all, which is what two people talking to each other actually
 * want. The moment somebody claims the helm it becomes exclusive, so simultaneous
 * typing cannot interleave into nonsense mid-prompt.
 */
export class Helm {
  constructor() {
    /** @type {string|null} */
    this.holder = null;
  }

  /** Unheld means everybody with the control right may type. */
  canType(clientId) {
    return this.holder === null || this.holder === clientId;
  }

  claim(clientId) {
    if (this.holder !== null && this.holder !== clientId) return false;
    this.holder = clientId;
    return true;
  }

  release(clientId) {
    if (this.holder !== clientId) return false;
    this.holder = null;
    return true;
  }

  /** Admin override. Always succeeds. */
  seize(clientId) {
    this.holder = clientId;
    return true;
  }

  /** A holder who vanishes must not leave the session locked for everyone else. */
  disconnect(clientId) {
    if (this.holder !== clientId) return false;
    this.holder = null;
    return true;
  }
}
