#!/usr/bin/env python3
"""drkr news crawler: records when stories reach the Hacker News front page.

hckrnews is "a chronologic list of items that have made it onto the HN
homepage", sorted by the moment each one first got there. HN doesn't publish
that moment, so the original runs a crawler that watches for it; this is
ours. Every 30 seconds it reads the front page from HN's official API, stamps
each story the first time it appears there, re-reads the score, comment count
and title of everything recorded so far, and writes what the page loads:

    data/latest.json     the current and previous UTC day, newest first
    data/YYYYMMDD.json   each older UTC day, frozen as it leaves latest.json

Entries keep the original's schema, quirks included (see update()), so the
page renders them exactly as it rendered the original's feed.

Run it beside any static server; standard library only, like the site:

    python3 crawl.py                 # writes ./data next to this file
"""
import argparse
import concurrent.futures
import datetime
import glob
import http.client
import json
import os
import sys
import threading
import time
import urllib.parse

API_HOST = 'hacker-news.firebaseio.com'
FRONT_PAGE = 30      # stories on news.ycombinator.com's front page
INTERVAL = 30        # seconds between polls (the original's crawler: ~33)
WORKERS = 8          # concurrent item requests, one connection each
TIMEOUT = 20
BASELINE_RANKS = 90  # a cold start's unknowns: the first three pages ...
CLIMBING = 2.5 * 3600  # ... minus what below rank 30 is still this young ...
BASELINE_DAYS = 3    # ... kept out of the feed for this long

_conn = threading.local()


def get(path):
    """GET /v0<path> as JSON over a kept-alive connection (one per thread):
    every poll re-reads every recorded story, ~140 requests, and a TLS
    handshake apiece would cost several times the data itself."""
    for attempt in range(2):
        if getattr(_conn, 'c', None) is None:
            _conn.c = http.client.HTTPSConnection(API_HOST, timeout=TIMEOUT)
        try:
            _conn.c.request('GET', '/v0' + path)
            r = _conn.c.getresponse()
            body = r.read()
            if r.status != 200:
                raise OSError('HTTP %d for %s' % (r.status, path))
            return json.loads(body)
        except (OSError, http.client.HTTPException):
            _conn.c.close()
            _conn.c = None
            if attempt:                      # a fresh connection failed too
                raise                        # (the first try may just be stale)


def js_str(value):
    # The original's backend stringifies fields the way JavaScript does, so a
    # field the API leaves out arrives as the text 'undefined' — that's why a
    # dead story's title reads "undefined" there (and here).
    return 'undefined' if value is None else str(value)


def update(entry, item):
    """Copy an API item into an entry, in the original's schema and types."""
    url = item.get('url') or ''
    entry['link_text'] = js_str(item.get('title'))
    entry['link'] = url
    if url:
        # the hostname as-is (www. included); a story that loses its URL by
        # going dead keeps the source it had, as the original's do
        host = urllib.parse.urlsplit(url).hostname
        if host:
            entry['source'] = host
    entry['points'] = item.get('score')          # null once deleted
    entry['comments'] = item.get('descendants')  # null for jobs and the dead
    entry['submitter'] = js_str(item.get('by'))
    entry['time'] = js_str(item.get('time'))     # submission time, a string
    entry['type'] = item.get('type')
    entry['dead'] = bool(item.get('dead'))
    return entry


def day_key(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.timezone.utc).strftime('%Y%m%d')


def window_start(now):
    """00:00 UTC yesterday: latest.json holds yesterday and today."""
    day = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).date()
    day -= datetime.timedelta(days=1)
    return int(datetime.datetime(day.year, day.month, day.day,
                                 tzinfo=datetime.timezone.utc).timestamp())


def newest_first(entries):
    # arrival time, then id, both descending — same-poll arrivals tie on
    # `date`, and the original breaks that tie by id
    return sorted(entries, key=lambda e: (e['date'], int(e['id'])), reverse=True)


def log(*parts):
    print(*parts, flush=True)


class Crawler:
    def __init__(self, out):
        self.out = out
        os.makedirs(out, exist_ok=True)
        self.live = {e['id']: e for e in self.read('latest.json', [])}
        for entry in self.live.values():
            entry.pop('last_update', None)   # the file's, not the story's (see poll())
        self.known = set(self.live)          # every id ever recorded
        for path in glob.glob(os.path.join(out, '[0-9]' * 8 + '.json')):
            self.known.update(e['id'] for e in self.read(os.path.basename(path), []))
        # A story already on the front page when the crawler first starts got
        # there at a time nobody recorded, and so did one that has just dropped
        # off it: stories near rank 30 bounce in and out for hours, so that one
        # will be back within minutes. Stamping either with the time we happen
        # to see it would be a lie, so a cold start leaves out the front page
        # and whatever on the next two pages is old enough to have been on it
        # (cold_start()) — remembered here, so none of it is mistaken for a
        # new arrival — and the page approximates that stretch the way it
        # approximates any day it has no file for.
        self.baseline = self.read('.baseline.json', {})
        self.known.update(self.baseline)
        self.arriving = {}                   # id -> first seen, until its item loads
        self.written = {}                    # file -> last bytes written
        self.pool = concurrent.futures.ThreadPoolExecutor(WORKERS)
        self.archive(time.time())
        self.cold = not self.live

    def path(self, name):
        return os.path.join(self.out, name)

    def read(self, name, default):
        try:
            with open(self.path(name), encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return default

    def write(self, name, data):
        raw = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode()
        if self.written.get(name) == raw:
            return
        # write-then-rename, so a reader never sees half a file
        tmp = self.path('.' + name + '.tmp')
        with open(tmp, 'wb') as f:
            f.write(raw)
        os.replace(tmp, self.path(name))
        self.written[name] = raw

    def fetch(self, ids):
        def one(i):
            try:
                return i, get('/item/%s.json' % i)
            except Exception as e:
                return i, e
        return self.pool.map(one, ids)

    def poll(self):
        now = int(time.time())
        try:
            ranked = [str(i) for i in get('/topstories.json')]
        except Exception as e:
            log('! front page:', e)
            return
        front = ranked[:FRONT_PAGE]
        if self.cold:
            self.cold = False
            self.cold_start(ranked, now)
        for i in front:
            if i not in self.known:
                self.known.add(i)
                self.arriving[i] = now

        # every recorded story, every poll: the original keeps them all current
        failed = 0
        for i, item in self.fetch(list(self.arriving) + list(self.live)):
            if not isinstance(item, dict):   # an error, or null for an id
                failed += 1                  # the API doesn't have yet: next poll
            elif i in self.arriving:
                entry = {'id': i, 'date': self.arriving.pop(i)}
                self.live[i] = update(entry, item)
                log('+ %s #%s %s' % (i, front.index(i) + 1 if i in front else '-',
                                     entry['link_text']))
            else:
                update(self.live[i], item)
        if failed:
            log('! %d stories unreadable' % failed)

        on_page = set(front)
        for i, entry in self.live.items():
            entry['homepage'] = i in on_page
        self.archive(now)
        entries = newest_first(self.live.values())
        if entries:
            # the original stamps its newest entry with the time of the last
            # poll (on a copy: it belongs to the file, not to the story)
            entries[0] = dict(entries[0], last_update=now)
        self.write('latest.json', entries)

    def cold_start(self, ranked, now):
        """Baseline everything that may already have been on the front page."""
        near = [i for i in ranked[:BASELINE_RANKS] if i not in self.known]
        # Below rank 30, a story younger than CLIMBING hasn't had the time to
        # rise, peak and fall off yet: it is still on its way up, and will be
        # a genuine arrival. (In practice the youngest that has been on the
        # front page and dropped off is about three hours old.)
        below = [i for i in near if i not in ranked[:FRONT_PAGE]]
        climbing = {i for i, item in self.fetch(below) if isinstance(item, dict)
                    and now - (item.get('time') or 0) < CLIMBING}
        left_out = [i for i in near if i not in climbing]
        self.baseline.update((i, now) for i in left_out)
        self.known.update(left_out)
        self.write('.baseline.json', self.baseline)
        log('cold start: %d stories left out, %d still climbing kept'
            % (len(left_out), len(climbing)))

    def archive(self, now):
        """Freeze every UTC day that has left latest.json into its own file."""
        start = window_start(now)
        days = {}
        for entry in self.live.values():
            if entry['date'] < start:
                days.setdefault(day_key(entry['date']), []).append(entry)
        for key, entries in sorted(days.items()):
            name = key + '.json'
            # merge rather than overwrite: a crawler that was down over
            # midnight finds the day it missed still in latest.json
            merged = {e['id']: e for e in self.read(name, [])}
            for entry in entries:
                entry['homepage'] = False    # archived days are history
                merged[entry['id']] = entry
                del self.live[entry['id']]
            self.write(name, newest_first(merged.values()))
            log('archived %s: %d stories' % (key, len(merged)))
        expiry = now - BASELINE_DAYS * 86400
        if any(t < expiry for t in self.baseline.values()):
            self.baseline = {i: t for i, t in self.baseline.items() if t >= expiry}
            self.write('.baseline.json', self.baseline)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--out', default=os.path.join(here, 'data'),
                    help='directory to write into (default: data/ beside this file)')
    crawler = Crawler(ap.parse_args().out)
    log('crawling into', crawler.out)
    while True:
        crawler.poll()
        time.sleep(INTERVAL - time.time() % INTERVAL)   # on the :00/:30 grid


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
