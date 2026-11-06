// ==UserScript==
// @name         GitHub Repo Hider
// @namespace    https://github.com/SysAdminDoc/GitHub-Repo-Hider
// @version      0.0.3
// @description  Hide chosen repositories from your GitHub profile, pinned cards, Stars tab and dashboard sidebar. Adds a Hide button next to Star, and shows each repo's latest release and its date on the Repositories tab.
// @author       SysAdminDoc
// @license      MIT
// @match        https://github.com/*
// @icon         https://github.githubassets.com/favicons/favicon-dark.svg
// @homepageURL  https://github.com/SysAdminDoc/GitHub-Repo-Hider
// @supportURL   https://github.com/SysAdminDoc/GitHub-Repo-Hider/issues
// @updateURL    https://raw.githubusercontent.com/SysAdminDoc/GitHub-Repo-Hider/main/github-repo-hider.user.js
// @downloadURL  https://raw.githubusercontent.com/SysAdminDoc/GitHub-Repo-Hider/main/github-repo-hider.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @grant        GM_setClipboard
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // @noframes alone doesn't stop every manager from running in about:blank frames.
  if (window.top !== window.self) return;

  const VERSION = '0.0.3';
  const LOG = `[GitHub Repo Hider ${VERSION}]`;
  const KEY_HIDDEN = 'hiddenRepos';
  const KEY_PILL = 'showPill';
  const KEY_SHOW_RELEASES = 'showReleases';
  const KEY_RELEASES = 'releaseCache';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const RELEASE_REFRESH_MS = 60 * 60 * 1000; // A cached release is rechecked after this long.
  const RELEASE_KEEP_MS = 30 * 24 * 60 * 60 * 1000; // Cache entries not seen for this long are dropped.
  const RELEASE_RETRY_MS = 5 * 60 * 1000; // A failed lookup waits this long before trying again.
  const RELEASE_WORKERS = 3;
  const RELEASE_SAVE_EVERY = 5;
  const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const FULL_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  // First path segments that are GitHub pages, never repository owners.
  const RESERVED = new Set([
    'about', 'account', 'apps', 'codespaces', 'collections', 'contact', 'copilot', 'customer-stories',
    'dashboard', 'enterprise', 'events', 'explore', 'features', 'issues', 'login', 'logout',
    'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'readme',
    'search', 'security', 'sessions', 'settings', 'signup', 'site', 'sponsors', 'stars', 'team',
    'topics', 'trending', 'users'
  ]);
  const OWNER_RE = /^[a-z\d][a-z\d-]{0,38}$/i;
  const REPO_RE = /^[\w.-]{1,100}$/;

  // Primer octicons (16px).
  const ICONS = {
    tag: 'M1 7.775V2.75C1 1.784 1.784 1 2.75 1h5.025c.464 0 .91.184 1.238.513l6.25 6.25a1.75 1.75 0 0 1 0 2.474l-5.026 5.026a1.75 1.75 0 0 1-2.474 0l-6.25-6.25A1.752 1.752 0 0 1 1 7.775Zm1.5 0c0 .066.026.13.073.177l6.25 6.25a.25.25 0 0 0 .354 0l5.025-5.025a.25.25 0 0 0 0-.354l-6.25-6.25a.25.25 0 0 0-.177-.073H2.75a.25.25 0 0 0-.25.25ZM6 5a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z',
    eye:'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z',
    eyeClosed: 'M.143 2.31a.75.75 0 0 1 1.047-.167l14.5 10.5a.75.75 0 1 1-.88 1.214l-2.248-1.628C11.346 13.19 9.792 14 8 14c-1.981 0-3.67-.992-4.933-2.078C1.797 10.832.88 9.577.43 8.9a1.619 1.619 0 0 1 0-1.797c.353-.533.995-1.42 1.868-2.305L.31 3.357A.75.75 0 0 1 .143 2.31Zm1.536 5.622A.12.12 0 0 0 1.657 8c0 .021.006.045.022.068.412.621 1.242 1.75 2.366 2.717C5.175 11.758 6.527 12.5 8 12.5c1.195 0 2.31-.488 3.29-1.191L9.063 9.695A2 2 0 0 1 6.058 7.52L3.529 5.688a14.207 14.207 0 0 0-1.85 2.244ZM8 3.5c-.516 0-1.017.09-1.499.251a.75.75 0 1 1-.473-1.423A6.207 6.207 0 0 1 8 2c1.981 0 3.67.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.11.166-.248.365-.41.587a.75.75 0 1 1-1.21-.887c.148-.201.272-.382.371-.53a.119.119 0 0 0 0-.137c-.412-.621-1.242-1.75-2.366-2.717C10.825 4.242 9.473 3.5 8 3.5Z',
    x: 'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z'
  };

  // Places a repository shows up as a card or row. `link` returns the anchor that names the repo,
  // `button` picks the Hide button style: 'star' sits next to the Star button, 'icon' after the
  // title on hover, null adds no button (React-managed lists, where foreign nodes are unsafe).
  const TARGETS = [
    { // Profile Repositories tab
      item: 'li[itemprop="owns"]',
      link: item => item.querySelector('a[itemprop~="codeRepository"]') || item.querySelector('h3 a'),
      button: 'star',
      release: true
    },
    { // Stars tab
      item: '#user-starred-repos .col-12.d-block',
      link: item => item.querySelector('h3 a') || item.querySelector('h2 a'),
      button: 'star'
    },
    { // Pinned and "Popular repositories" cards on a profile overview
      item: '.pinned-item-list-item',
      link: item => item.querySelector('.repo')?.closest('a') || null,
      button: 'icon'
    },
    { // Dashboard "Top repositories" sidebar
      item: '#dashboard-repos-container li, .dashboard-sidebar li, [data-filterable-for^="dashboard-repos-filter"] > li',
      link: firstRepoLink,
      button: null
    },
    { // Global navigation side panel
      item: 'deferred-side-panel li',
      link: firstRepoLink,
      button: null
    }
  ];

  // ---------------------------------------------------------------- storage

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  function readValue(key, fallback) {
    try {
      if (hasGM) return GM_getValue(key, fallback);
      const raw = localStorage.getItem(`grh:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      console.warn(LOG, `Could not read ${key}`, err);
      return fallback;
    }
  }

  function writeValue(key, value) {
    try {
      if (hasGM) GM_setValue(key, value);
      else localStorage.setItem(`grh:${key}`, JSON.stringify(value));
      return true;
    } catch (err) {
      console.error(LOG, `Could not save ${key}`, err);
      toast('Could not save your changes. Details are in the browser console.', { tone: 'danger' });
      return false;
    }
  }

  // ------------------------------------------------------------------ state

  const hidden = new Map(); // lowercase "owner/repo" -> display form
  let reveal = false;
  let showPill = readValue(KEY_PILL, true) !== false;
  let showReleases = readValue(KEY_SHOW_RELEASES, true) !== false;

  function loadHidden(list) {
    hidden.clear();
    for (const entry of Array.isArray(list) ? list : []) {
      const repo = parseRepo(entry);
      if (repo) hidden.set(repo.toLowerCase(), repo);
    }
  }

  function saveHidden() {
    const list = [...hidden.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    writeValue(KEY_HIDDEN, list);
  }

  const isHidden = repo => hidden.has(repo.toLowerCase());

  // Hide and unhide are silent: the row vanishing (or the manager list changing) is the feedback.
  function hideRepos(repos) {
    const added = repos.filter(repo => !isHidden(repo));
    if (!added.length) return;
    for (const repo of added) hidden.set(repo.toLowerCase(), repo);
    commit();
  }

  function unhideRepos(repos) {
    const removed = repos.filter(isHidden).map(repo => hidden.get(repo.toLowerCase()));
    if (!removed.length) return;
    for (const repo of removed) hidden.delete(repo.toLowerCase());
    commit();
  }

  function clearAll() {
    if (!hidden.size) {
      toast('Nothing is hidden right now');
      return;
    }
    const snapshot = [...hidden.values()];
    hidden.clear();
    commit();
    toast(`Cleared ${snapshot.length} hidden ${snapshot.length === 1 ? 'repository' : 'repositories'}`,
      { action: 'Undo', onAction: () => hideRepos(snapshot) });
  }

  function commit() {
    saveHidden();
    queueScan();
    if (dialog?.open) renderManager();
  }

  function setReveal(on) {
    reveal = on;
    document.documentElement.classList.toggle('grh-reveal', reveal);
    queueScan();
    if (dialog?.open) renderManager();
  }

  function setShowPill(on) {
    showPill = on;
    writeValue(KEY_PILL, on);
    queueScan();
  }

  function setShowReleases(on) {
    showReleases = on;
    writeValue(KEY_SHOW_RELEASES, on);
    queueScan();
  }

  // ---------------------------------------------------------------- parsing

  // Accepts "owner/repo", "repo" (owner defaults to you), or any github.com URL inside a repo.
  function parseRepo(raw, defaultOwner) {
    let text = String(raw ?? '').trim();
    if (!text) return null;
    text = text.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').split(/[?#]/)[0];
    const parts = text.split('/').filter(Boolean);
    if (parts.length === 1 && defaultOwner) parts.unshift(defaultOwner);
    if (parts.length < 2) return null;
    const owner = parts[0];
    const name = parts[1].replace(/\.git$/i, '');
    if (!OWNER_RE.test(owner) || RESERVED.has(owner.toLowerCase())) return null;
    if (!REPO_RE.test(name) || name === '.' || name === '..') return null;
    return `${owner}/${name}`;
  }

  // Only exact repository links count, so /owner/repo/stargazers or /topics/x never match.
  function repoFromLink(link) {
    const href = link?.getAttribute('href');
    if (!href) return null;
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    if (url.origin !== location.origin) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    try {
      return parseRepo(parts.map(decodeURIComponent).join('/'));
    } catch {
      return null;
    }
  }

  function firstRepoLink(item) {
    let fallback = null;
    for (const link of item.querySelectorAll('a[href]')) {
      if (!repoFromLink(link)) continue;
      if (link.textContent.trim()) return link;
      fallback ??= link;
    }
    return fallback;
  }

  const currentLogin = () => document.querySelector('meta[name="user-login"]')?.content || null;

  // -------------------------------------------------------------------- dom

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value == null || value === false) continue;
      if (key === 'dataset') Object.assign(el.dataset, value);
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.filter(child => child != null && child !== false));
    return el;
  }

  function icon(name, extraClass = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 16 16', width: '16', height: '16', fill: 'currentColor',
      'aria-hidden': 'true', class: `octicon ${extraClass}`.trim()
    })) svg.setAttribute(key, value);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  // Writing identical text still fires a mutation, which would queue another scan forever.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  // ------------------------------------------------------------------- scan

  let scanQueued = false;

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(runScan);
  }

  function runScan() {
    scanQueued = false;
    try {
      scan();
    } catch (err) {
      reportError(err);
    }
  }

  function scan() {
    const seen = new Set();
    const matched = new Set();
    let count = 0;
    releaseQueue.clear(); // Rebuilt below, so rows that left the page stop costing requests.

    for (const target of TARGETS) {
      for (const item of document.querySelectorAll(target.item)) {
        if (seen.has(item)) continue;
        seen.add(item);
        const link = target.link(item);
        const repo = repoFromLink(link);
        if (!repo) continue;

        const off = isHidden(repo);
        if (!item.hasAttribute('data-grh-item')) item.setAttribute('data-grh-item', '');
        if (off !== item.hasAttribute('data-grh-hidden')) item.toggleAttribute('data-grh-hidden', off);
        if (off) {
          matched.add(item);
          count++;
        }
        if (target.button) syncButton(item, link, repo, target.button, off);
        if (target.release) syncRelease(item, repo, off);
      }
    }
    pumpReleases();

    // A reused node that no longer names a hidden repo must come back.
    for (const el of document.querySelectorAll('[data-grh-hidden]')) {
      if (!matched.has(el)) el.removeAttribute('data-grh-hidden');
    }

    updatePill(count);
  }

  function syncButton(item, link, repo, kind, off) {
    // A scan can land while the row is still streaming in, before its Star column exists. The
    // title fallback placed then gets swapped for the real button once the column arrives.
    const starring = kind === 'star' ? item.querySelector('.starring-container') : null;
    let button = item.querySelector('.grh-btn');
    if (button && starring && button.parentElement !== starring) {
      button.remove();
      button = null;
    }
    if (!button) {
      if (starring) {
        button = h('button', { type: 'button', class: 'btn btn-sm grh-btn grh-btn--text' });
        starring.append(button);
      } else {
        button = h('button', { type: 'button', class: 'grh-btn grh-btn--icon' });
        link.after(button);
      }
    }
    if (button.dataset.repo !== repo) button.dataset.repo = repo;

    const state = off ? 'hidden' : 'shown';
    if (button.dataset.state === state) return;
    button.dataset.state = state;
    const label = off ? `Unhide ${repo}` : `Hide ${repo} from your view`;
    button.setAttribute('aria-label', label);
    button.title = label;
    if (button.classList.contains('grh-btn--text')) {
      button.replaceChildren(icon(off ? 'eye' : 'eyeClosed', 'mr-1'), off ? 'Unhide' : 'Hide');
    } else {
      button.replaceChildren(icon(off ? 'eye' : 'eyeClosed'));
    }
  }

  // --------------------------------------------------------------- releases

  // Lookups use the same github.com pages a person would open, so private repositories work with
  // the signed-in session and no API token is needed. The API allows 60 anonymous calls an hour.
  const RELEASE_TIME_RE = /<relative-time\b[^>]*\bdatetime="([^"]+)"/;
  const RELEASE_PATH_RE = /^\/[^/]+\/[^/]+\/releases\/tag\/(.+)$/;
  const RELEASE_LINK_RE = /href="(\/[^"/]+\/[^"/]+\/releases\/tag\/[^"]+)"/;
  const hasReleaseLabel = (html, label) => new RegExp(`class="Label[^"]*"[^>]*>\\s*${label}\\s*<`).test(html);

  const releases = readReleases(); // lowercase "owner/repo" -> { tag, path, date, pre, pushed, at }; tag is null when there's none
  const releaseQueue = new Map(); // lowercase "owner/repo" -> { repo, pushed }
  const releaseBusy = new Set();
  const releaseDirty = new Map();
  const releaseRetryAt = new Map();
  let releasePausedUntil = 0;
  let releaseErrorShown = false;

  function readReleases() {
    const stored = readValue(KEY_RELEASES, {});
    const kept = {};
    for (const [key, entry] of Object.entries(stored && typeof stored === 'object' ? stored : {})) {
      if (entry && Date.now() - entry.at < RELEASE_KEEP_MS) kept[key] = entry;
    }
    return kept;
  }

  // Another tab may have saved since this one loaded, so merge rather than overwrite its entries.
  function saveReleases() {
    if (!releaseDirty.size) return;
    Object.assign(releases, readReleases(), Object.fromEntries(releaseDirty));
    releaseDirty.clear();
    writeValue(KEY_RELEASES, releases);
  }

  // /releases/latest redirects to the tag page, or to the full list when no release counts as
  // latest. That happens with no releases at all and when every release is a pre-release.
  function parseRelease(finalPath, html) {
    if (RELEASE_PATH_RE.test(finalPath)) {
      const main = html.slice(Math.max(html.indexOf('<main'), 0));
      return { path: finalPath, date: RELEASE_TIME_RE.exec(main)?.[1] || null, pre: false };
    }
    for (const card of html.split(/\bdata-release-anchor=/).slice(1)) {
      if (hasReleaseLabel(card, 'Draft')) continue;
      const path = RELEASE_LINK_RE.exec(card)?.[1];
      if (path) return { path, date: RELEASE_TIME_RE.exec(card)?.[1] || null, pre: hasReleaseLabel(card, 'Pre-release') };
    }
    return null;
  }

  function storeRelease(key, release, pushed) {
    const entry = release
      ? { tag: decodeURIComponent(RELEASE_PATH_RE.exec(release.path)[1]), ...release, pushed, at: Date.now() }
      : { tag: null, pushed, at: Date.now() };
    releases[key] = entry;
    releaseDirty.set(key, entry);
  }

  function releaseTrouble(key, repo, detail) {
    console.warn(LOG, `Could not look up the latest release of ${repo}`, detail);
    releaseRetryAt.set(key, Date.now() + RELEASE_RETRY_MS);
    if (releaseErrorShown) return;
    releaseErrorShown = true;
    toast('Could not load some release info. Details are in the browser console.', { tone: 'danger' });
  }

  async function lookupRelease(key, { repo, pushed }) {
    try {
      const response = await fetch(`${location.origin}/${repo}/releases/latest`, { credentials: 'same-origin' });
      if (response.status === 404) {
        storeRelease(key, null, pushed);
      } else if (response.ok) {
        storeRelease(key, parseRelease(new URL(response.url).pathname, await response.text()), pushed);
      } else {
        if (response.status === 429) {
          const wait = (Number(response.headers.get('Retry-After')) || RELEASE_RETRY_MS / 1000) * 1000;
          releasePausedUntil = Date.now() + wait;
          setTimeout(queueScan, wait + 50);
        }
        releaseTrouble(key, repo, `HTTP ${response.status}`);
      }
    } catch (err) {
      releaseTrouble(key, repo, err);
    }
  }

  function pumpReleases() {
    if (Date.now() < releasePausedUntil) return;
    while (releaseBusy.size < RELEASE_WORKERS && releaseQueue.size) {
      const [key, job] = releaseQueue.entries().next().value;
      releaseQueue.delete(key);
      releaseBusy.add(key);
      lookupRelease(key, job).finally(() => {
        releaseBusy.delete(key);
        if (!releaseBusy.size || releaseDirty.size >= RELEASE_SAVE_EVERY) saveReleases();
        queueScan();
      });
    }
  }

  function syncRelease(item, repo, off) {
    // The "Updated" time closes the row's metadata line, so finding it means the line has fully
    // streamed in. It also skips the "Forked from" line, which has the same classes.
    const updated = item.querySelector('relative-time[datetime]');
    if (!updated) return;
    const key = repo.toLowerCase();
    const entry = showReleases ? releases[key] : null;
    renderRelease(updated.parentElement, entry);

    if (!showReleases || (off && !reveal) || releaseBusy.has(key)) return;
    const pushed = updated.getAttribute('datetime');
    const fresh = entry && entry.pushed === pushed && Date.now() - entry.at < RELEASE_REFRESH_MS;
    if (!fresh && Date.now() >= (releaseRetryAt.get(key) || 0)) releaseQueue.set(key, { repo, pushed });
  }

  function renderRelease(line, entry) {
    let chip = line.querySelector(':scope > .grh-release');
    if (!entry?.tag) {
      chip?.remove();
      return;
    }
    const signature = `${entry.path}|${entry.date}|${entry.pre}`;
    if (chip?.dataset.signature === signature) return;
    if (!chip) {
      chip = h('a', { class: 'grh-release Link--muted' });
      line.prepend(chip);
    }
    chip.dataset.signature = signature;
    chip.setAttribute('href', entry.path);

    const when = entry.date ? new Date(entry.date) : null;
    const valid = when && !Number.isNaN(when.getTime());
    chip.title = `Latest ${entry.pre ? 'pre-release' : 'release'}: ${entry.tag}${valid ? `, published ${FULL_FORMAT.format(when)}` : ''}`;
    chip.replaceChildren(...[
      icon('tag'),
      h('span', { class: 'grh-release__tag' }, entry.tag),
      valid && h('time', { class: 'grh-release__date', datetime: entry.date }, DAY_FORMAT.format(when)),
      entry.pre && h('span', { class: 'grh-release__pre' }, 'pre-release')
    ].filter(Boolean));
  }

  // ------------------------------------------------------------------- pill

  let pill = null;

  function updatePill(count) {
    if (!document.body) return;
    // Turbo restores cached snapshots that still contain an old copy of the pill.
    for (const node of document.querySelectorAll('.grh-pill')) {
      if (node !== pill) node.remove();
    }
    if (!showPill || count === 0) {
      pill?.remove();
      return;
    }
    if (!pill) {
      pill = h('div', { class: 'grh-pill', role: 'region', 'aria-label': 'Hidden repositories' },
        icon('eyeClosed'),
        h('span', { class: 'grh-pill__count' }),
        h('button', { type: 'button', class: 'grh-pill__btn', dataset: { grhAction: 'reveal' } }),
        h('button', { type: 'button', class: 'grh-pill__btn', dataset: { grhAction: 'manage' } }, 'Manage'));
    }
    setText(pill.querySelector('.grh-pill__count'), `${count} hidden`);
    setText(pill.querySelector('[data-grh-action="reveal"]'), reveal ? 'Hide again' : 'Show');
    if (!pill.isConnected) document.body.append(pill);
  }

  // ----------------------------------------------------------------- toasts

  let toastHost = null;

  function toast(message, { action, onAction, tone = 'info', timeout = 6000 } = {}) {
    const parent = dialog?.open ? dialog : document.body;
    if (!parent) {
      console.info(LOG, message);
      return;
    }
    if (!toastHost) toastHost = h('div', { class: 'grh-toasts', role: 'status', 'aria-live': 'polite' });
    if (toastHost.parentNode !== parent) parent.append(toastHost);

    const el = h('div', { class: `grh-toast grh-toast--${tone}` }, h('span', { class: 'grh-toast__text' }, message));
    let timer = 0;
    const dismiss = () => {
      clearTimeout(timer);
      el.classList.add('grh-toast--out');
      setTimeout(() => el.remove(), 180);
    };
    if (action && onAction) {
      const actionBtn = h('button', { type: 'button', class: 'grh-toast__action' }, action);
      actionBtn.addEventListener('click', () => {
        dismiss();
        onAction();
      });
      el.append(actionBtn);
    }
    const closeBtn = h('button', { type: 'button', class: 'grh-toast__close', 'aria-label': 'Dismiss' }, icon('x'));
    closeBtn.addEventListener('click', dismiss);
    el.append(closeBtn);

    toastHost.append(el);
    while (toastHost.children.length > 3) toastHost.firstElementChild.remove();
    timer = setTimeout(dismiss, timeout);
  }

  let errorShown = false;

  function reportError(err) {
    console.error(LOG, err);
    if (errorShown) return;
    errorShown = true;
    toast('GitHub Repo Hider hit an error. Details are in the browser console.', { tone: 'danger', timeout: 10000 });
  }

  // ---------------------------------------------------------------- manager

  let dialog = null;
  const ui = {};

  function buildManager() {
    ui.count = h('span', { class: 'Counter' });
    ui.close = h('button', { type: 'button', class: 'grh-dialog__close', 'aria-label': 'Close' }, icon('x'));
    ui.input = h('input', {
      type: 'text', class: 'form-control grh-dialog__input', 'aria-label': 'Repositories to hide',
      placeholder: 'owner/repo, a GitHub link, or several at once', autocomplete: 'off', spellcheck: 'false'
    });
    ui.form = h('form', { class: 'grh-dialog__form', 'data-turbo': 'false' },
      ui.input, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Hide'));
    ui.error = h('p', { class: 'grh-dialog__error', hidden: true });
    ui.list = h('ul', { class: 'grh-dialog__list' });
    ui.empty = h('p', { class: 'grh-dialog__empty' },
      'Nothing is hidden yet. Use the Hide button next to Star on your Repositories tab, or type names above.');
    ui.pillToggle = h('input', { type: 'checkbox' });
    ui.releaseToggle = h('input', { type: 'checkbox' });
    ui.reveal = h('button', { type: 'button', class: 'btn btn-sm' });
    ui.copy = h('button', { type: 'button', class: 'btn btn-sm' }, 'Copy list');
    ui.clear = h('button', { type: 'button', class: 'btn btn-sm btn-danger' }, 'Clear all');

    dialog = h('dialog', { class: 'grh-dialog', 'aria-labelledby': 'grh-dialog-title' },
      h('div', { class: 'grh-dialog__inner' },
        h('header', { class: 'grh-dialog__header' },
          h('h2', { id: 'grh-dialog-title', class: 'grh-dialog__title' }, 'Hidden repositories ', ui.count),
          ui.close),
        h('p', { class: 'grh-dialog__hint' },
          'Hidden repositories drop out of your profile, pinned cards, Stars tab and dashboard sidebar. ' +
          'Only this browser sees the change. Nothing on GitHub is modified.'),
        ui.form,
        ui.error,
        ui.list,
        ui.empty,
        h('footer', { class: 'grh-dialog__footer' },
          h('div', { class: 'grh-dialog__checks' },
            h('label', { class: 'grh-dialog__check' }, ui.pillToggle, ' Show the hidden count in the corner'),
            h('label', { class: 'grh-dialog__check' }, ui.releaseToggle, ' Show the latest release on the Repositories tab')),
          h('div', { class: 'grh-dialog__actions' }, ui.reveal, ui.copy, ui.clear))));

    ui.close.addEventListener('click', () => dialog.close());
    // A click that lands on the dialog element itself is a click on the backdrop.
    dialog.addEventListener('click', event => {
      if (event.target === dialog) dialog.close();
    });
    ui.form.addEventListener('submit', event => {
      event.preventDefault();
      addFromInput();
    });
    ui.list.addEventListener('click', event => {
      const button = event.target.closest('[data-grh-unhide]');
      if (button) unhideRepos([button.dataset.grhUnhide]);
    });
    ui.pillToggle.addEventListener('change', () => setShowPill(ui.pillToggle.checked));
    ui.releaseToggle.addEventListener('change', () => setShowReleases(ui.releaseToggle.checked));
    ui.reveal.addEventListener('click', () => setReveal(!reveal));
    ui.copy.addEventListener('click', copyList);
    ui.clear.addEventListener('click', clearAll);
  }

  function addFromInput() {
    const owner = currentLogin();
    const tokens = ui.input.value.split(/[\s,;]+/).filter(Boolean);
    const valid = [];
    const invalid = [];
    for (const token of tokens) {
      const repo = parseRepo(token, owner);
      if (repo) valid.push(repo);
      else invalid.push(token);
    }
    if (valid.length) hideRepos(valid);
    ui.input.value = invalid.join(' ');
    ui.error.hidden = !invalid.length;
    ui.error.textContent = invalid.length
      ? `Couldn't read ${invalid.join(', ')}. Use owner/repo or a GitHub link${owner ? '' : ' (sign in to use a bare repo name)'}.`
      : '';
  }

  async function copyList() {
    const text = [...hidden.values()].join('\n');
    if (!text) {
      toast('Nothing is hidden right now');
      return;
    }
    try {
      if (typeof GM_setClipboard === 'function') GM_setClipboard(text, 'text');
      else await navigator.clipboard.writeText(text);
      toast(`Copied ${hidden.size} ${hidden.size === 1 ? 'repository' : 'repositories'}. Paste the list into the box on another browser to bring it over.`);
    } catch (err) {
      console.error(LOG, 'Clipboard write failed', err);
      toast('Copy failed. Your browser blocked clipboard access.', { tone: 'danger' });
    }
  }

  function renderManager() {
    const repos = [...hidden.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    ui.count.textContent = String(repos.length);
    ui.list.replaceChildren(...repos.map(repo => h('li', { class: 'grh-dialog__row' },
      h('a', { href: `/${repo}`, class: 'grh-dialog__repo' }, repo),
      h('button', { type: 'button', class: 'btn btn-sm', dataset: { grhUnhide: repo } }, 'Unhide'))));
    ui.list.hidden = !repos.length;
    ui.empty.hidden = Boolean(repos.length);
    ui.pillToggle.checked = showPill;
    ui.releaseToggle.checked = showReleases;
    ui.reveal.textContent = reveal ? 'Hide them again on this page' : 'Show hidden on this page';
  }

  function openManager() {
    if (!document.body) return;
    if (!dialog) buildManager();
    if (!dialog.isConnected) document.body.append(dialog);
    renderManager();
    if (!dialog.open) dialog.showModal();
    ui.input.focus();
  }

  // ----------------------------------------------------------------- styles

  const CSS = `
    html:not(.grh-reveal) [data-grh-hidden] { display: none !important; }
    html.grh-reveal [data-grh-hidden] {
      opacity: .55;
      outline: 1px dashed var(--borderColor-attention-emphasis, #9e6a03);
      outline-offset: 2px;
      transition: opacity .15s ease;
    }
    html.grh-reveal [data-grh-hidden]:hover, html.grh-reveal [data-grh-hidden]:focus-within { opacity: .9; }

    .starring-container > .grh-btn--text { margin-left: 8px; flex: none; white-space: nowrap; }
    .grh-btn--text .octicon { vertical-align: text-bottom; }

    .grh-btn--icon {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; margin: 0 2px 0 4px; padding: 0; vertical-align: middle;
      border: 0; border-radius: 6px; background: transparent; cursor: pointer;
      color: var(--fgColor-muted, #9198a1);
      opacity: 0; transition: opacity .12s ease, background-color .12s ease, color .12s ease;
    }
    [data-grh-item]:hover .grh-btn--icon, .grh-btn--icon:focus-visible, [data-grh-hidden] .grh-btn--icon { opacity: 1; }
    .grh-btn--icon:hover { color: var(--fgColor-default, #f0f6fc); background: var(--bgColor-neutral-muted, rgba(101,108,118,.2)); }

    .grh-release { display: inline-block; margin-right: 16px; }
    .grh-release .octicon { margin-right: 4px; vertical-align: text-bottom; }
    .grh-release__tag { font-weight: 600; overflow-wrap: anywhere; color: var(--fgColor-default, #f0f6fc); }
    .grh-release:hover .grh-release__tag { color: inherit; }
    .grh-release__date, .grh-release__pre { margin-left: 6px; white-space: nowrap; }
    .grh-release__pre { color: var(--fgColor-attention, #d29922); }

    .grh-pill {
      position: fixed; left: 16px; bottom: 16px; z-index: 99;
      display: flex; align-items: center; gap: 4px; padding: 4px 4px 4px 12px;
      font: 12px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      color: var(--fgColor-muted, #9198a1);
      background: color-mix(in srgb, var(--bgColor-default, #0d1117) 82%, transparent);
      -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
      border: 1px solid var(--borderColor-default, #3d444d); border-radius: 999px;
      box-shadow: var(--shadow-floating-small, 0 6px 18px rgba(1,4,9,.45));
      animation: grh-rise .18s ease-out;
    }
    .grh-pill .octicon { margin-right: 2px; }
    .grh-pill__count { margin-right: 4px; font-variant-numeric: tabular-nums; }
    .grh-pill__btn {
      font: inherit; font-weight: 600; color: var(--fgColor-accent, #4493f8);
      background: transparent; border: 0; border-radius: 999px; padding: 2px 10px; cursor: pointer;
      transition: background-color .12s ease;
    }
    .grh-pill__btn:hover { background: var(--bgColor-accent-muted, rgba(56,139,253,.15)); }

    .grh-toasts {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483000;
      display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none;
    }
    .grh-toast {
      pointer-events: auto; display: flex; align-items: center; gap: 12px;
      max-width: min(560px, calc(100vw - 32px)); padding: 8px 8px 8px 16px;
      font: 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
      color: var(--fgColor-default, #f0f6fc);
      background: color-mix(in srgb, var(--overlay-bgColor, var(--bgColor-default, #151b23)) 92%, transparent);
      -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
      border: 1px solid var(--borderColor-default, #3d444d); border-left: 3px solid var(--fgColor-accent, #4493f8);
      border-radius: 8px; box-shadow: var(--shadow-floating-large, 0 12px 32px rgba(1,4,9,.55));
      animation: grh-rise .18s ease-out;
    }
    .grh-toast--danger { border-left-color: var(--fgColor-danger, #f85149); }
    .grh-toast--out { opacity: 0; transform: translateY(6px); transition: opacity .18s ease, transform .18s ease; }
    .grh-toast__text { flex: 1; }
    .grh-toast__action {
      font: inherit; font-weight: 600; color: var(--fgColor-accent, #4493f8);
      background: transparent; border: 0; border-radius: 6px; padding: 2px 8px; cursor: pointer;
    }
    .grh-toast__action:hover { background: var(--bgColor-accent-muted, rgba(56,139,253,.15)); }
    .grh-toast__close, .grh-dialog__close {
      display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0;
      color: var(--fgColor-muted, #9198a1); background: transparent; border: 0; border-radius: 6px; cursor: pointer;
    }
    .grh-toast__close:hover, .grh-dialog__close:hover {
      color: var(--fgColor-default, #f0f6fc); background: var(--bgColor-neutral-muted, rgba(101,108,118,.2));
    }

    .grh-dialog {
      width: min(560px, calc(100vw - 32px)); max-height: min(80vh, 720px); margin: auto; padding: 0;
      color: var(--fgColor-default, #f0f6fc);
      background: var(--overlay-bgColor, var(--bgColor-default, #151b23));
      border: 1px solid var(--borderColor-default, #3d444d); border-radius: 12px;
      box-shadow: var(--shadow-floating-xlarge, 0 24px 48px rgba(1,4,9,.6));
      font: 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
    }
    .grh-dialog::backdrop { background: rgba(1,4,9,.6); -webkit-backdrop-filter: blur(2px); backdrop-filter: blur(2px); }
    .grh-dialog[open] { display: flex; animation: grh-pop .16s ease-out; }
    .grh-dialog__inner { display: flex; flex-direction: column; gap: 12px; width: 100%; padding: 16px; overflow: auto; }
    .grh-dialog__header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .grh-dialog__title { margin: 0; font-size: 16px; font-weight: 600; }
    .grh-dialog__hint, .grh-dialog__empty { margin: 0; color: var(--fgColor-muted, #9198a1); font-size: 13px; }
    .grh-dialog__form { display: flex; gap: 8px; }
    .grh-dialog__input { flex: 1; min-width: 0; }
    .grh-dialog__error { margin: -4px 0 0; color: var(--fgColor-danger, #f85149); font-size: 12px; }
    .grh-dialog__list {
      margin: 0; padding: 0; list-style: none; overflow: auto; max-height: 340px;
      border: 1px solid var(--borderColor-muted, #3d444db3); border-radius: 8px;
    }
    .grh-dialog__row {
      display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px 6px 12px;
      border-top: 1px solid var(--borderColor-muted, #3d444db3);
    }
    .grh-dialog__row:first-child { border-top: 0; }
    .grh-dialog__row:hover { background: var(--bgColor-muted, #151b23); }
    .grh-dialog__repo { font-weight: 600; word-break: break-all; }
    .grh-dialog__footer {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
      padding-top: 12px; border-top: 1px solid var(--borderColor-muted, #3d444db3);
    }
    .grh-dialog__checks { display: flex; flex-direction: column; gap: 4px; }
    .grh-dialog__check { display: flex; align-items: center; gap: 6px; margin: 0; font-weight: 400; cursor: pointer; }
    .grh-dialog__actions { display: flex; flex-wrap: wrap; gap: 8px; }

    @keyframes grh-rise { from { opacity: 0; transform: translateY(6px); } }
    @keyframes grh-pop { from { opacity: 0; transform: scale(.97); } }
    @media (prefers-reduced-motion: reduce) {
      .grh-pill, .grh-toast, .grh-dialog[open] { animation: none; }
      .grh-toast--out, [data-grh-hidden], .grh-btn--icon { transition: none; }
    }
  `;

  function injectStyles() {
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(CSS);
      return;
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    (document.head || document.documentElement).append(style);
  }

  // ------------------------------------------------------------------- boot

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const hideButton = target.closest('.grh-btn');
    if (hideButton) {
      event.preventDefault();
      event.stopPropagation();
      const repo = hideButton.dataset.repo;
      if (repo) (isHidden(repo) ? unhideRepos : hideRepos)([repo]);
      return;
    }

    const pillButton = target.closest('.grh-pill__btn');
    if (pillButton) {
      event.preventDefault();
      if (pillButton.dataset.grhAction === 'reveal') setReveal(!reveal);
      else openManager();
    }
  }

  // At document-start some managers run before <html> exists.
  function whenRoot(fn) {
    if (document.documentElement) {
      fn();
      return;
    }
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      fn();
    });
    observer.observe(document, { childList: true });
  }

  function start() {
    injectStyles();
    new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
    queueScan();
  }

  function boot() {
    loadHidden(readValue(KEY_HIDDEN, []));

    // Capture phase, so GitHub's own row handlers never see a Hide click.
    document.addEventListener('click', onClick, true);
    for (const type of ['DOMContentLoaded', 'turbo:load', 'turbo:render', 'pjax:end']) {
      document.addEventListener(type, queueScan);
    }
    document.addEventListener('turbo:before-cache', () => {
      if (dialog?.open) dialog.close();
      pill?.remove();
      toastHost?.remove();
    });

    if (typeof GM_registerMenuCommand === 'function') {
      GM_registerMenuCommand('Manage hidden repositories', openManager);
      GM_registerMenuCommand('Show or re-hide hidden repositories on this page', () => setReveal(!reveal));
    }

    if (typeof GM_addValueChangeListener === 'function') {
      GM_addValueChangeListener(KEY_HIDDEN, (_name, _old, value, remote) => {
        if (!remote) return;
        loadHidden(value);
        queueScan();
        if (dialog?.open) renderManager();
      });
      GM_addValueChangeListener(KEY_PILL, (_name, _old, value, remote) => {
        if (!remote) return;
        showPill = value !== false;
        queueScan();
      });
      GM_addValueChangeListener(KEY_SHOW_RELEASES, (_name, _old, value, remote) => {
        if (!remote) return;
        showReleases = value !== false;
        queueScan();
        if (dialog?.open) renderManager();
      });
    }

    whenRoot(() => {
      try {
        start();
      } catch (err) {
        reportError(err);
      }
    });
  }

  try {
    boot();
  } catch (err) {
    reportError(err);
  }
})();
