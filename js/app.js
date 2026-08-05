/* drkr news — a theme-able clone of hckrnews.com
 *
 * Data, in order of preference:
 *  1. hckrnews.com's own feed (/data/latest.js), loaded cross-origin as a
 *     plain <script> since it declares `var entries = [...]`. It holds the
 *     current and previous UTC day and is exactly what the original shows:
 *     only stories that made the HN front page, sorted by the moment they
 *     first got there (the `date` field; `time` is the submission time).
 *  2. For older days (and as a fallback), the HN Algolia API. Front-page
 *     arrival times aren't public, so archived days are approximated:
 *     stories submitted that UTC day with >=20 points, ordered by
 *     submission time. (Fitted against real hckrnews day files, F1 ~0.7.)
 *
 * State (filter, settings, theme, read counts) lives in localStorage.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'drkrnews:v1';
  var FEED = 'https://hckrnews.com/data/latest.js';
  var ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date';
  var TOPSTORIES = 'https://hacker-news.firebaseio.com/v0/topstories.json';
  var ARCHIVE_MIN_POINTS = 20;   // approximation of "made the front page"
  var FALLBACK_MIN_POINTS = 10;  // gentler bar for today/yesterday if the feed is down
  var MAX_DAYS = 14;             // infinite-scroll cap (UTC days)
  var POLL_MS = 4 * 60 * 1000;

  var THEMES = {
    light: ['classic', 'sepia', 'solarized-light'],
    dark: ['drkr', 'dracula', 'nord', 'solarized-dark', 'terminal']
  };

  var DEFAULTS = {
    filter: 'all',
    hackerweb: false,
    newwindow: false,
    // the original shows dead entries on first paint, so that's our default too
    showdead: true,
    mode: 'auto',
    lightTheme: 'classic',
    darkTheme: 'drkr',
    accent: null,
    redirects: {},        // filled in by normalizeRedirects()
    lastVisit: null,
    read: {}
  };
  var STATE_VERSION = 4;

  /* ------------------------------------------------ alternate front ends --- */
  /* Story links can be pointed at a privacy-respecting mirror instead of the
     site itself. The feature is opt-in: nothing is rewritten until the switch
     in settings is on. What it rewrites once it is on is the rule below —
     anything that withholds basic reading from logged-out visitors (`gated` —
     X hides replies, Reddit's mobile site blocks the page outright), and
     nothing else. Two gated services override that with an explicit
     `on: false`; their notes say why.

     A service claims a host when the host equals one of its `hosts` or is a
     subdomain of one, minus anything in `skip`. Where the front end's URL
     shape differs from the original's, `map(url, base, instance)` builds the
     rewrite and may return null to leave a link alone; the default is an
     origin swap that keeps path, query and hash.

     Instance lists were checked on 2026-08-04, but public instances come and
     go constantly — every row has a `custom…` entry, and alt-clicking a
     rewritten link opens the original. */

  var FRONTENDS = [
    {
      id: 'twitter',
      name: 'X / Twitter',
      hosts: ['twitter.com', 'x.com'],
      gated: true,
      note: 'signed-out visitors get the one post and none of the replies',
      instances: ['https://xcancel.com', 'https://nitter.privacyredirect.com',
                  'https://nitter.net', 'https://nitter.tiekoetter.com',
                  'https://lightbrd.com']
    },
    {
      id: 'reddit',
      name: 'Reddit',
      hosts: ['reddit.com', 'redd.it'],
      skip: ['i.redd.it', 'v.redd.it', 'preview.redd.it'],
      gated: true,
      note: 'the mobile site buries the thread under an app/login wall',
      instances: ['https://safereddit.com', 'https://redlib.privacyredirect.com',
                  'https://redlib.catsarch.com', 'https://redlib.tiekoetter.com',
                  'https://old.reddit.com'],
      map: function (u, base) {
        // redd.it/<id> is a short link to a comment thread
        if (bareHost(u.hostname) === 'redd.it') {
          var id = u.pathname.replace(/^\/+|\/+$/g, '');
          return id ? base + '/comments/' + id : null;
        }
        return swapOrigin(u, base);
      }
    },
    {
      id: 'instagram',
      name: 'Instagram',
      hosts: ['instagram.com'],
      gated: true,
      note: 'a post is one scroll before the login modal takes the page',
      instances: ['https://imginn.com', 'https://proxigram.privacyredirect.com']
    },
    {
      id: 'medium',
      name: 'Medium',
      hosts: ['medium.com'],
      skip: ['cdn-images-1.medium.com', 'miro.medium.com'],
      gated: true,
      note: 'member-only posts are paywalled and the rest nag for an account',
      instances: [{ url: 'https://freedium-mirror.cfd', wrap: true },
                  'https://scribe.rip'],
      map: function (u, base, inst) {
        // Freedium takes the whole original URL as its path
        if (inst.wrap) return base + '/' + u.href;
        // <user>.medium.com/<slug> is medium.com/@<user>/<slug> in Scribe's shape
        var m = /^([^.]+)\.medium\.com$/.exec(bareHost(u.hostname));
        if (m) return base + '/@' + m[1] + u.pathname + u.search + u.hash;
        return swapOrigin(u, base);
      }
    },
    {
      id: 'quora',
      name: 'Quora',
      hosts: ['quora.com'],
      gated: true,
      note: 'answers blur out until you sign up',
      instances: ['https://quetre.privacyredirect.com', 'https://quetre.iket.me']
    },
    {
      id: 'tiktok',
      name: 'TikTok',
      hosts: ['tiktok.com'],
      gated: true,
      on: false,   // gated, but TikTok has broken every ProxiTok instance we could find
      note: 'login-walled, but ProxiTok instances are mostly dead — try one and see',
      instances: ['https://proxitok.privacyredirect.com', 'https://tt.bloat.cat']
    },
    {
      id: 'youtube',
      name: 'YouTube',
      hosts: ['youtube.com', 'youtu.be'],
      note: 'no ads, no cookies, no player telemetry',
      instances: ['https://yewtu.be', 'https://invidious.f5.si',
                  'https://invidious.privacyredirect.com', 'https://piped.video'],
      map: function (u, base) {
        var q;
        if (bareHost(u.hostname) === 'youtu.be') {
          var id = u.pathname.split('/')[1];
          if (!id) return null;
          q = new URLSearchParams(u.search);   // keeps ?t=
          q.set('v', id);
          return base + '/watch?' + q + u.hash;
        }
        var m = /^\/(?:shorts|live|embed|v)\/([^/]+)/.exec(u.pathname);
        if (m) return base + '/watch?v=' + encodeURIComponent(m[1]) + u.hash;
        return swapOrigin(u, base);
      }
    },
    {
      id: 'stackexchange',
      name: 'Stack Overflow',
      hosts: ['stackoverflow.com', 'stackexchange.com'],
      note: 'the answers without the cookie banner or the sign-up interstitial',
      instances: ['https://anonymousoverflow.privacyredirect.com',
                  'https://ao.vern.cc', 'https://ao.bloat.cat'],
      map: function (u, base) {
        // AnonymousOverflow only renders question pages
        if (!/^\/(?:questions|q|a)\/\d+/.test(u.pathname)) return null;
        var host = bareHost(u.hostname);
        if (host === 'stackoverflow.com') return swapOrigin(u, base);
        // every other network site is /exchange/<subdomain>/…
        var m = /^(.+)\.stackexchange\.com$/.exec(host);
        return m ? base + '/exchange/' + m[1] + u.pathname + u.search + u.hash : null;
      }
    },
    {
      id: 'fandom',
      name: 'Fandom',
      hosts: ['fandom.com'],
      note: 'the wiki without the video player and the three ad rails',
      instances: ['https://antifandom.com', 'https://breezewiki.com',
                  'https://breezewiki.privacyredirect.com'],
      map: function (u, base) {
        // <wiki>.fandom.com/wiki/Page  ->  <instance>/<wiki>/wiki/Page
        var m = /^([^.]+)\.fandom\.com$/.exec(bareHost(u.hostname));
        return m ? base + '/' + m[1] + u.pathname + u.search + u.hash : null;
      }
    },
    {
      id: 'imgur',
      name: 'Imgur',
      hosts: ['imgur.com'],
      note: 'the image without the app prompt or the tracking pixels',
      instances: ['https://rimgo.privacyredirect.com', 'https://rimgo.bloat.cat',
                  'https://imgur.artemislena.eu']
    },
    {
      id: 'wikipedia',
      name: 'Wikipedia',
      hosts: ['wikipedia.org'],
      note: 'same article, no analytics and no fundraising banners',
      instances: ['https://wikiless.privacyredirect.com', 'https://wikiless.org'],
      map: function (u, base) {
        // the language lives in the subdomain upstream and in ?lang= here
        var m = /^([a-z]{2,3}(?:-[a-z]+)?)\.(?:m\.)?wikipedia\.org$/
          .exec(bareHost(u.hostname));
        var q = new URLSearchParams(u.search);
        q.set('lang', m ? m[1] : 'en');
        return base + u.pathname + '?' + q + u.hash;
      }
    },
    {
      id: 'paywall',
      name: 'Paywalled news',
      hosts: ['wsj.com', 'nytimes.com', 'ft.com', 'bloomberg.com', 'economist.com',
              'washingtonpost.com', 'newyorker.com', 'theatlantic.com', 'wired.com',
              'businessinsider.com', 'barrons.com', 'thetimes.co.uk',
              'telegraph.co.uk', 'hbr.org', 'seekingalpha.com', 'nationalgeographic.com',
              'latimes.com', 'bostonglobe.com', 'thetimes.com'],
      gated: true,
      on: false,   // gated, but archive.today captchas often enough to be a surprise
      note: 'sends the listed papers to archive.today; it captchas often, hence off',
      instances: ['https://archive.ph', 'https://archive.today', 'https://archive.is'],
      map: function (u, base) { return base + '/newest/' + u.href; }
    }
  ];

  /* Normalize the registry once: instances become objects, and `on` falls back
     to `gated` so a new login-walled service is on by default automatically. */
  var FRONTEND_HOSTS = {};
  FRONTENDS.forEach(function (svc) {
    svc.instances = svc.instances.map(function (i) {
      return typeof i === 'string' ? { url: i } : i;
    });
    if (svc.on === undefined) svc.on = !!svc.gated;
    svc.hosts.forEach(function (h) { FRONTEND_HOSTS[h] = svc; });
  });

  function bareHost(host) {
    return String(host).toLowerCase().replace(/^www\./, '').replace(/:\d+$/, '');
  }

  function swapOrigin(u, base) { return base + u.pathname + u.search + u.hash; }

  /* The service that claims a host: an exact match, or the nearest parent
     domain, so pub.medium.com and old.reddit.com find medium.com and
     reddit.com. Never matches a bare TLD. */
  function serviceForHost(host) {
    host = bareHost(host);
    var parts = host.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      var svc = FRONTEND_HOSTS[parts.slice(i).join('.')];
      if (svc) return svc.skip && svc.skip.indexOf(host) !== -1 ? null : svc;
    }
    return null;
  }

  function instanceFor(svc, url) {
    for (var i = 0; i < svc.instances.length; i++) {
      if (svc.instances[i].url === url) return svc.instances[i];
    }
    return { url: url };          // a custom entry: assume the plain shape
  }

  /* Every stored setting is optional: unknown ids are dropped and services the
     save predates arrive with their registry defaults, so the list can grow
     without a state migration. */
  function normalizeRedirects(saved) {
    saved = (saved && typeof saved === 'object') ? saved : {};
    var savedServices = (saved.services && typeof saved.services === 'object')
      ? saved.services : {};
    var services = {};
    FRONTENDS.forEach(function (svc) {
      var s = savedServices[svc.id] || {};
      services[svc.id] = {
        on: typeof s.on === 'boolean' ? s.on : svc.on,
        instance: typeof s.instance === 'string' ? s.instance : svc.instances[0].url
      };
    });
    return { on: saved.on === true, services: services };
  }

  /* Where a story link should really go, or null to leave it alone. */
  function redirectFor(href) {
    if (!state.redirects.on || !href) return null;
    var m = /^https?:\/\/([^/?#]+)/i.exec(href);
    if (!m) return null;
    var svc = serviceForHost(m[1]);
    if (!svc) return null;
    var cfg = state.redirects.services[svc.id];
    if (!cfg || !cfg.on) return null;

    // a half-typed custom instance shouldn't send the link anywhere
    var base = String(cfg.instance || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(base)) return null;

    var u, target, host;
    try {
      u = new URL(href);
      host = new URL(base).host;
      if (bareHost(host) === bareHost(u.hostname)) return null;   // already there
      target = (svc.map || swapOrigin)(u, base, instanceFor(svc, base));
    } catch (e) { return null; }
    return target && target !== href ? { url: target, host: host, service: svc } : null;
  }

  /* ------------------------------------------------------------- state --- */

  var state = loadState();
  var prevVisit = state.lastVisit;      // where the last-visit marker goes
  state.lastVisit = Math.floor(Date.now() / 1000);
  saveState();

  var topSet = {};                      // id -> true for the current front page
  var allEntries = [];                  // merged feed, sorted by date desc
  var byId = {};                        // id -> entry
  var oldestLoadedUtcDay = null;        // 'YYYYMMDD' of the oldest loaded UTC day
  var loadingOlder = false;
  var loadedUtcDayCount = 0;
  var pendingNew = [];                  // entries waiting behind the "N new" link
  var addedIds = {};                    // briefly highlight stories added via refresh
  var lastVisitDismissed = false;

  function loadState() {
    var s = {};
    try { s = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch (e) {}
    var out = {};
    for (var k in DEFAULTS) out[k] = s[k] !== undefined ? s[k] : DEFAULTS[k];
    // pre-v2 saves predate showdead defaulting on; migrate once
    if ((s._v || 1) < 2) out.showdead = true;
    // v3 added `redirects`; missing and partial saves fill themselves in, so
    // the shape itself never needs migrating
    out.redirects = normalizeRedirects(s.redirects);
    // …but v3 shipped them ON by default and v4 made the whole thing opt-in.
    // Clear that inherited default once, so nobody keeps a feature they were
    // never asked about; anyone who wants it back is one checkbox away.
    if ((s._v || 1) < 4) out.redirects.on = false;
    out._v = STATE_VERSION;
    return out;
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  /* -------------------------------------------------------------- time --- */
  /* The original groups its data files by UTC day (front-page arrival), but
     the separators you see — day tabs and 6am/12pm/6pm markers — follow the
     viewer's local clock. We do the same: fetch per UTC day, render per
     local day, always keyed on `date` (when the story hit the front page). */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function utcDayKey(ts) {
    var d = new Date(ts * 1000);
    return '' + d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
  }

  function utcDayStart(key) {
    return Date.UTC(+key.slice(0, 4), +key.slice(4, 6) - 1, +key.slice(6, 8)) / 1000;
  }

  function prevUtcDayKey(key) {
    return utcDayKey(utcDayStart(key) - 43200);
  }

  function localDayKey(ts) {
    var d = new Date(ts * 1000);
    return '' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate());
  }

  function localDayLabel(ts) {
    return new Date(ts * 1000).toLocaleDateString('en-US',
      { weekday: 'short', month: 'short', day: 'numeric' });
  }

  var BUCKET_LABELS = { 1: '6am', 2: '12pm', 3: '6pm' };
  function bucket(entry) {
    return Math.floor(new Date(entry.date * 1000).getHours() / 6);
  }

  /* -------------------------------------------------------------- data --- */

  /* Load the real hckrnews feed by <script> injection (no CORS needed). */
  function loadHckrFeed() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = FEED + '?_=' + Date.now();
      s.onload = function () {
        var raw = window.entries;
        window.entries = undefined;
        s.remove();
        if (Array.isArray(raw) && raw.length) resolve(raw.map(normalizeFeed));
        else reject(new Error('feed empty'));
      };
      s.onerror = function () {
        s.remove();
        reject(new Error('hckrnews feed unreachable'));
      };
      document.head.appendChild(s);
    });
  }

  function normalizeFeed(x) {
    return {
      id: String(x.id),
      title: x.link_text || 'undefined',   // sic — the original renders dead stories this way
      url: x.link || null,
      source: x.source || null,
      points: x.points || 0,
      comments: x.comments || 0,
      time: parseInt(x.time, 10) || x.date,
      date: x.date,                        // when it first hit the front page
      type: x.type === 'job' ? 'job' : 'story',
      dead: !!x.dead,
      homepage: !!x.homepage,
      exact: true
    };
  }

  function algolia(params) {
    return fetch(ALGOLIA + '?' + params).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  /* Approximate one UTC day from Algolia (see header comment). */
  function fetchArchiveDay(key, minPoints) {
    var start = utcDayStart(key);
    var range = 'created_at_i>=' + start + ',created_at_i<' + (start + 86400);
    var stories = algolia('tags=story&hitsPerPage=1000&numericFilters=' +
      encodeURIComponent(range + ',points>=' + minPoints));
    var jobs = algolia('tags=job&hitsPerPage=100&numericFilters=' +
      encodeURIComponent(range));
    return Promise.all([stories, jobs]).then(function (res) {
      return res[0].hits.concat(res[1].hits).map(function (h) {
        var isJob = (h._tags || []).indexOf('job') !== -1;
        var source = null;
        if (h.url) { try { source = new URL(h.url).hostname; } catch (e) {} }
        return {
          id: h.objectID,
          title: h.title || 'untitled',
          url: h.url || null,
          source: source,
          points: h.points || 0,
          comments: h.num_comments || 0,
          time: h.created_at_i,
          date: h.created_at_i,            // approximation: submission ~ arrival
          type: isJob ? 'job' : 'story',
          dead: false,
          homepage: !!topSet[h.objectID],
          exact: false
        };
      });
    });
  }

  function fetchTopSet() {
    return fetch(TOPSTORIES)
      .then(function (r) { return r.json(); })
      .then(function (ids) {
        topSet = {};
        // like the original's homepage flag: the actual front page (top 30)
        ids.slice(0, 30).forEach(function (id) { topSet[id] = true; });
      })
      .catch(function () {});
  }

  /* Merge a batch into allEntries. Feed data wins over approximations. */
  function merge(entries) {
    var fresh = [];
    entries.forEach(function (e) {
      var known = byId[e.id];
      if (!known) {
        byId[e.id] = e;
        allEntries.push(e);
        fresh.push(e);
      } else if (e.exact || !known.exact) {
        known.points = e.points;
        known.comments = e.comments;
        known.homepage = e.homepage;
        known.dead = e.dead;
      }
    });
    allEntries.sort(function (a, b) { return b.date - a.date; });
    return fresh;
  }

  /* --------------------------------------------------------- rendering --- */

  var $entries = document.getElementById('entries');
  var $io = document.getElementById('io');
  var $loading = document.getElementById('loading');

  function hnHref(entry) {
    return state.hackerweb
      ? 'https://hackerweb.app/#/item/' + entry.id
      : 'https://news.ycombinator.com/item?id=' + entry.id;
  }

  function commentsText(entry) {
    if (entry.dead) return ' ';
    var read = state.read[entry.id];
    if (read !== undefined && entry.comments > read) {
      return (entry.comments - read) + ' / ' + entry.comments;
    }
    return String(entry.comments);
  }

  function setLinkTarget(a) {
    if (state.newwindow) {
      a.target = '_blank';
      a.rel = 'noopener';
    } else {
      a.removeAttribute('target');
      a.removeAttribute('rel');
    }
  }

  function renderEntry(entry) {
    var li = document.createElement('li');
    li.className = 'entry row';
    li.id = entry.id;
    if (addedIds[entry.id]) li.className += ' added';

    var deadCls = entry.dead ? ' dead' : '';

    var hn = document.createElement('a');
    hn.id = 'hn-' + entry.id;
    hn.className = 'hn span3 ' + entry.type + deadCls;
    // dead threads always point at HN itself — HackerWeb has nothing to show
    hn.href = entry.dead
      ? 'https://news.ycombinator.com/item?id=' + entry.id
      : hnHref(entry);
    hn.setAttribute('data-date', entry.date);
    hn.setAttribute('data-id', entry.id);
    setLinkTarget(hn);
    if (entry.type !== 'job') {
      var p = document.createElement('p');
      p.className = 'row';
      var c = document.createElement('span');
      c.className = 'comments span2';
      c.textContent = commentsText(entry);
      var pt = document.createElement('span');
      pt.className = 'points span1' + (entry.homepage ? ' homepage' : '');
      pt.textContent = entry.points;
      p.appendChild(c);
      p.appendChild(pt);
      hn.appendChild(p);
    }

    var link = document.createElement('a');
    link.className = 'link span15 ' + entry.type + deadCls;
    var via = entry.url ? redirectFor(entry.url) : null;
    link.href = via ? via.url : (entry.url || hnHref(entry));
    if (via) link.dataset.original = entry.url;   // the alt-click escape hatch
    setLinkTarget(link);
    link.appendChild(document.createTextNode(entry.title + ' '));
    if (entry.source && !entry.dead) {
      // the source stays the story's own domain, like the original; a rewritten
      // link marks it instead of renaming it, so the row still says what it is
      var src = document.createElement('span');
      src.className = via ? 'source redirected' : 'source';
      if (via) src.title = 'via ' + via.host + ' — alt-click for ' + bareHost(entry.source);
      src.textContent = '(' + entry.source + ')';
      link.appendChild(src);
    } else if (via) {
      link.title = 'via ' + via.host;
    }

    li.appendChild(hn);
    li.appendChild(link);
    return li;
  }

  function renderDayTab(ts) {
    var li = document.createElement('li');
    li.className = 'row day';
    li.innerHTML = '<span class="link span15 offset3"><span class="tab"></span></span>';
    li.querySelector('.tab').textContent = localDayLabel(ts);
    return li;
  }

  function renderTimeMarker(label) {
    var li = document.createElement('li');
    li.className = 'time';
    var span = document.createElement('span');
    span.className = 'label';
    span.textContent = label;
    li.appendChild(span);
    return li;
  }

  function renderLastVisit() {
    var li = document.createElement('li');
    li.className = 'row lastvisit';
    li.innerHTML = '<a href="#" class="lastvisit link span15 offset3"><span class="label">last visit</span></a>';
    return li;
  }

  /* Rebuild the whole stream: one <ul> per local day, day tab above every
     day but the first, time-of-day markers at 6-hour boundaries within. */
  function renderStream() {
    $entries.innerHTML = '';
    var ul = null, currentDay = null, prev = null;

    allEntries.forEach(function (entry) {
      var day = localDayKey(entry.date);
      if (day !== currentDay) {
        ul = document.createElement('ul');
        ul.className = 'entries unstyled';
        ul.id = day;
        if (currentDay !== null) ul.appendChild(renderDayTab(entry.date));
        $entries.appendChild(ul);
        currentDay = day;
      } else if (prev) {
        var pb = bucket(prev), cb = bucket(entry);
        if (cb < pb && BUCKET_LABELS[pb]) {
          ul.appendChild(renderTimeMarker(BUCKET_LABELS[pb]));
        }
      }
      if (!lastVisitDismissed && prevVisit && prev &&
          prev.date >= prevVisit && entry.date < prevVisit) {
        ul.appendChild(renderLastVisit());
      }
      ul.appendChild(renderEntry(entry));
      prev = entry;
    });

    addedIds = {};
    applyFilter();
  }

  /* ---------------------------------------------------------- filtering --- */
  /* Like the original, top 10/20/50% thresholds are computed per UTC day
     (per data file), even though the visible separators are local days. */

  function utcThresholds() {
    if (state.filter === 'all' || state.filter === 'homepage') return null;
    var byDay = {};
    allEntries.forEach(function (e) {
      var k = utcDayKey(e.date);
      var d = byDay[k] = byDay[k] || { pts: [], min: e.date, max: e.date };
      if (e.date < d.min) d.min = e.date;
      if (e.date > d.max) d.max = e.date;
      if (e.type === 'story') d.pts.push(e.points);
    });
    var out = {};
    Object.keys(byDay).forEach(function (k) {
      var d = byDay[k];
      var pts = d.pts.sort(function (a, b) { return b - a; });
      var n = state.filter === 'half' ? Math.floor(pts.length / 2) : +state.filter;
      // like the original: pro-rate n by the span the day's entries cover, so a
      // partial (current) day shows top ~n*(hours elapsed)/24, not its whole tail
      n = Math.ceil((d.max - d.min) / 3600 / 24 * n);
      var t = n >= pts.length ? pts[pts.length - 1] : pts[n - 1];
      out[k] = t || 1;
    });
    return out;
  }

  function entryVisible(entry, thresholds) {
    if (entry.dead && !state.showdead) return false;
    switch (state.filter) {
      case 'homepage': return entry.homepage;
      case 'all': return true;
      default:
        return entry.type === 'story' &&
          entry.points >= (thresholds[utcDayKey(entry.date)] || 0);
    }
  }

  function applyFilter() {
    var thresholds = utcThresholds();
    var showTime = state.filter === 'all' || state.filter === 'half';
    $entries.querySelectorAll('ul.entries > li').forEach(function (li) {
      if (li.classList.contains('entry')) {
        var e = byId[li.id];
        li.style.display = e && entryVisible(e, thresholds) ? '' : 'none';
      } else if (li.classList.contains('time') || li.classList.contains('lastvisit')) {
        // separators only make sense when the stream isn't score-filtered
        li.style.display = showTime ? '' : 'none';
      }
    });

    document.querySelectorAll('#filter-pills li').forEach(function (li) {
      var a = li.querySelector('a');
      li.className = String(a.dataset.num) === String(state.filter) ? 'active' : '';
    });
    var label = { '10': 'top 10', '20': 'top 20', half: 'top 50%' }[state.filter] || state.filter;
    document.getElementById('filter-label').textContent = label;
  }

  /* -------------------------------------------------------------- io bar --- */

  function setIo(node) {
    $io.textContent = '';
    if (node) $io.appendChild(node);
    else $io.innerHTML = '<span>&nbsp;</span>';
  }

  function showNewCount() {
    if (!pendingNew.length) { setIo(null); return; }
    var a = document.createElement('a');
    a.href = '#';
    a.className = 'new';
    a.textContent = pendingNew.length + ' new stor' + (pendingNew.length === 1 ? 'y' : 'ies');
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      flushPending();
    });
    setIo(a);
  }

  function flushPending() {
    if (!pendingNew.length) return;
    pendingNew.forEach(function (e) { addedIds[e.id] = true; });
    merge(pendingNew);
    pendingNew = [];
    renderStream();
    setIo(null);
  }

  function showError(message, retry) {
    var a = document.createElement('a');
    a.href = '#';
    a.className = 'error';
    a.textContent = message + ' — retry';
    a.addEventListener('click', function (ev) {
      ev.preventDefault();
      setIo(null);
      retry();
    });
    setIo(a);
  }

  /* ------------------------------------------------------------ loading --- */

  function todayUtcKey() { return utcDayKey(Math.floor(Date.now() / 1000)); }

  /* Initial load: the real feed (2 UTC days), or Algolia if unreachable. */
  function loadInitial() {
    $loading.style.display = '';
    return loadHckrFeed().then(function (entries) {
      merge(entries);
      var oldest = utcDayKey(entries[entries.length - 1].date);
      // if the feed was truncated mid-day, backfill that day from Algolia
      var oldestStart = utcDayStart(oldest);
      var truncated = entries[entries.length - 1].date > oldestStart + 2 * 3600;
      oldestLoadedUtcDay = oldest;
      loadedUtcDayCount = 2;
      renderStream();
      $loading.style.display = 'none';
      if (truncated) {
        return fetchArchiveDay(oldest, ARCHIVE_MIN_POINTS).then(function (extra) {
          merge(extra.filter(function (e) { return e.date < oldestStart + 86400; }));
          renderStream();
        }).catch(function () {});
      }
    }).catch(function () {
      // feed unreachable: approximate today + yesterday from Algolia
      var today = todayUtcKey();
      var yesterday = prevUtcDayKey(today);
      return fetchTopSet().then(function () {
        return Promise.all([
          fetchArchiveDay(today, FALLBACK_MIN_POINTS),
          fetchArchiveDay(yesterday, FALLBACK_MIN_POINTS)
        ]);
      }).then(function (res) {
        merge(res[0].concat(res[1]));
        oldestLoadedUtcDay = yesterday;
        loadedUtcDayCount = 2;
        renderStream();
        $loading.style.display = 'none';
      }).catch(function (err) {
        $loading.style.display = 'none';
        showError('failed to load stories (' + err.message + ')', loadInitial);
      });
    });
  }

  function loadOlder() {
    if (loadingOlder || !oldestLoadedUtcDay || loadedUtcDayCount >= MAX_DAYS) return;
    loadingOlder = true;
    $loading.style.display = '';
    var key = prevUtcDayKey(oldestLoadedUtcDay);
    fetchArchiveDay(key, ARCHIVE_MIN_POINTS).then(function (entries) {
      merge(entries);
      oldestLoadedUtcDay = key;
      loadedUtcDayCount++;
      renderStream();
      $loading.style.display = 'none';
      loadingOlder = false;
      fillViewport();
    }).catch(function () {
      $loading.style.display = 'none';
      loadingOlder = false;
    });
  }

  function nearBottom() {
    return window.innerHeight + window.scrollY >
      document.documentElement.scrollHeight - 600;
  }

  function fillViewport() {
    if (loadedUtcDayCount < 4 && nearBottom()) loadOlder();
  }

  /* Periodic refresh: re-pull the feed, update counts in place, and offer
     newly arrived stories behind an "N new" link. */
  function refresh() {
    loadHckrFeed().then(function (entries) {
      var freshOnes = [];
      entries.forEach(function (e) {
        var known = byId[e.id];
        if (known) {
          known.points = e.points;
          known.comments = e.comments;
          known.homepage = e.homepage;
          known.dead = e.dead;
          var li = document.getElementById(e.id);
          if (li) {
            var c = li.querySelector('.comments');
            var pt = li.querySelector('.points');
            if (c) c.textContent = commentsText(known);
            if (pt) {
              pt.textContent = known.points;
              pt.className = 'points span1' + (known.homepage ? ' homepage' : '');
            }
          }
        } else if (!pendingNew.some(function (p) { return p.id === e.id; })) {
          freshOnes.push(e);
        }
      });
      pendingNew = pendingNew.concat(freshOnes);
      if (pendingNew.length) showNewCount();
    }).catch(function () {
      /* Deliberately silent: a single bad poll isn't worth an error banner,
         and the already-rendered stream stays put until the next tick. */
    });
  }

  /* -------------------------------------------------------------- theme --- */

  function effectiveTheme() {
    var dark = state.mode === 'dark' ||
      (state.mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    return dark ? state.darkTheme : state.lightTheme;
  }

  function applyTheme() {
    var root = document.documentElement;
    root.setAttribute('data-theme', effectiveTheme());
    ['--accent', '--accent-hi', '--accent-line'].forEach(function (v) {
      if (state.accent) root.style.setProperty(v, state.accent);
      else root.style.removeProperty(v);
    });

    var icons = { auto: '◑', light: '☀', dark: '☾' };
    document.getElementById('mode-toggle').textContent =
      icons[state.mode] + ' ' + state.mode;

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.body).backgroundColor;

    document.querySelectorAll('.mode-pills button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.mode === state.mode);
    });
    document.querySelectorAll('.swatch').forEach(function (b) {
      var scheme = b.dataset.scheme;
      var selected = scheme === 'light' ? state.lightTheme : state.darkTheme;
      b.classList.toggle('selected', b.dataset.theme === selected);
    });
    var picker = document.getElementById('accent-color');
    if (picker && state.accent) picker.value = state.accent;
  }

  function buildSwatches() {
    ['light', 'dark'].forEach(function (scheme) {
      var box = document.getElementById('swatches-' + scheme);
      THEMES[scheme].forEach(function (name) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.theme = name;
        b.dataset.scheme = scheme;
        b.title = name;
        b.innerHTML = '<span class="dot"></span>';
        b.appendChild(document.createTextNode(name));
        b.addEventListener('click', function () {
          if (scheme === 'light') state.lightTheme = name;
          else state.darkTheme = name;
          // picking a theme for the other scheme? switch mode so it's visible
          var dark = effectiveTheme() === state.darkTheme &&
            (state.mode === 'dark' || (state.mode === 'auto' &&
              matchMedia('(prefers-color-scheme: dark)').matches));
          if (scheme === 'light' && dark) state.mode = 'light';
          if (scheme === 'dark' && !dark) state.mode = 'dark';
          saveState();
          applyTheme();
        });
        box.appendChild(b);
      });
    });
  }

  /* ---------------------------------------------------- redirect settings --- */

  var CUSTOM = '__custom__';   // a select value no instance URL can collide with

  function buildRedirectRows() {
    var list = document.getElementById('redirect-list');
    FRONTENDS.forEach(function (svc) {
      var row = document.createElement('div');
      row.className = 'redirect-row';

      var name = document.createElement('label');
      name.className = 'redirect-name';
      name.title = svc.note;
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.dataset.svc = svc.id;
      name.appendChild(box);
      name.appendChild(document.createTextNode(' ' + svc.name + ' '));
      var hosts = document.createElement('span');
      hosts.className = 'redirect-hosts';
      // the host list is the real answer to "will this catch my link?"
      hosts.textContent = svc.hosts.slice(0, 3).join(', ') +
        (svc.hosts.length > 3 ? ', +' + (svc.hosts.length - 3) : '');
      name.appendChild(hosts);
      if (svc.gated) {
        var tag = document.createElement('span');
        tag.className = 'redirect-tag';
        tag.textContent = 'login wall';
        name.appendChild(tag);
      }

      var select = document.createElement('select');
      select.dataset.svc = svc.id;
      svc.instances.forEach(function (inst) {
        var o = document.createElement('option');
        o.value = inst.url;
        o.textContent = inst.url.replace(/^https?:\/\//, '');
        select.appendChild(o);
      });
      var custom = document.createElement('option');
      custom.value = CUSTOM;
      custom.textContent = 'custom…';
      select.appendChild(custom);

      var field = document.createElement('input');
      field.type = 'url';
      field.className = 'redirect-custom';
      field.dataset.svc = svc.id;
      field.placeholder = 'https://…';

      row.appendChild(name);
      row.appendChild(select);
      row.appendChild(field);
      list.appendChild(row);
    });
  }

  /* The one-line stand-in for the whole list while it's collapsed: which sites
     are actually being rewritten, cut off before it can wrap on a phone. */
  function redirectNames() {
    var chosen = FRONTENDS.filter(function (svc) {
      return state.redirects.services[svc.id].on;
    });
    if (!chosen.length) return 'nothing selected';
    var shown = chosen.slice(0, 4).map(function (svc) { return svc.name; });
    return shown.join(', ') +
      (chosen.length > shown.length ? ' +' + (chosen.length - shown.length) + ' more' : '');
  }

  function showRedirectDetail(open) {
    var toggle = document.getElementById('redirect-toggle');
    document.getElementById('redirect-detail').style.display = open ? '' : 'none';
    toggle.textContent = open ? 'hide' : 'customize';
    toggle.setAttribute('aria-expanded', String(open));
  }

  /* Push state into the controls: the master switch, the collapsed summary,
     each service's checkbox, and the instance select — which falls back to the
     custom field whenever the saved instance isn't one we ship. */
  function syncRedirectUi() {
    var on = state.redirects.on;
    document.getElementById('settings-redirect').checked = on;
    // switched off, the useful answer is what this would do, not a list of
    // sites nothing is happening to
    document.getElementById('redirect-names').textContent =
      on ? redirectNames() : FRONTENDS.length + ' sites available';
    var list = document.getElementById('redirect-list');
    list.classList.toggle('disabled', !on);

    FRONTENDS.forEach(function (svc) {
      var cfg = state.redirects.services[svc.id];
      var box = list.querySelector('input[type="checkbox"][data-svc="' + svc.id + '"]');
      var select = list.querySelector('select[data-svc="' + svc.id + '"]');
      var field = list.querySelector('input[type="url"][data-svc="' + svc.id + '"]');
      var known = svc.instances.some(function (i) { return i.url === cfg.instance; });
      box.checked = cfg.on;
      select.value = known ? cfg.instance : CUSTOM;
      field.value = known ? '' : cfg.instance;
      field.style.display = known ? 'none' : '';
      [box, select, field].forEach(function (el) { el.disabled = !on; });
    });
  }

  function wireRedirects() {
    document.getElementById('redirect-toggle').addEventListener('click', function (ev) {
      ev.preventDefault();
      showRedirectDetail(document.getElementById('redirect-detail').style.display === 'none');
    });

    var master = document.getElementById('settings-redirect');
    master.addEventListener('change', function () {
      state.redirects.on = master.checked;
      saveState();
      syncRedirectUi();
      renderStream();
    });

    document.getElementById('redirect-list').addEventListener('change', function (ev) {
      var el = ev.target;
      var cfg = state.redirects.services[el.dataset.svc || ''];
      if (!cfg) return;
      var field = el.parentNode.querySelector('input[type="url"]');
      var pickedCustom = false;
      if (el.type === 'checkbox') {
        cfg.on = el.checked;
      } else if (el.tagName === 'SELECT') {
        pickedCustom = el.value === CUSTOM;
        cfg.instance = pickedCustom ? field.value.trim() : el.value;
      } else {
        cfg.instance = el.value.trim();
      }
      saveState();
      syncRedirectUi();          // the collapsed summary has to stay truthful
      if (pickedCustom) field.focus();
      renderStream();
    });

    // this button lives inside the per-service list, so it restores the per-service
    // defaults only — the master switch above it isn't its business to flip
    document.getElementById('redirect-reset').addEventListener('click', function () {
      state.redirects = normalizeRedirects({ on: state.redirects.on });
      saveState();
      syncRedirectUi();
      renderStream();
    });
  }

  /* -------------------------------------------------------------- wiring --- */

  function wireEvents() {
    // filter pills
    document.getElementById('filter-pills').addEventListener('click', function (ev) {
      var a = ev.target.closest('a.filtertop');
      if (!a) return;
      ev.preventDefault();
      state.filter = a.dataset.num;
      saveState();
      applyFilter();
      document.getElementById('menu').classList.remove('open');
    });

    // phone filter dropdown
    document.getElementById('filter-toggle').addEventListener('click', function (ev) {
      ev.preventDefault();
      document.getElementById('menu').classList.toggle('open');
    });

    // settings panel
    var panel = document.getElementById('settings-panel');
    document.querySelector('a.show-settings').addEventListener('click', function (ev) {
      ev.preventDefault();
      panel.style.display = panel.style.display === 'none' ? '' : 'none';
    });
    document.getElementById('settings-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      panel.style.display = 'none';
    });

    // story settings checkboxes
    [['settings-hackerweb', 'hackerweb'],
     ['settings-newwindow', 'newwindow'],
     ['settings-showdead', 'showdead']].forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      el.checked = state[pair[1]];
      el.addEventListener('change', function () {
        state[pair[1]] = el.checked;
        saveState();
        renderStream();
      });
    });

    // appearance controls
    document.getElementById('mode-pills').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-mode]');
      if (!b) return;
      state.mode = b.dataset.mode;
      saveState();
      applyTheme();
    });
    document.getElementById('mode-toggle').addEventListener('click', function (ev) {
      ev.preventDefault();
      var order = ['auto', 'light', 'dark'];
      state.mode = order[(order.indexOf(state.mode) + 1) % order.length];
      saveState();
      applyTheme();
    });
    var picker = document.getElementById('accent-color');
    picker.addEventListener('input', function () {
      state.accent = picker.value;
      saveState();
      applyTheme();
    });
    document.getElementById('accent-reset').addEventListener('click', function () {
      state.accent = null;
      saveState();
      applyTheme();
      picker.value = '#ff6600';
    });

    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (state.mode === 'auto') applyTheme();
    });

    // remember how many comments were seen when opening a thread;
    // dismiss the last-visit marker on click
    $entries.addEventListener('click', function (ev) {
      var lastvisit = ev.target.closest('a.lastvisit');
      if (lastvisit) {
        ev.preventDefault();
        lastVisitDismissed = true;
        lastvisit.closest('li').remove();
        return;
      }
      // alt-click a rewritten link to go to the site itself (a front end being
      // down is the usual reason, and there's no other way back to the original)
      var story = ev.target.closest('a.link[data-original]');
      if (story && ev.altKey) {
        ev.preventDefault();
        if (state.newwindow) window.open(story.dataset.original, '_blank', 'noopener');
        else location.href = story.dataset.original;
        return;
      }
      var hn = ev.target.closest('a.hn');
      if (hn && hn.dataset.id) {
        var entry = byId[hn.dataset.id];
        if (entry) {
          state.read[entry.id] = entry.comments;
          var keys = Object.keys(state.read);
          if (keys.length > 500) delete state.read[keys[0]];
          saveState();
        }
      }
    });

    window.addEventListener('scroll', function () {
      if (nearBottom()) loadOlder();
    }, { passive: true });
  }

  /* --------------------------------------------------------------- boot --- */

  function boot() {
    // one-off URL overrides, mostly for sharing/screenshots:
    //   ?theme=dracula  ?mode=dark  ?filter=10  ?settings=open  ?redirects=off|open
    var q = new URLSearchParams(location.search);
    if (q.get('mode') && ['auto', 'light', 'dark'].indexOf(q.get('mode')) !== -1) {
      state.mode = q.get('mode');
    }
    if (q.get('theme')) {
      var t = q.get('theme');
      if (THEMES.light.indexOf(t) !== -1) { state.lightTheme = t; state.mode = 'light'; }
      if (THEMES.dark.indexOf(t) !== -1) { state.darkTheme = t; state.mode = 'dark'; }
    }
    if (q.get('filter')) state.filter = q.get('filter');
    var redirects = q.get('redirects');   // on | off | open (open leaves the switch alone)
    if (redirects === 'on' || redirects === 'off') state.redirects.on = redirects === 'on';

    buildSwatches();
    buildRedirectRows();
    wireEvents();
    wireRedirects();
    syncRedirectUi();
    if (redirects === 'open') showRedirectDetail(true);
    applyTheme();
    applyFilter();

    if (q.get('settings') === 'open') {
      document.getElementById('settings-panel').style.display = '';
    }

    fetchTopSet();
    loadInitial().then(fillViewport);
    setInterval(refresh, POLL_MS);
  }

  boot();
})();
