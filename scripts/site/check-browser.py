#!/usr/bin/env python3
"""Check the real public website and save visual evidence outside the checkout."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Site root URL, including project path')
    parser.add_argument('--output', required=True, help='New evidence directory outside the checkout')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    base = args.url.rstrip('/') + '/'
    out = Path(args.output).resolve()
    if out.is_relative_to(Path(__file__).resolve().parents[2]):
        parser.error('Evidence must be outside the checkout')
    out.mkdir(parents=True, exist_ok=False)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=args.chromium, headless=True, args=['--no-sandbox'])
        context = browser.new_context(viewport={'width': 1440, 'height': 1080},
                                      permissions=['clipboard-read', 'clipboard-write'])
        errors, requests = [], []
        context.on('page', lambda child: child.on('pageerror', lambda error: errors.append(str(error))))
        page = context.new_page()
        page.on('requestfailed', lambda request: errors.append(request.url))
        page.on('request', lambda request: requests.append(request.url))
        page.goto(base, wait_until='networkidle')
        page.screenshot(path=str(out / 'desktop.png'))
        page.locator('[data-node=linux]').click()
        assert 'Herdr' in page.locator('#node-detail').inner_text()
        for language in ['zh', 'en']:
            if page.locator('html').get_attribute('lang') != ('zh-CN' if language == 'zh' else 'en'):
                page.locator('#language').click()
            for width in [320, 375, 390, 768, 1024, 1440]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, width)
                for element in page.locator('img').all():
                    assert element.evaluate('(image) => image.complete && image.naturalWidth > 0')
        page.set_viewport_size({'width': 1440, 'height': 1050})
        page.locator('#language').click()
        page.locator('#tab-docker').click()
        page.locator('#copy-command').click()
        expect(page.locator('#copy-status')).to_have_text('已复制')
        assert 'docker compose' in page.evaluate('navigator.clipboard.readText()')
        page.locator('#start').scroll_into_view_if_needed()
        page.screenshot(path=str(out / 'get-started.png'))
        page.locator('#tab-mcp').focus()
        page.keyboard.press('Home')
        assert page.locator('#tab-cli').get_attribute('aria-selected') == 'true'
        page.keyboard.press('ArrowRight')
        assert page.locator('#tab-docker').get_attribute('aria-selected') == 'true'
        assert page.locator('.terminal-docs').get_attribute('href').endswith('DOCKER-zh.md')
        page.locator('#tab-mcp').click()
        assert json.loads(page.locator('#command').inner_text())['url'] == 'http://127.0.0.1:9444/mcp'
        page.locator('.faq-list summary').first.click()
        assert page.locator('.faq-list details').first.get_attribute('open') is not None
        page.locator('#roadmap').scroll_into_view_if_needed()
        page.screenshot(path=str(out / 'roadmap.png'))
        page.locator('#language').click()
        page.reload(wait_until='networkidle')
        assert page.locator('html').get_attribute('lang') == 'en'
        page.evaluate('scrollTo(0, 0)')
        page.screenshot(path=str(out / 'english.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#language').click()
        page.evaluate('scrollTo(0, 0)')
        page.screenshot(path=str(out / 'mobile-full.png'), full_page=True)
        page.screenshot(path=str(out / 'mobile-hero.png'))
        page.locator('#start').scroll_into_view_if_needed()
        page.screenshot(path=str(out / 'mobile-get-started.png'))
        page.evaluate('scrollTo(0, 0)')
        page.locator('.menu-toggle').click()
        assert page.locator('#navigation').is_visible()
        page.keyboard.press('Escape')
        assert not page.locator('#navigation').is_visible()
        page.emulate_media(reduced_motion='reduce')
        assert page.locator('.packet').first.evaluate('(element) => getComputedStyle(element).display') == 'none'
        blocked = context.new_page()
        blocked.add_init_script('''
            Object.defineProperty(window, 'localStorage', {get() {throw new Error('blocked')}});
            Object.defineProperty(navigator, 'clipboard', {value: {
                writeText: () => Promise.reject(new Error('blocked'))
            }});
        ''')
        blocked.goto(base, wait_until='networkidle')
        blocked.locator('#copy-command').click()
        expect(blocked.locator('#copy-status')).to_contain_text('手动复制')
        blocked.locator('#language').click()
        assert blocked.locator('html').get_attribute('lang') == 'en'
        blocked.reload(wait_until='networkidle')
        assert blocked.locator('html').get_attribute('lang') == 'zh-CN'
        fallback = browser.new_context(java_script_enabled=False).new_page()
        fallback.goto(base, wait_until='networkidle')
        assert '一个 MCP 入口' in fallback.locator('h1').inner_text()
        assert 'rovloom gateway' in fallback.locator('#command').inner_text()
        assert not errors, errors
        assert all(request.startswith(base) for request in requests), requests
        report = {
            'languages': ['zh', 'en'], 'widths': [320, 375, 390, 768, 1024, 1440],
            'checks': ['no overflow', 'local images', 'architecture interaction', 'keyboard tabs',
                       'clipboard', 'language persistence', 'FAQ', 'mobile navigation', 'reduced motion',
                       'blocked storage and clipboard', 'no-JS fallback', 'no remote runtime requests'],
            'pageErrors': errors
        }
        (out / 'browser-verification.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
        browser.close()


if __name__ == '__main__':
    main()
