// Verify the public site's content, links and standalone Pages artifact.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildSite, escapeHtml } from '../../scripts/site/build.mjs'
import { copy, commands, documents } from '../../site/content.js'

const root = new URL('../../', import.meta.url)

test('both languages cover the same content and every rendered translation key', () => {
  assert.deepEqual(Object.keys(copy.zh).sort(), Object.keys(copy.en).sort())
  const template = readFileSync(new URL('site/index.html', root), 'utf8')
  for (const [, key] of template.matchAll(/data-i18n(?:-aria)?="([\w.]+)"/g)) {
    for (const language of ['zh', 'en']) {
      assert.equal(typeof copy[language][key], 'string', `${language}: ${key}`)
      assert(copy[language][key].length > 0)
    }
  }
  for (const names of Object.values(documents)) {
    for (const name of names) {
      assert(existsSync(new URL(`docs/${name}`, root)), name)
    }
  }
})

test('the site builds without Gateway state and all relative assets work under a project path', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'rovloom-site-build-'))
  try {
    const output = join(temporary, 'public')
    const { html, version } = buildSite({ output })
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    assert.equal(version, pkg.version)
    assert(html.includes(`v${version}`))
    assert(!html.includes('{{'))
    assert(html.includes(copy.zh['hero.title1']))
    assert(html.includes('http-equiv="Content-Security-Policy"'))
    assert(html.includes('id="main"'))
    assert(html.includes('href="#main"'))
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])
    assert.equal(ids.length, new Set(ids).size)
    for (const [, anchor] of html.matchAll(/href="#([^"\s]+)"/g)) {
      assert(ids.includes(anchor), `Missing anchor: ${anchor}`)
    }
    for (const [, asset] of html.matchAll(/(?:src|href)="(\.\/[^"#]+)"/g)) {
      assert(existsSync(join(output, asset)), asset)
      assert.equal(new URL(asset, 'https://example.test/rovloom/').pathname, '/rovloom/' + asset.slice(2))
    }
    assert(!html.match(/(?:src|href)="\/(?!\/)/))
    for (const [, sprite] of html.matchAll(/<use href="#([^"]+)"/g)) {
      assert(ids.includes(sprite), `Missing SVG symbol: ${sprite}`)
    }
    assert(existsSync(join(output, '.nojekyll')))
    assert(existsSync(join(output, '404.html')))
    assert(existsSync(join(output, 'sitemap.xml')))
    assert.equal(
      readFileSync(join(output, 'assets/mark.png')).compare(
        readFileSync(new URL('docs/assets/brand/rovloom-mark-transparent.png', root))
      ),
      0
    )
    const second = join(temporary, 'again')
    buildSite({ output: second })
    for (const name of readdirSync(output).filter((name) => name !== 'assets')) {
      assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(second, name)))
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('commands use real entry points, keep credential placeholders and do not promise automatic pairing', () => {
  for (const language of ['zh', 'en']) {
    assert(commands.cli[language].includes('rovloom gateway'))
    assert(commands.cli[language].includes('rovloom connector'))
    assert(commands.docker[language].includes('/main/docker-compose.yaml'))
    assert(commands.docker[language].includes('docker compose run --rm gateway'))
    const mcp = JSON.parse(commands.mcp[language])
    assert.equal(mcp.url, 'http://127.0.0.1:9444/mcp')
    assert.equal(mcp.headers.Authorization, 'Bearer YOUR_MCP_BEARER')
  }
  assert.equal(
    escapeHtml('<script>"a" & \'b\'</script>'),
    '&lt;script&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/script&gt;'
  )
})

test('published site version and download target follow the latest release instead of the source package', () => {
  const output = mkdtempSync(join(tmpdir(), 'rovloom-site-release-'))
  const release = { tag_name: 'v9.8.7', draft: false, prerelease: false }
  try {
    const { html, version } = buildSite({ output, release })
    assert.equal(version, '9.8.7')
    assert(html.includes('name="rovloom-version" content="9.8.7"'))
    assert(html.includes('class="terminal-version">v9.8.7</span>'))
    assert(html.includes('href="https://github.com/ArnoChenFx/rovloom/releases/tag/v9.8.7"'))
    const hero = html.match(/<section class="hero wrap"[\s\S]*?<\/section>/)[0]
    assert(!hero.includes('v9.8.7'))
    assert(!hero.includes('MIT'))
    assert(!html.includes('roadmap'))
    for (const invalid of [
      null,
      { ...release, draft: true },
      { ...release, prerelease: true },
      { ...release, tag_name: '../unexpected' },
      { ...release, tag_name: '<script>' }
    ]) {
      assert.throws(() => buildSite({ output, release: invalid }))
    }
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
})
