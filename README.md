# GitHub Repo Hider

[![Version](https://img.shields.io/badge/version-0.0.3-4493f8)](https://github.com/SysAdminDoc/GitHub-Repo-Hider/blob/main/CHANGELOG.md)
[![License](https://img.shields.io/badge/license-MIT-3fb950)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Tampermonkey%20%7C%20Violentmonkey-8250df)](#install)

A userscript for people with too many repositories. Pick the ones you're tired of scrolling past and they stop showing up on your profile, your pinned cards, your Stars tab and the dashboard sidebar.

It only changes what your own browser draws. Nothing on GitHub gets edited, and anyone else looking at your profile still sees all of it.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open [github-repo-hider.user.js](https://raw.githubusercontent.com/SysAdminDoc/GitHub-Repo-Hider/main/github-repo-hider.user.js) and click Install.

Updates come from the same link, so your manager will pick up new versions on its own.

## Using it

On your Repositories tab, every repo gets a **Hide** button right next to Star. Click it and the row's gone. The Stars tab works the same way.

Pinned and popular cards on your profile overview get a small eye button that shows up when you hover a card.

When a page has hidden repos on it, a small pill in the bottom left corner tells you how many. **Show** brings them back dimmed with a dashed outline, so you can unhide one right where it sits. **Manage** opens the full list.

The manager lets you:

- Paste repos to hide. It takes `owner/repo`, any GitHub link inside a repo, or just the repo name when you're signed in. Paste a whole list at once if you like.
- Unhide anything on the list.
- Copy the list, which is handy for bringing it over to another browser.
- Clear everything (there's an Undo for a few seconds after).
- Turn the corner pill off if you'd rather not see it.

The same Manage and Show actions are in your userscript manager's menu too.

## Where it hides things

| Page | What disappears | Button |
| --- | --- | --- |
| Profile, Repositories tab | The repo's row | Hide, next to Star |
| Profile, Stars tab | The repo's row | Hide, next to Star |
| Profile overview | Pinned and popular cards | Eye icon on hover |
| Dashboard | Rows in the Top repositories sidebar | Use the manager |
| Navigation side panel | Repo shortcuts | Use the manager |

The repo count on the Repositories tab stays the same, because that number comes from GitHub.

## Privacy

Your list lives in your userscript manager's storage. The script makes no network requests of its own.

## Development

There's a headless smoke test in `tests/smoke.py`. It runs the script against public GitHub pages with Playwright for Python:

```powershell
py -3.13 -m pip install playwright
py -3.13 -m playwright install chromium
py -3.13 tests\smoke.py --user SysAdminDoc
```

Logged-out pages don't have the Star button markup. To check that part, save a signed-in Repositories tab and point the test at it with `--capture-html` (and `--capture-css` if the styles are separate).

## License

[MIT](LICENSE)
