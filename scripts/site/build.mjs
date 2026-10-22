// Assemble a dependency-free, project-path-safe static website for GitHub Pages.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function buildSite({ output = resolve(root, 'dist/site') } = {}) {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  const values = { ...copy.zh, version, command: commands.cli.zh }
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
  copyFileSync(resolve(root, 'site/social-card.svg'), resolve(output, 'assets/social-card.svg'))
  copyFileSync(resolve(root, 'site/social-card.png'), resolve(output, 'assets/social-card.png'))
  writeFileSync(resolve(output, '.nojekyll'), '')
  writeFileSync(
    resolve(output, 'robots.txt'),
    'User-agent: *\nAllow: /\nSitemap: https://arnochenfx.github.io/Rovloom/sitemap.xml\n'
  )
  writeFileSync(
    resolve(output, 'sitemap.xml'),
    '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://arnochenfx.github.io/Rovloom/</loc></url></urlset>\n'
  )
  writeFileSync(
    resolve(output, '404.html'),
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Rovloom</title><link rel="stylesheet" href="/Rovloom/styles.css"><main class="wrap section"><a class="brand" href="/Rovloom/">Rovloom</a><h1>Page not found.</h1><p><a class="button primary" href="/Rovloom/">Back to the homepage ↗</a></p></main></html>\n'
  )
  return { output: resolve(output), version, html }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const result = buildSite()
  console.log(`Built Rovloom ${result.version} website: ${result.output}`)
}
