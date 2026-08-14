import webpush from 'web-push';

/**
 * Telling you a session wants attention when you are not looking at the tab.
 *
 * Delivery is tiered by what the browser will allow. Over plain HTTP the page can
 * still flash its title, chime, and badge the sidebar. Real notifications and Web Push
 * need a secure context, which `tailscale serve` supplies with a genuine certificate
 * on the ts.net name. The tiering lives here so callers never have to care.
 */

export function ensureVapid(config) {
  if (config.vapid?.publicKey && config.vapid?.privateKey) return config.vapid;
  config.vapid = webpush.generateVAPIDKeys();
  return config.vapid;
}

export class Notifier {
  constructor({ config, persist = () => {}, subject = 'mailto:porthole@localhost', log = () => {} }) {
    this.config = config;
    this.persist = persist;
    this.log = log;

    const vapid = ensureVapid(config);
    webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);

    if (!Array.isArray(config.pushSubscriptions)) config.pushSubscriptions = [];
  }

  get publicKey() {
    return this.config.vapid.publicKey;
  }

  get subscriptions() {
    return this.config.pushSubscriptions;
  }

  subscribe(subscription, label = 'unknown') {
    if (!subscription?.endpoint) return false;
    const existing = this.subscriptions.findIndex((s) => s.subscription.endpoint === subscription.endpoint);
    const record = { label, subscription, createdAt: Date.now() };
    if (existing === -1) this.subscriptions.push(record);
    else this.subscriptions[existing] = record;
    this.persist();
    return true;
  }

  unsubscribe(endpoint) {
    const before = this.subscriptions.length;
    this.config.pushSubscriptions = this.subscriptions.filter((s) => s.subscription.endpoint !== endpoint);
    if (this.config.pushSubscriptions.length !== before) this.persist();
    return this.config.pushSubscriptions.length !== before;
  }

  /** A subscription the push service rejects as gone is pruned, not retried forever. */
  async send(payload) {
    const body = JSON.stringify(payload);
    const dead = [];

    await Promise.all(
      this.subscriptions.map(async (record) => {
        try {
          await webpush.sendNotification(record.subscription, body);
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) dead.push(record.subscription.endpoint);
          else this.log(`push failed for ${record.label}: ${err.message}`);
        }
      }),
    );

    for (const endpoint of dead) this.unsubscribe(endpoint);
    return { sent: this.subscriptions.length, pruned: dead.length };
  }
}

/**
 * Fallback for sessions whose settings were overridden and therefore never fire the
 * hooks. Quiet for long enough, after having been busy, means Claude is probably
 * waiting rather than working.
 */
export function looksIdle(session, { thresholdMs = 45_000, now = Date.now() } = {}) {
  if (!session?.alive) return false;
  if (session.lastActivityAt == null) return false;
  return now - session.lastActivityAt >= thresholdMs;
}
