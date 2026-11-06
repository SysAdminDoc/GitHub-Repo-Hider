"""Headless smoke test for github-repo-hider.user.js.

Runs the script against live public GitHub pages (logged out) and, when given one, a saved
logged-in capture of a Repositories tab, which is the only way to see the Star button markup
without signing in. See the README for usage.
"""
import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / "github-repo-hider.user.js").read_text(encoding="utf-8")

GM_SHIM = """
(() => {
  const k = key => '__gm:' + key;
  window.GM_getValue = (key, def) => { const raw = localStorage.getItem(k(key)); return raw === null ? def : JSON.parse(raw); };
  window.GM_setValue = (key, value) => localStorage.setItem(k(key), JSON.stringify(value));
  window.GM_addStyle = css => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).append(s); return s; };
  window.__menu = [];
  window.GM_registerMenuCommand = (name, fn) => { window.__menu.push({ name, fn }); };
  window.GM_addValueChangeListener = () => 0;
  window.GM_setClipboard = text => { window.__clip = text; };

  // Records the script's release lookups so the checks can count them, and answers them from a
  // planted plan when there is one. Playwright routes can't do this: a request that follows a
  // fulfilled redirect goes to the real network.
  const realFetch = window.fetch;
  window.__lookups = [];
  window.__statuses = [];
  window.__inFlight = 0;
  window.__maxInFlight = 0;
  const planned = (plan, url) => {
    const repo = new URL(url).pathname.split('/').slice(1, 3).join('/');
    const { status = 404, final = url, body = '', headers = {} } = plan[repo] || plan['*'] || {};
    const response = new Response(body, { status, headers });
    Object.defineProperty(response, 'url', { value: final.replace('{repo}', repo) });
    return new Promise(done => setTimeout(() => done(response), 20));
  };
  window.fetch = function (input) {
    const url = String(input && input.url || input);
    if (!url.endsWith('/releases/latest')) return realFetch.apply(this, arguments);
    window.__lookups.push(url);
    window.__maxInFlight = Math.max(window.__maxInFlight, ++window.__inFlight);
    const plan = JSON.parse(localStorage.getItem('__mock:releases') || 'null');
    const answer = plan ? planned(plan, url) : realFetch.apply(this, arguments);
    return answer.then(response => {
      window.__statuses.push(response.status);
      return response;
    }).finally(() => { window.__inFlight--; });
  };
})();
"""

# Release pages for the mocked checks. The decoy before <main> and the word Draft inside the
# pre-release notes must both be ignored.
MOCK_TAG_PAGE = """<!doctype html><title>tag</title>
<header><relative-time datetime="2001-01-01T00:00:00Z"></relative-time></header>
<main><p>released this <relative-time class="no-wrap" prefix="" datetime="2026-11-06T02:36:04Z"></relative-time></p></main>"""
MOCK_TAG_PAGE_NO_DATE = "<!doctype html><title>tag</title><main><p>no date here</p></main>"
MOCK_LIST_PAGE = """<!doctype html><title>list</title><main><section aria-label="Releases results">
<section id="release-a" aria-labelledby="hd-1" data-release-anchor="release-a">
  <a href="/{repo}/releases/tag/untagged-abc123">Unfinished</a>
  <span data-view-component="true" class="Label Label--draft Label--large">Draft</span>
</section>
<section id="release-b" aria-labelledby="hd-2" data-release-anchor="release-b">
  <a href="/{repo}/releases/tag/v2.0.0-rc1">v2.0.0-rc1</a>
  <span data-view-component="true" class="Label Label--warning Label--large">Pre-release</span>
  <relative-time class="no-wrap" prefix="" datetime="2026-03-04T17:00:00Z"></relative-time>
  <p>Draft</p>
</section></section></main>"""
MOCK_EMPTY_LIST_PAGE = "<!doctype html><title>list</title><main><h2>There aren't any releases here</h2></main>"

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def stored(page):
    return page.evaluate("JSON.parse(localStorage.getItem('__gm:hiddenRepos') || '[]')")


def live(page, user, shots):
    page.goto(f"https://github.com/{user}?tab=repositories", wait_until="domcontentloaded")
    page.wait_for_selector('li[itemprop="owns"] .grh-btn', state="attached", timeout=20000)
    page.wait_for_timeout(300)
    items = page.locator('li[itemprop="owns"]')
    n, btns = items.count(), page.locator('li[itemprop="owns"] .grh-btn').count()
    check("repos tab: every row gets one button", n > 0 and btns == n, f"{btns}/{n}")

    first = items.nth(0)
    repo = first.locator(".grh-btn").get_attribute("data-repo")
    first.hover()
    first.locator(".grh-btn").click()
    page.wait_for_timeout(300)
    check("repos tab: row hidden after click", not first.is_visible(), repo)
    check("repos tab: no popup after hiding", page.locator(".grh-toast").count() == 0)
    check("repos tab: pill counts 1", page.locator(".grh-pill__count").inner_text() == "1 hidden")
    check("repos tab: saved", stored(page) == [repo], json.dumps(stored(page)))

    page.locator('.grh-pill__btn[data-grh-action="reveal"]').click()
    page.wait_for_timeout(200)
    check("reveal: row shown with Unhide", first.is_visible() and first.locator(".grh-btn").get_attribute("data-state") == "hidden")
    page.screenshot(path=str(shots / "live-reveal.png"))
    page.locator('.grh-pill__btn[data-grh-action="reveal"]').click()
    page.wait_for_timeout(200)
    check("reveal: hide again", not first.is_visible())

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector('li[itemprop="owns"] .grh-btn', state="attached", timeout=20000)
    page.wait_for_timeout(300)
    check("reload: still hidden", page.locator('li[itemprop="owns"][data-grh-hidden]').count() == 1)

    page.locator('.grh-pill__btn[data-grh-action="reveal"]').click()
    page.wait_for_timeout(200)
    page.locator('li[itemprop="owns"][data-grh-hidden] .grh-btn').click()
    page.wait_for_timeout(200)
    check("unhide from the row", stored(page) == [] and page.locator(".grh-toast").count() == 0, json.dumps(stored(page)))
    reveal_button = page.locator('.grh-pill__btn[data-grh-action="reveal"]')
    if reveal_button.count():
        reveal_button.click()

    page.evaluate("window.__menu.find(m => m.name.startsWith('Manage')).fn()")
    page.wait_for_selector(".grh-dialog[open]")
    page.fill(".grh-dialog__input", f"https://github.com/{user}/{repo.split('/')[1]}/tree/main nope/")
    page.click('.grh-dialog__form button[type="submit"]')
    page.wait_for_timeout(200)
    check("manager: URL parsed and added", page.locator(".grh-dialog__row").count() == 1)
    check("manager: bad token reported", "nope/" in page.locator(".grh-dialog__error").inner_text())
    page.locator(".grh-dialog__footer .btn-danger").click()
    page.wait_for_timeout(200)
    check("manager: Clear all offers Undo", page.locator(".grh-toast__action").count() == 1 and stored(page) == [])
    page.locator(".grh-toast__action").click()
    page.wait_for_timeout(200)
    check("manager: Undo restores the list", len(stored(page)) == 1, json.dumps(stored(page)))
    page.screenshot(path=str(shots / "manager.png"))
    page.click(".grh-dialog__close")
    page.evaluate("localStorage.setItem('__gm:hiddenRepos', '[]')")

    page.goto(f"https://github.com/{user}", wait_until="domcontentloaded")
    page.wait_for_selector(".pinned-item-list-item .grh-btn", state="attached", timeout=20000)
    pins = page.locator(".pinned-item-list-item")
    check("pinned: button on every card", page.locator(".pinned-item-list-item .grh-btn").count() == pins.count())
    pins.nth(0).hover()
    pins.nth(0).locator(".grh-btn").click()
    page.wait_for_timeout(200)
    check("pinned: card hidden", not pins.nth(0).is_visible())
    page.evaluate("localStorage.setItem('__gm:hiddenRepos', '[]')")

    page.goto(f"https://github.com/{user}?tab=stars", wait_until="domcontentloaded")
    page.wait_for_selector("#user-starred-repos .grh-btn", state="attached", timeout=20000)
    page.wait_for_timeout(300)
    counts = page.evaluate("""() => ({ rows: document.querySelectorAll('#user-starred-repos .col-12.d-block').length,
                                      buttons: document.querySelectorAll('#user-starred-repos .grh-btn').length })""")
    check("stars tab: button on every row", counts["rows"] > 0 and counts["rows"] == counts["buttons"], json.dumps(counts))


def settle(page, quiet=700, timeout=45):
    """Waits for release lookups to stop and returns how many this page load made."""
    deadline = time.time() + timeout
    last, since = -1, time.time()
    while time.time() < deadline:
        count, busy = page.evaluate("[window.__lookups.length, window.__inFlight]")
        if count != last or busy:
            last, since = count, time.time()
        elif (time.time() - since) * 1000 >= quiet:
            return count
        page.wait_for_timeout(100)
    raise TimeoutError(f"release lookups never settled ({last} so far)")


def forget_releases(page):
    # Cleared from a page without rows: one still finishing its lookups would save its cache back.
    page.goto("https://github.com/robots.txt", wait_until="domcontentloaded")
    page.evaluate("""() => {
      for (const key of ['__gm:releaseCache', '__gm:showReleases', '__gm:hiddenRepos', '__mock:releases']) localStorage.removeItem(key);
    }""")


def plan_releases(page, plan):
    page.evaluate("plan => localStorage.setItem('__mock:releases', JSON.stringify(plan))", plan)


def open_repos(page, url):
    page.goto(url, wait_until="domcontentloaded")
    page.wait_for_selector('li[itemprop="owns"] .grh-btn', state="attached", timeout=20000)


def release_rows(page):
    return page.evaluate("""() => [...document.querySelectorAll('li[itemprop="owns"]')].map(row => {
      const chips = row.querySelectorAll('.grh-release');
      const chip = chips[0];
      return {
        repo: row.querySelector('.grh-btn').dataset.repo,
        chips: chips.length,
        text: chip?.textContent ?? null,
        tag: chip?.querySelector('.grh-release__tag')?.textContent ?? null,
        date: chip?.querySelector('time')?.getAttribute('datetime') ?? null,
        shown: chip?.querySelector('time')?.textContent ?? null,
        pre: !!chip?.querySelector('.grh-release__pre'),
        href: chip?.getAttribute('href') ?? null,
        title: chip?.title ?? null,
        onUpdatedLine: chip ? !!chip.parentElement.querySelector(':scope > relative-time') : null,
        first: chip ? chip.parentElement.firstElementChild === chip : null
      };
    })""")


def github_api(page, path):
    return page.evaluate("""async path => {
      const response = await fetch('https://api.github.com' + path);
      return { status: response.status, body: response.ok ? await response.json() : null };
    }""", path)


def releases_live(page, user, shots):
    forget_releases(page)
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    lookups = settle(page)
    rows = release_rows(page)
    with_chip = [row for row in rows if row["tag"]]
    statuses = page.evaluate("window.__statuses.join()")
    check("releases: one lookup per row", lookups == len(rows), f"{lookups}/{len(rows)}, statuses {statuses}")
    busiest = page.evaluate("window.__maxInFlight")
    check("releases: lookups run in parallel, three at most", 1 < busiest <= 3, str(busiest))
    check("releases: rows with a release show it", bool(with_chip), f"{len(with_chip)}/{len(rows)}")
    check("releases: chip opens the Updated line, once per row",
          all(row["chips"] == 1 and row["onUpdatedLine"] and row["first"] for row in with_chip))
    stray = [row["text"] for row in with_chip
             if row["text"] != row["tag"] + (row["shown"] or "") + ("pre-release" if row["pre"] else "")]
    check("releases: chip reads as the tag and date, nothing else", not stray, json.dumps(stray[:3]))

    # Expected values come from the REST API, a different source than the pages the script reads.
    # Anonymous calls are limited to 60 an hour, so only the first rows are compared.
    wrong = []
    compared = 0
    for row in rows[:6]:
        answer = github_api(page, f"/repos/{row['repo']}/releases/latest")
        if answer["status"] == 200:
            compared += 1
            if (row["tag"], row["date"]) != (answer["body"]["tag_name"], answer["body"]["published_at"]):
                wrong.append([row["repo"], row["tag"], row["date"], answer["body"]["tag_name"], answer["body"]["published_at"]])
        elif answer["status"] == 404:
            compared += 1
            if row["tag"] and not row["pre"]:
                wrong.append([row["repo"], row["tag"], "the API has no latest release"])
    check("releases: tag and date match the GitHub API", compared == 6 and not wrong, f"{compared} compared {json.dumps(wrong)}")

    no_chip = [row["repo"] for row in rows if not row["tag"]][:3]
    wrong = []
    for repo in no_chip:
        answer = github_api(page, f"/repos/{repo}/releases?per_page=1")
        if answer["status"] != 200 or answer["body"]:
            wrong.append(repo)
    check("releases: rows without a chip really have no release", not wrong, f"{len(no_chip)} compared {json.dumps(wrong)}")

    # Cached results show at once and cost nothing.
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector('.grh-release', state="attached", timeout=20000)
    lookups = settle(page)
    check("cache: reload makes no lookups", lookups == 0, str(lookups))
    check("cache: reload shows the same releases", release_rows(page) == rows)

    # A changed Updated time and an hour-old entry refresh. Both keep showing until the answer's in.
    # An expired entry for another repo is dropped and another tab's fresh one survives the save.
    planted = page.evaluate("""() => {
      const cache = JSON.parse(localStorage.getItem('__gm:releaseCache'));
      const keys = Object.keys(cache).filter(key => cache[key].tag).slice(0, 2);
      cache[keys[0]].pushed = '2001-01-01T00:00:00Z';
      cache[keys[1]].at = Date.now() - 2 * 60 * 60 * 1000;
      cache['gone/expired'] = { tag: 'v1', pushed: 'x', at: Date.now() - 31 * 24 * 60 * 60 * 1000 };
      cache['other/tab'] = { tag: 'v2', pushed: 'x', at: Date.now() };
      localStorage.setItem('__gm:releaseCache', JSON.stringify(cache));
      return keys;
    }""")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector('.grh-release', state="attached", timeout=20000)
    lookups = settle(page)
    urls = page.evaluate("window.__lookups.map(url => new URL(url).pathname.toLowerCase())")
    check("cache: only the changed and the old entry refresh",
          sorted(urls) == sorted(f"/{key}/releases/latest" for key in planted), json.dumps(urls))
    saved = page.evaluate("JSON.parse(localStorage.getItem('__gm:releaseCache'))")
    check("cache: refreshed entries are saved",
          all(saved[key]["pushed"] != "2001-01-01T00:00:00Z" and time.time() * 1000 - saved[key]["at"] < 60000 for key in planted))
    check("cache: expired entries are dropped, another tab's are kept",
          "gone/expired" not in saved and "other/tab" in saved)
    check("cache: chips match after the refresh", release_rows(page) == rows)

    # The scan must not keep rewriting chips, which would wake its own observer forever.
    churn = page.evaluate("""() => new Promise(done => {
      let writes = 0;
      const inChip = node => node.nodeType === 1 && (node.matches('.grh-release') || node.closest('.grh-release'));
      const observer = new MutationObserver(records => {
        for (const record of records) {
          if (inChip(record.target) || [...record.addedNodes, ...record.removedNodes].some(inChip)) writes++;
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      setTimeout(() => { observer.disconnect(); done(writes); }, 1500);
    })""")
    check("releases: idle page rewrites no chips", churn == 0, str(churn))

    # A pre-release-only repository, when this account has one.
    pre_repo = "PhoneFork"
    open_repos(page, f"https://github.com/{user}?tab=repositories&q={pre_repo}")
    settle(page)
    row = next((row for row in release_rows(page) if row["repo"].lower() == f"{user}/{pre_repo}".lower()), None)
    if row:
        answer = github_api(page, f"/repos/{row['repo']}/releases?per_page=1")
        newest = answer["body"][0] if answer["body"] else {}
        check("pre-release: newest one shows, marked as such",
              row["pre"] and newest.get("prerelease") is True and (row["tag"], row["date"]) == (newest.get("tag_name"), newest.get("published_at")),
              json.dumps([row["tag"], row["date"], row["pre"], newest.get("tag_name"), newest.get("published_at")]))

    # The chip is a working link to that release.
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    page.wait_for_selector('.grh-release', state="attached", timeout=20000)
    settle(page)
    row = next(row for row in release_rows(page) if row["tag"] and not row["pre"])
    page.screenshot(path=str(shots / "releases-live.png"))
    page.locator(f'.grh-release[href="{row["href"]}"]').click()
    page.wait_for_url(f"**{row['href']}", timeout=20000)
    check("releases: chip opens the release page", row["href"] in page.url, page.url)

    # The off switch in the manager.
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    page.wait_for_selector('.grh-release', state="attached", timeout=20000)
    page.evaluate("window.__menu.find(m => m.name.startsWith('Manage')).fn()")
    page.wait_for_selector(".grh-dialog[open]")
    toggle = page.get_by_label("Show the latest release on the Repositories tab")
    check("manager: release switch starts on", toggle.is_checked())
    toggle.uncheck()
    page.wait_for_timeout(300)
    check("switch off: chips disappear", page.locator(".grh-release").count() == 0)
    page.screenshot(path=str(shots / "manager-switches.png"))
    page.click(".grh-dialog__close")
    page.evaluate("localStorage.removeItem('__gm:releaseCache')")
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    lookups = settle(page)
    check("switch off: a fresh load makes no lookups", lookups == 0 and page.locator(".grh-release").count() == 0, str(lookups))


def releases_mocked(page, user):
    forget_releases(page)
    plan_releases(page, {})
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    settle(page)
    names = [row["repo"] for row in release_rows(page)]
    tagged, no_date, pre, empty, missing, broken, kept = names[:7]
    plan = {
        tagged: {"status": 200, "final": f"https://github.com/{tagged}/releases/tag/v9.9.9%2Bbuild", "body": MOCK_TAG_PAGE},
        no_date: {"status": 200, "final": f"https://github.com/{no_date}/releases/tag/v8.0.0", "body": MOCK_TAG_PAGE_NO_DATE},
        pre: {"status": 200, "final": f"https://github.com/{pre}/releases", "body": MOCK_LIST_PAGE.format(repo=pre)},
        empty: {"status": 200, "final": f"https://github.com/{empty}/releases", "body": MOCK_EMPTY_LIST_PAGE},
        missing: {"status": 404},
        broken: {"status": 500},
        kept: {"status": 500},
    }

    # A failed refresh keeps showing what was known, so seed a stale entry for that row.
    forget_releases(page)
    plan_releases(page, plan)
    page.evaluate("""key => localStorage.setItem('__gm:releaseCache', JSON.stringify({
      [key]: { tag: 'v1.0.0', path: '/' + key + '/releases/tag/v1.0.0', date: '2026-01-02T15:00:00Z', pre: false, pushed: 'old', at: Date.now() - 7200000 }
    }))""", kept.lower())
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    settle(page)
    rows = {row["repo"]: row for row in release_rows(page)}

    row = rows[tagged]
    check("mock: tag comes from the redirect, decoded", row["tag"] == "v9.9.9+build", str(row["tag"]))
    check("mock: date comes from inside <main>", row["date"] == "2026-11-06T02:36:04Z", str(row["date"]))
    check("mock: date reads in local time", row["shown"] == "Nov 5, 2026", str(row["shown"]))
    check("mock: tooltip names the release and the time", row["title"] == "Latest release: v9.9.9+build, published Nov 5, 2026, 9:36 PM", str(row["title"]))
    check("mock: link keeps the encoded tag", row["href"] == f"/{tagged}/releases/tag/v9.9.9%2Bbuild", str(row["href"]))
    row = rows[no_date]
    check("mock: a page with no date shows only the tag", row["text"] == "v8.0.0" and row["date"] is None, json.dumps(row))
    row = rows[pre]
    check("mock: drafts are skipped for the newest pre-release",
          row["text"] == "v2.0.0-rc1Mar 4, 2026pre-release" and row["date"] == "2026-03-04T17:00:00Z", json.dumps(row))
    check("mock: no releases, no chip", rows[empty]["chips"] == 0, json.dumps(rows[empty]))
    check("mock: 404, no chip", rows[missing]["chips"] == 0, json.dumps(rows[missing]))
    check("mock: 500, no chip", rows[broken]["chips"] == 0, json.dumps(rows[broken]))
    check("mock: failed refresh keeps the old release", rows[kept]["tag"] == "v1.0.0", json.dumps(rows[kept]))
    check("mock: failures raise one message", page.locator(".grh-toast--danger").count() == 1, str(page.locator(".grh-toast--danger").count()))

    # New rows wake the scan, which must leave the failed lookups alone for now.
    before = page.evaluate("window.__lookups.length")
    page.evaluate("document.body.append(document.createElement('div'))")
    page.wait_for_timeout(500)
    check("mock: failed lookups wait before retrying", settle(page) == before, str(before))

    # Hidden rows make no requests until they're revealed.
    forget_releases(page)
    plan_releases(page, plan)
    page.evaluate("repo => localStorage.setItem('__gm:hiddenRepos', JSON.stringify([repo]))", tagged)
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    settle(page)
    wanted = f"/{tagged}/releases/latest".lower()
    paths = lambda: page.evaluate("window.__lookups.map(url => new URL(url).pathname.toLowerCase())")
    check("hidden: hidden rows make no lookup", wanted not in paths(), str(len(paths())))
    page.locator('.grh-pill__btn[data-grh-action="reveal"]').click()
    settle(page)
    shown = next(row for row in release_rows(page) if row["repo"] == tagged)
    check("hidden: revealing a row looks it up", wanted in paths() and shown["tag"] == "v9.9.9+build", json.dumps(shown))

    # A 429 pauses every lookup for as long as GitHub asks, then the rest carry on.
    forget_releases(page)
    plan_releases(page, {tagged: {"status": 429, "headers": {"Retry-After": "3"}}})
    open_repos(page, f"https://github.com/{user}?tab=repositories")
    page.wait_for_timeout(1500)
    paused = page.evaluate("window.__lookups.length")
    total = len(release_rows(page))
    check("429: lookups pause", 0 < paused < total, f"{paused}/{total}")
    check("429: one message", page.locator(".grh-toast--danger").count() == 1)
    page.wait_for_timeout(3000)
    settle(page)
    resumed = page.evaluate("window.__lookups.length")
    check("429: the rest carry on after the wait", resumed == total, f"{resumed}/{total}")
    forget_releases(page)


def capture(page, html_path, css_path, shots):
    html = Path(html_path).read_text(encoding="utf-8")
    page.route("https://github.com/__grh_capture", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))
    page.route("**/*.js", lambda r: r.abort())
    # The capture is a signed-in page, so its private repositories answer from a plan.
    forget_releases(page)
    plan_releases(page, {"*": {"status": 200, "final": "https://github.com/{repo}/releases/tag/v1.2.3", "body": MOCK_TAG_PAGE}})
    page.goto("https://github.com/__grh_capture", wait_until="domcontentloaded")
    if css_path:
        page.add_style_tag(content=Path(css_path).read_text(encoding="utf-8"))
    page.wait_for_selector(".starring-container .grh-btn", state="attached", timeout=20000)
    page.wait_for_timeout(300)
    info = page.evaluate("""() => {
      const rows = document.querySelectorAll('li[itemprop="owns"]');
      const sc = rows[0].querySelector('.starring-container');
      const btn = sc.querySelector('.grh-btn');
      const star = [...sc.children].find(c => c !== btn && getComputedStyle(c).display !== 'none').getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return { rows: rows.length, buttons: document.querySelectorAll('.starring-container > .grh-btn--text').length,
               icons: document.querySelectorAll('li[itemprop="owns"] .grh-btn--icon').length,
               sameRow: Math.abs((star.top + star.bottom) / 2 - (b.top + b.bottom) / 2) < 3, rightOfStar: b.left >= star.right };
    }""")
    check("capture: Hide sits right of Star on every row",
          info["sameRow"] and info["rightOfStar"] and info["buttons"] == info["rows"] and info["icons"] == 0, json.dumps(info))

    # Regression: a row whose Star column streams in after the first scan.
    late = page.evaluate("""async () => {
      const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
      const src = document.querySelector('li[itemprop="owns"]');
      const row = src.cloneNode(true);
      row.querySelectorAll('.grh-btn').forEach(b => b.remove());
      row.removeAttribute('data-grh-item');
      const column = row.querySelector(':scope > .col-2');
      column.remove();
      src.before(row);
      await frame();
      const before = row.querySelector('.grh-btn')?.className || null;
      row.append(column);
      await frame();
      return { before, after: [...row.querySelectorAll('.grh-btn')].map(b => b.className),
               inStar: !!row.querySelector('.starring-container > .grh-btn--text') };
    }""")
    check("capture: late Star column gets the real button",
          late["inStar"] and len(late["after"]) == 1 and "grh-btn--icon" in (late["before"] or ""), json.dumps(late))

    settle(page)
    layout = page.evaluate("""() => {
      const rows = [...document.querySelectorAll('li[itemprop="owns"]')].filter(row => row.querySelector('.grh-release'));
      const sameLine = row => {
        const chip = row.querySelector('.grh-release').getBoundingClientRect();
        const updated = row.querySelector('relative-time').getBoundingClientRect();
        return Math.abs(chip.top - updated.top) < 6 && chip.right <= updated.left;
      };
      // The line wraps only when its parts can't fit, with the release still ahead of Updated.
      const wrappedForRoom = row => {
        const chip = row.querySelector('.grh-release').getBoundingClientRect();
        const updated = row.querySelector('relative-time').getBoundingClientRect();
        const line = row.querySelector('relative-time').parentElement;
        line.style.whiteSpace = 'nowrap';
        const tooWide = line.scrollWidth > line.clientWidth;
        line.style.whiteSpace = '';
        return tooWide && chip.top < updated.top;
      };
      return { rows: document.querySelectorAll('li[itemprop="owns"]').length, chips: rows.length,
               sameLine: rows.filter(sameLine).length, wrapped: rows.filter(row => !sameLine(row) && wrappedForRoom(row)).length };
    }""")
    check("capture: every row shows its release left of Updated, wrapping only for lack of room",
          layout["chips"] == layout["rows"] and layout["sameLine"] + layout["wrapped"] == layout["rows"], json.dumps(layout))

    # Regression: a row whose metadata line streams in after the first scan.
    late = page.evaluate("""async () => {
      const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 30)));
      const src = document.querySelector('li[itemprop="owns"]');
      const row = src.cloneNode(true);
      row.querySelectorAll('.grh-btn, .grh-release').forEach(node => node.remove());
      const line = row.querySelector('relative-time').parentElement;
      line.remove();
      src.before(row);
      await frame();
      const before = row.querySelectorAll('.grh-release').length;
      row.firstElementChild.append(line);
      await frame();
      return { before, after: row.querySelectorAll('.grh-release').length,
               onLine: !!line.querySelector(':scope > .grh-release'), first: line.firstElementChild?.className };
    }""")
    check("capture: late metadata line gets its release",
          late["before"] == 0 and late["after"] == 1 and late["onLine"], json.dumps(late))
    page.locator('li[itemprop="owns"]').nth(1).screenshot(path=str(shots / "capture-row.png"))
    forget_releases(page)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", default="SysAdminDoc", help="public GitHub account to test against")
    ap.add_argument("--capture-html", help="saved logged-in Repositories tab HTML")
    ap.add_argument("--capture-css", help="CSS to apply to the capture")
    ap.add_argument("--shots", default=str(Path(tempfile.gettempdir()) / "grh-shots"))
    args = ap.parse_args()
    shots = Path(args.shots)
    shots.mkdir(parents=True, exist_ok=True)

    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000}, color_scheme="dark",
                                  locale="en-US", timezone_id="America/New_York")
        ctx.add_init_script(GM_SHIM)
        ctx.add_init_script(SCRIPT)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))

        def script_error(message):
            if message.type == "error" and "GitHub Repo Hider" in message.text:
                errors.append(message.text)

        page.on("console", script_error)
        # This pass doesn't test lookups. Real ones would double the requests GitHub sees from a run.
        forget_releases(page)
        plan_releases(page, {})
        live(page, args.user, shots)
        releases_live(page, args.user, shots)
        releases_mocked(page, args.user)
        if args.capture_html:
            capture(page, args.capture_html, args.capture_css, shots)
        check("no script errors", not errors, " | ".join(errors[:3]))
        browser.close()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed. Screenshots in {shots}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
