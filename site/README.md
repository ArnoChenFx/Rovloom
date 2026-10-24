# Rovloom public website

This is the public product homepage, separate from the authenticated Gateway UI.
It is plain HTML, CSS and browser JavaScript with no framework or runtime API.
Chinese is the default; the language switch persists the choice locally.
`?lang=en` and `?lang=zh` select a language explicitly.
Update `content.js` in both languages when capabilities change.

From the repository root:

```sh
bun run site:dev       # Local development server, port 4173; refresh after edits
bun run site:build     # Static artifact in dist/site/
bun test ./test/site   # Translation coverage, real doc links, build and subpath checks
```

The development server also serves the site under `/rovloom/`, matching Pages.
Relative assets work at both the domain root and the project path. The header and footer
use `docs/assets/brand/rovloom-logo.png` as the full wordmark; the favicon and diagram
nodes use the standalone mark. Both assets are copied byte-for-byte from the brand directory.

## Release metadata

Offline builds read the version from `package.json`. In CI, the Pages workflow fetches
GitHub's `/releases/latest` metadata and passes it through `SITE_RELEASE_FILE`. The build uses
that release's tag for the download target and version label, so visitors make no GitHub API
requests. Prereleases never become the displayed release. If fetching or validating the metadata
fails, the build fails and the existing deployment stays.

## GitHub Pages

[`pages.yml`](../.github/workflows/pages.yml) builds on relevant PRs and deploys from `main`
or the maintainer-controlled `website` branch. PR runs build an artifact only and cannot publish.
Publishing uses GitHub Pages artifact deployment with a job-scoped OIDC token, without a PAT
or external host. Pages must be enabled for GitHub Actions. No custom domain is configured.

A successful `Tagged product release` run rebuilds and deploys the site from the default branch,
using the current latest public, non-prerelease Release. Manual workflow dispatch also refreshes
the metadata.

The site is served at <https://arnochenfx.github.io/rovloom/>.

## Checks before publishing design changes

Test rendering at 320, 375, 390, 768, 1024 and 1440 pixels, keyboard navigation, language
persistence, command copying, blocked storage and clipboard, and reduced motion. With Python
Playwright and Chromium installed:

```sh
python3 scripts/site/check-browser.py --url http://127.0.0.1:4173/rovloom/ --output /tmp/rovloom-site-review-new
```

The output must be a new directory outside the checkout. The check covers both languages, the six
widths, keyboard tabs, clipboard success and denial, blocked preference storage, the no-JavaScript
fallback, mobile navigation and reduced motion. Screenshots and the JSON report stay outside the
repository; no generated PNGs are committed.
