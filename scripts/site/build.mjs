// Assemble a dependency-free, project-path-safe static website for GitHub Pages.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { copy, commands } from '../../site/content.js'

const root = fileURLToPath(new URL('../../', import.meta.url))

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  )
}

export function buildSite({ output = resolve(root, 'dist/site'), release } = {}) {
  let version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  let releaseUrl = 'https://github.com/ArnoChenFx/rovloom/releases/latest'
  if (release !== undefined) {
    assert(release && release.draft === false && release.prerelease === false, 'Expected a public latest release')
    assert.match(release.tag_name, /^v?\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?(?:\+[\dA-Za-z.-]+)?$/, 'Invalid release tag')
    version = release.tag_name.replace(/^v/, '')
    releaseUrl = `https://github.com/ArnoChenFx/rovloom/releases/tag/${encodeURIComponent(release.tag_name)}`
  }
  const values = { ...copy.zh, version, releaseUrl, command: commands.cli.zh }
  const template = readFileSync(resolve(root, 'site/index.html'), 'utf8')
  const html = template.replace(/\{\{([\w.]+)\}\}/g, (_match, key) => {
    if (!Object.hasOwn(values, key)) {
      throw new Error(`Unknown site template value: ${key}`)
    }
    return escapeHtml(values[key])
  })
  mkdirSync(resolve(output, 'assets'), { recursive: true })
  writeFileSync(resolve(output, 'index.html'), html)
  for (const name of ['styles.css', 'main.js', 'content.js']) {
    copyFileSync(resolve(root, 'site', name), resolve(output, name))
  }
  copyFileSync(resolve(root, 'docs/assets/brand/rovloom-mark-transparent.png'), resolve(output, 'assets/mark.png'))
  writeFileSync(resolve(output, '.nojekyll'), '')
  writeFileSync(
    resolve(output, 'robots.txt'),
    'User-agent: *\nAllow: /\nSitemap: https://arnochenfx.github.io/rovloom/sitemap.xml\n'
  )
  writeFileSync(
    resolve(output, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://arnochenfx.github.io/rovloom/</loc></url></urlset>\n'
  )
  writeFileSync(
    resolve(output, '404.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Rovloom</title><link rel="stylesheet" href="/Rovloom/styles.css"><main class="wrap section"><a class="brand" href="/Rovloom/">Rovloom</a><h1>Page not found.</h1><p><a class="button primary" href="/Rovloom/">Back to the homepage ↗</a></p></main></html>\n'
  )
  return { output: resolve(output), version, html }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  // CI supplies GitHub's latest release; offline previews use the local package version.
  const release = process.env.SITE_RELEASE_FILE
    ? JSON.parse(readFileSync(process.env.SITE_RELEASE_FILE, 'utf8'))
    : undefined
  const result = buildSite({ release })
  console.log(`Built Rovloom ${result.version} website: ${result.output}`)
}
