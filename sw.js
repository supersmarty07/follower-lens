'use strict';

const CACHE = 'follower-lens-v4-secure-events';
const ASSETS = ['./', './index.html', './app.js', './manifest.json', './icon.svg', './icon-192.png', './icon-512.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('follower-lens-') && key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const scope = new URL(self.registration.scope);

  // Follower Lens never needs cross-origin network access. Block it at the service-worker layer too.
  if (url.origin !== self.location.origin || !url.pathname.startsWith(scope.pathname)) {
    event.respondWith(new Response('Blocked by Follower Lens local-only network policy.', {
      status: 403,
      statusText: 'Blocked'
    }));
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: false });
    if (cached) return cached;

    try {
      const response = await fetch(request, { credentials: 'same-origin', redirect: 'error' });
      if (response.ok && response.type === 'basic') {
        const assetUrl = new URL(request.url);
        const assetNames = new Set(ASSETS.map(path => new URL(path, self.registration.scope).pathname));
        if (assetNames.has(assetUrl.pathname) && !assetUrl.search) {
          const cache = await caches.open(CACHE);
          await cache.put(request, response.clone());
        }
      }
      return response;
    } catch (_) {
      if (request.mode === 'navigate') {
        return (await caches.match('./index.html')) || new Response('Follower Lens is offline.', { status: 503 });
      }
      return new Response('Offline', { status: 503 });
    }
  })());
});
