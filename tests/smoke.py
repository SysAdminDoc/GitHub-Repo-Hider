"""Headless smoke test for github-repo-hider.user.js.

Runs the script against live public GitHub pages (logged out) and, when given one, a saved
logged-in capture of a Repositories tab, which is the only way to see the Star button markup
without signing in. See the README for usage.
"""
import argparse
import json
import sys
import tempfile
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
})();
"""

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
    page.locator('.grh-pill__btn[data-grh-action="reveal"]').count() and page.locator('.grh-pill__btn[data-grh-action="reveal"]').click()

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


def capture(page, html_path, css_path, shots):
    html = Path(html_path).read_text(encoding="utf-8")
    page.route("https://github.com/__grh_capture", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=html))
    page.route("**/*.js", lambda r: r.abort())
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
    page.locator('li[itemprop="owns"]').nth(1).screenshot(path=str(shots / "capture-row.png"))


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
        ctx = browser.new_context(viewport={"width": 1400, "height": 1000}, color_scheme="dark")
        ctx.add_init_script(GM_SHIM)
        ctx.add_init_script(SCRIPT)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: m.type == "error" and "GitHub Repo Hider" in m.text and errors.append(m.text))
        live(page, args.user, shots)
        if args.capture_html:
            capture(page, args.capture_html, args.capture_css, shots)
        check("no script errors", not errors, " | ".join(errors[:3]))
        browser.close()

    failed = [name for name, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed. Screenshots in {shots}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
