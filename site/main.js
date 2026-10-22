// Small progressive enhancements; the built page remains readable without JavaScript.
import { copy, commands, documents } from './content.js'

let language = 'zh'
let tab = 'cli'
let node = 'gateway'
let copyTimer
const languageButton = document.querySelector('#language')
const menuButton = document.querySelector('.menu-toggle')
const navigation = document.querySelector('#navigation')
const code = document.querySelector('#command')
const copyButton = document.querySelector('#copy-command')
const copyStatus = document.querySelector('#copy-status')

function updateCommands() {
  code.textContent = commands[tab][language]
  document.querySelector('#command-note').textContent = copy[language][`terminal.note.${tab}`]
  const documentName = documents[tab === 'docker' ? 'docker' : 'config'][language === 'zh' ? 0 : 1]
  document.querySelector('.terminal-docs').href = `https://github.com/ArnoChenFx/rovloom/blob/main/docs/${documentName}`
  copyButton.querySelector('span').textContent = copy[language]['terminal.copy']
  copyStatus.textContent = ''
  clearTimeout(copyTimer)
}

function setLanguage(next) {
  language = next
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = copy[language][element.dataset.i18n]
  }
  for (const element of document.querySelectorAll('[data-i18n-aria]')) {
    element.setAttribute('aria-label', copy[language][element.dataset.i18nAria])
  }
  for (const link of document.querySelectorAll('[data-doc]')) {
    link.href = `https://github.com/ArnoChenFx/rovloom/blob/main/docs/${documents[link.dataset.doc][language === 'zh' ? 0 : 1]}`
  }
  languageButton.textContent = language === 'zh' ? 'EN' : '中文'
  languageButton.lang = language === 'zh' ? 'en' : 'zh-CN'
  languageButton.setAttribute('aria-label', language === 'zh' ? 'Switch to English' : '切换到中文')
  document.title =
    language === 'zh' ? 'Rovloom — 一个 MCP 入口，连接你的每台电脑。' : 'Rovloom — Your machines. One connection.'
  document.querySelector('meta[name="description"]').content = copy[language]['meta.description']
  document.querySelector('#node-detail').textContent = copy[language][`map.${node}Detail`]
  updateCommands()
  try {
    localStorage.setItem('rovloom-site-language', language)
  } catch {
    // Browsing remains usable when preference storage is unavailable.
  }
}

function closeMenu() {
  menuButton.setAttribute('aria-expanded', 'false')
  navigation.classList.remove('open')
}

menuButton.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true'
  menuButton.setAttribute('aria-expanded', String(open))
  navigation.classList.toggle('open', open)
})
navigation.addEventListener('click', (event) => {
  if (event.target.closest('a')) {
    closeMenu()
  }
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menuButton.getAttribute('aria-expanded') === 'true') {
    closeMenu()
    menuButton.focus()
  }
})
languageButton.addEventListener('click', () => setLanguage(language === 'zh' ? 'en' : 'zh'))

for (const button of document.querySelectorAll('[data-node]')) {
  button.addEventListener('click', () => {
    node = button.dataset.node
    for (const item of document.querySelectorAll('[data-node]')) {
      const selected = item === button
      item.setAttribute('aria-pressed', String(selected))
      item.classList.toggle('selected', selected)
    }
    document.querySelector('#node-detail').textContent = copy[language][`map.${node}Detail`]
  })
}

const tabs = [...document.querySelectorAll('[data-tab]')]
function selectTab(button) {
  tab = button.dataset.tab
  for (const item of tabs) {
    const selected = item === button
    item.setAttribute('aria-selected', String(selected))
    item.tabIndex = selected ? 0 : -1
  }
  document.querySelector('#command-panel').setAttribute('aria-labelledby', button.id)
  updateCommands()
}
for (const button of tabs) {
  button.addEventListener('click', () => selectTab(button))
  button.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return
    }
    event.preventDefault()
    const index = tabs.indexOf(button)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
    tabs[next].focus()
    selectTab(tabs[next])
  })
}
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(code.textContent)
    copyButton.querySelector('span').textContent = copy[language]['terminal.copied']
    copyStatus.textContent = copy[language]['terminal.copied']
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      copyButton.querySelector('span').textContent = copy[language]['terminal.copy']
    }, 2500)
  } catch {
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(code)
    selection.removeAllRanges()
    selection.addRange(range)
    copyStatus.textContent = copy[language]['terminal.copyFail']
    copyButton.querySelector('span').textContent = copy[language]['terminal.copyFail']
  }
})

try {
  const requested = new URLSearchParams(location.search).get('lang')
  const saved = localStorage.getItem('rovloom-site-language')
  language = requested === 'en' || requested === 'zh' ? requested : saved === 'en' ? 'en' : 'zh'
} catch {
  language = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh'
}
setLanguage(language)
