# Rovloom public website

This is the public product homepage, separate from the authenticated Gateway UI.
It is plain HTML, CSS and browser JavaScript with no framework or runtime API.
Chinese is the default; the language switch persists English or Chinese locally.
`?lang=en` and `?lang=zh` explicitly select a language.

From the repository root:

```sh
bun run site:dev       # Local development server, port 4173; refresh after edits
bun run site:build     # Static artifact in dist/site/
bun test ./test/site   # Translation coverage, real doc links, build and subpath checks
```

The development server also serves the site under `/rovloom/`, matching Pages.
Relative assets work at both the domain root and the project path. Offline previews
read the version from `package.json`. CI fetches GitHub's `/releases/latest` metadata
and supplies it through `SITE_RELEASE_FILE`; the build uses that release's tag for
the download target and version label. Visitors make no GitHub API requests.
The original transparent brand mark is copied byte-for-byte from `docs/assets/brand`.
Update `content.js` in both languages when capabilities change.

## GitHub Pages

`.github/workflows/pages.yml` builds on relevant PRs and deploys on `main` or the
maintainer-controlled `website` branch. The latter supports an initial public
website before the implementation PR is merged; it does not merge application
changes into `main`. After merge, `main` is the normal source of future updates.
PR runs build an artifact only and cannot publish. Publishing uses GitHub Pages'
artifact deployment and a job-scoped OIDC token, without a PAT or external host.
Pages must be enabled for GitHub Actions; the configure action attempts initial
enablement, which may require a repository administrator when account settings
or integration permissions prevent it. No custom domain is configured.

After this workflow is merged into the default branch, successful `Tagged product
release` workflow runs automatically rebuild and deploy the site. `workflow_run`
covers the repository's publisher using `GITHUB_TOKEN`, which does not trigger a
second workflow through `release.published`. Its default-branch deployment also
matches the Pages environment's branch rules. Failed release runs and fork runs
cannot initiate publishing. Release-triggered builds check out the
default branch's site code and read the current latest public, non-prerelease
Release, keeping the download and version aligned even when a prerelease or an
older tag is published. Metadata fetch or validation failure fails the build and
keeps the existing deployment. Manual workflow dispatch also refreshes metadata.

Expected project URL: <https://arnochenfx.github.io/rovloom/>.
Do not claim a deployment succeeded until the deployment job and public HTTP
checks pass. Test rendering at 320, 375, 390, 768, 1024 and 1440 pixels, keyboard
navigation, language persistence, command copying, blocked storage/clipboard,
and reduced motion before publishing design changes.

## Browser checks and screenshots

With Python Playwright and Chromium installed:

```sh
python3 scripts/site/check-browser.py --url http://127.0.0.1:4173/rovloom/ --output /tmp/rovloom-site-review-new
```

The output must be a new directory outside the checkout. The check covers both
languages, six viewport widths, keyboard tabs, clipboard success and denial,
blocked preference storage, no-JavaScript fallback, mobile navigation and
reduced motion. Screenshots and the JSON report remain outside the repository.
The social preview reuses the existing brand mark. No generated PNGs or review
screenshots are committed.
