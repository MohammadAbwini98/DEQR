/**
 * DEQR boot watchdog and recovery.
 *
 * This file exists because of one hard constraint: the failure it recovers from
 * is the application module failing to load. Recovery therefore cannot live in
 * that module, and the page's CSP is `script-src 'self'` with no
 * `unsafe-inline`, so it cannot be an inline script either. It is a separate
 * classic script with a stable, unhashed URL, so a stale `index.html` still
 * loads a working copy of it.
 *
 * The failure it exists for: a cached shell referencing build assets that the
 * host no longer has. The document is served from the service worker's cache,
 * its `/assets/index-OLDHASH.js` is gone, the module never executes, and
 * `#root` stays empty forever — a permanent white page that survives every
 * redeploy, because the document never reaches the network again.
 *
 * Recovery is deliberately narrow: unregister DEQR's own workers, delete only
 * caches this app named, and reload exactly once. A second failure shows a
 * diagnostic instead of reloading again, so a persistent fault cannot become a
 * reload loop.
 */
(function () {
  'use strict';

  var MOUNT_DEADLINE_MS = 8000;
  var RECOVERY_FLAG = 'deqr-boot-recovery';
  var stages = [];
  var settled = false;
  var timer = null;

  function record(name, detail) {
    stages.push({ stage: name, atMs: Math.round(performance.now()), detail: detail || null });
  }

  function summary() {
    return stages.map(function (entry) {
      return entry.stage + '@' + entry.atMs + 'ms' + (entry.detail ? ' (' + entry.detail + ')' : '');
    }).join('\n');
  }

  /** Only caches this application created, and only DEQR's own workers. */
  function purge() {
    var jobs = [];
    if (window.caches && caches.keys) {
      jobs.push(caches.keys().then(function (keys) {
        return Promise.all(keys.filter(function (key) {
          return key.indexOf('deqr-') === 0;
        }).map(function (key) {
          return caches.delete(key);
        }));
      }));
    }
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then(function (registrations) {
        return Promise.all(registrations.map(function (registration) {
          return registration.unregister();
        }));
      }));
    }
    // A failed purge must still reach the reload: a browser that refuses cache
    // access is exactly the case where retrying from the network can help.
    return Promise.all(jobs).catch(function () { return null; });
  }

  function diagnose(reason) {
    var root = document.getElementById('root');
    if (!root) return;
    var detail = document.createElement('pre');
    detail.className = 'boot-failure-detail';
    detail.textContent = 'Stage: ' + reason + '\n' + summary();

    var title = document.createElement('h1');
    title.textContent = "DEQR couldn't start";
    var copy = document.createElement('p');
    copy.textContent = 'Recovery was already attempted once in this tab, so it was not retried automatically. '
      + 'Check that the sender is running, then reload.';

    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'primary';
    retry.textContent = 'Clear cache and reload';
    retry.addEventListener('click', function () {
      sessionStorage.removeItem(RECOVERY_FLAG);
      purge().then(function () { location.reload(); });
    });

    var wrapper = document.createElement('div');
    wrapper.className = 'boot-failure';
    wrapper.appendChild(title);
    wrapper.appendChild(copy);
    wrapper.appendChild(retry);
    wrapper.appendChild(detail);
    root.textContent = '';
    root.appendChild(wrapper);
  }

  function fail(reason) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);

    var attempted;
    try {
      attempted = sessionStorage.getItem(RECOVERY_FLAG) === '1';
    } catch (error) {
      // Private Browsing can throw on sessionStorage. Treat it as "already
      // attempted" rather than risking an unbounded reload loop.
      attempted = true;
    }

    if (attempted) {
      diagnose(reason);
      return;
    }

    try { sessionStorage.setItem(RECOVERY_FLAG, '1'); } catch (error) { /* handled above */ }
    record('BOOT_RECOVERY', reason);
    purge().then(function () { location.reload(); });
  }

  record('BOOT_HTML');

  window.__deqrBoot = {
    stages: stages,
    /** Called by the application module as it passes each startup stage. */
    stage: function (name, detail) {
      record(name, detail);
      if (name === 'BOOT_REACT_MOUNT') {
        settled = true;
        if (timer) clearTimeout(timer);
        try { sessionStorage.removeItem(RECOVERY_FLAG); } catch (error) { /* nothing to clear */ }
      }
    },
    /** Called when a startup step throws after the module itself loaded. */
    fail: fail,
    report: summary,
  };

  // A module that 404s or fails its MIME check fires `error` on the element
  // and never runs, so this is the only place the condition is observable.
  window.addEventListener('error', function (event) {
    var target = event.target;
    if (target && target !== window && (target.tagName === 'SCRIPT' || target.tagName === 'LINK')) {
      fail('ASSET_LOAD_FAILED:' + (target.src || target.href || 'unknown'));
    }
  }, true);

  // Backstop for every other way the shell can fail to mount, including a
  // module that loads but throws before render.
  timer = setTimeout(function () { fail('MOUNT_TIMEOUT'); }, MOUNT_DEADLINE_MS);
})();
