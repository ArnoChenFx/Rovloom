// CLI 词典与语言解析：两语言键集与占位符一致，默认英文，显式变量与 zh locale 才切中文。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chinese, cliMessages, english, formatMessage, resolveCliLanguage } from '../../src/cli/messages.js'

const placeholders = (value: string): string[] =>
  [...value.matchAll(/\{(\w+)\}/gu)].map(/* 排序后逐键比对，避免顺序噪声。 */ (match) => match[1]!).sort()

test('cli dictionaries keep identical keys', () => {
  assert.deepEqual(Object.keys(chinese).sort(), Object.keys(english).sort())
})

test('cli dictionary placeholders match across languages', () => {
  for (const [key, value] of Object.entries(english)) {
    assert.deepEqual(placeholders(chinese[key as keyof typeof chinese]!), placeholders(value), key)
  }
})

test('english is the default dictionary and zh-CN switches it', () => {
  assert.equal(cliMessages(), english)
  assert.equal(cliMessages('en'), english)
  assert.equal(cliMessages('zh-CN'), chinese)
})

test('resolveCliLanguage prefers ROVLOOM_LANG then zh locales', () => {
  assert.equal(resolveCliLanguage({}), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'zh' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'zh-CN' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'zh_CN.UTF-8' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'ZH-CN' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'en' }), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'en-US' }), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'fr' }), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: '  ' }), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'en', LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveCliLanguage({ ROVLOOM_LANG: 'zh', LANG: 'en_US.UTF-8' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ LC_ALL: 'zh_CN.UTF-8' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ LC_ALL: 'C.UTF-8', LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveCliLanguage({ LANG: 'zh_TW.UTF-8' }), 'zh-CN')
  assert.equal(resolveCliLanguage({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(resolveCliLanguage({ LANG: 'C' }), 'en')
  assert.equal(resolveCliLanguage({ LC_ALL: '', LANG: 'zh_CN.UTF-8' }), 'zh-CN')
})

test('formatMessage replaces only known placeholders and keeps unknown ones visible', () => {
  assert.equal(formatMessage('a {x} b {y}', { x: 1 }), 'a 1 b {y}')
  assert.equal(formatMessage('{minimum}', { minimum: '1.4.3' }), '1.4.3')
})

test('help texts differ per language and stay single-language', () => {
  const cjk = /[\u{4e00}-\u{9fff}]/u
  for (const key of ['help.main', 'help.admin', 'help.token', 'help.storage'] as const) {
    assert.doesNotMatch(english[key], cjk, key)
    assert.match(chinese[key], cjk, key)
  }
  assert.match(english['help.service'], /uninstall never stops it/)
  assert.match(chinese['help.service'], /uninstall 从不停止它/)
})
