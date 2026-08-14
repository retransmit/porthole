/*
  Service worker. Its only job is Web Push, so that a session asking for attention can
  reach you when the tab is closed. Nothing is cached: the panel is useless without a
  live connection to the machine, so a stale offline copy would only mislead.
*/

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: 'Porthole', body: event.data?.text() ?? '' };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title ?? 'Claude is waiting for you', {
      body: payload.body ?? '',
      tag: payload.sessionId ?? 'porthole',
      renotify: true,
      data: { sessionId: payload.sessionId ?? null },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    }),
  );
});
