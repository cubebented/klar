    (() => {
      const isDev =
        (location.protocol === 'http:' || location.protocol === 'https:') &&
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
      if (!isDev) return;

      let sig = null;
      const url = location.pathname || '/';

      async function check() {
        try {
          const r = await fetch(url + '?_lr=' + Date.now(), {
            method: 'HEAD',
            cache: 'no-store',
          });
          const next =
            r.headers.get('etag') ||
            r.headers.get('last-modified') ||
            r.headers.get('content-length') ||
            '';
          if (sig !== null && next && next !== sig) {
            location.reload();
            return;
          }
          if (next) sig = next;
        } catch (_) { /* server restarting — ignore */ }
      }

      check();
      setInterval(check, 800);
    })();
