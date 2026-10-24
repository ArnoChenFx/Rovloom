#!/usr/bin/env python3
"""Check the real public website and save visual evidence outside the checkout."""
import argparse
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


def settle_topology(page):
    page.evaluate("""async () => {
        const diagram = document.querySelector('.topology-block');
        for (const route of diagram.querySelectorAll('.active-route')) getComputedStyle(route).opacity;
        await Promise.all(diagram.getAnimations({subtree: true})
            .filter(animation => animation.effect.getTiming().iterations !== Infinity)
            .map(animation => animation.finished.catch(() => {})));
    }""")


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
        expect(page.locator('#node-flow')).to_be_empty()
        page.screenshot(path=str(out / 'desktop.png'))
        for language in ['zh', 'en']:
            if page.locator('html').get_attribute('lang') != ('zh-CN' if language == 'zh' else 'en'):
                page.locator('#language').click()
            for width in [320, 375, 390, 768, 1024, 1440]:
                page.set_viewport_size({'width': width, 'height': 1000})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, width)
                for element in page.locator('img').all():
                    assert element.evaluate('(image) => image.complete && image.naturalWidth > 0')
                # The local hierarchy and Agent labels must fit at the narrowest widths.
                for selector in ['.map-local-stack', '.flow-local']:
                    region = page.locator(selector)
                    assert region.evaluate('(element) => element.scrollWidth <= element.clientWidth'), (language, width, selector)
                    for label in region.locator('.agent-names li').all():
                        assert label.evaluate('(element) => element.scrollWidth <= element.clientWidth'), (language, width, label.inner_text())
                for selector in ['.site-header .brand img', 'footer .brand img']:
                    logo = page.locator(selector)
                    assert logo.get_attribute('src') == './assets/logo.png'
                    assert logo.evaluate('(image) => Math.abs(image.width / image.height - image.naturalWidth / image.naturalHeight) < 0.05'), (language, width, selector)
                nodes = page.locator('.map-node')
                assert nodes.count() == 6
                for element in nodes.all():
                    assert element.evaluate('(node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight'), (language, width)
                bounds = page.locator('.topology').bounding_box()
                rectangles = [element.bounding_box() for element in nodes.all()]
                for rect in rectangles:
                    assert rect['x'] >= bounds['x'] and rect['y'] >= bounds['y'], (language, width, rect)
                    assert rect['x'] + rect['width'] <= bounds['x'] + bounds['width'], (language, width, rect)
                    assert rect['y'] + rect['height'] <= bounds['y'] + bounds['height'], (language, width, rect)
                for index, a in enumerate(rectangles):
                    for b in rectangles[index + 1:]:
                        assert (a['x'] + a['width'] <= b['x'] or b['x'] + b['width'] <= a['x'] or
                                a['y'] + a['height'] <= b['y'] or b['y'] + b['height'] <= a['y']), (language, width)
                strip_top = page.locator('.tool-strip').evaluate('(element) => element.getBoundingClientRect().top + scrollY')
                page.locator('[data-node=pc]').click()
                expect(page.locator('#node-flow')).to_contain_text('Gateway')
                expect(page.locator('#workspace-title')).to_have_text('个人电脑' if language == 'zh' else 'Personal computer')
                assert page.locator('.map-workspace').evaluate('(element) => element.contains(document.querySelector(".map-local-stack"))')
                after_top = page.locator('.tool-strip').evaluate('(element) => element.getBoundingClientRect().top + scrollY')
                assert abs(strip_top - after_top) < 1, (language, width, 'selection moves layout')
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), (language, width, 'flow')
                page.locator('[data-node=pc]').click()
                expect(page.locator('#node-flow')).to_be_empty()
            assert page.locator('.topology').get_attribute('role') == 'group'
            page.locator('.flow-track').screenshot(path=str(out / f'agent-flow-{language}.png'))
            flows = set()
            for node in ['pc', 'vps', 'docker', 'sandbox', 'agent', 'gateway']:
                button = page.locator(f'[data-node={node}]')
                button.focus()
                page.keyboard.press('Enter')
                assert button.get_attribute('aria-pressed') == 'true'
                assert page.locator('.map-node[aria-pressed=true]').count() == 1
                expect(page.locator('#node-flow')).to_be_visible()
                flow = page.locator('#node-flow').inner_text()
                assert len(flow) > 20 and 'Gateway' in flow
                flows.add(flow)
                assert button.get_attribute('aria-controls') == 'node-flow'
                if node in ['pc', 'vps', 'docker', 'sandbox']:
                    assert page.locator('#workspace-title').inner_text() == button.locator('strong').inner_text()
                routes = page.locator('.active-route.is-active').evaluate_all('(routes) => routes.map(route => route.dataset.highlightRoute)')
                expected_routes = ['agent'] if node == 'agent' else ['agent', 'workspace']
                assert set(routes) == set(expected_routes), (node, routes)
                for route in page.locator('.active-route.is-active').all():
                    assert 'stroke-dashoffset' in route.evaluate('(element) => getComputedStyle(element).transitionProperty')
                    assert route.evaluate('(element) => getComputedStyle(element).transitionDuration') != '0s'
                page.keyboard.press('Space')
                assert button.get_attribute('aria-pressed') == 'false'
                assert page.locator('.active-route.is-active').count() == 0
                expect(page.locator('#node-flow')).to_be_empty()
            assert len(flows) == 6
            button.blur()
            page.locator('[data-node=pc]').click()
            original_flow = page.locator('#node-flow').inner_text()
            page.locator('#language').click()
            assert page.locator('#node-flow').inner_text() != original_flow
            assert page.locator('[data-node=pc]').get_attribute('aria-pressed') == 'true'
            page.locator('#language').click()
            expect(page.locator('#node-flow')).to_have_text(original_flow)
            page.locator('[data-node=pc]').click()
            assert 'macOS' in page.locator('.topology').get_attribute('aria-label')
            if language == 'zh':
                page.locator('.topology').screenshot(path=str(out / 'topology-desktop.png'))
                page.locator('[data-node=sandbox]').click()
                page.locator('[data-node=sandbox]').blur()
                settle_topology(page)
                page.locator('.topology-block').screenshot(path=str(out / 'topology-selected.png'))
                page.locator('[data-node=sandbox]').click()
                page.locator('[data-node=sandbox]').blur()
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
        page.locator('.faq-section').scroll_into_view_if_needed()
        page.screenshot(path=str(out / 'faq.png'))
        page.locator('#language').click()
        page.reload(wait_until='networkidle')
        assert page.locator('html').get_attribute('lang') == 'en'
        page.evaluate('scrollTo(0, 0)')
        page.screenshot(path=str(out / 'english.png'))
        page.set_viewport_size({'width': 390, 'height': 844})
        page.locator('#language').click()
        page.locator('.topology').screenshot(path=str(out / 'topology-mobile.png'))
        page.locator('[data-node=docker]').click()
        page.locator('[data-node=docker]').blur()
        settle_topology(page)
        page.locator('.topology-block').screenshot(path=str(out / 'topology-mobile-selected.png'))
        page.locator('[data-node=docker]').click()
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
        page.locator('[data-node=pc]').click()
        assert page.locator('.active-route.is-active').first.evaluate('(element) => getComputedStyle(element).transitionDuration') == '0s'
        assert page.locator('#node-flow').evaluate('(element) => element.getAnimations().length') == 0
        page.locator('[data-node=pc]').click()
        assert page.locator('.topology').evaluate('(element) => element.getAnimations({subtree: true}).length') == 0
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
        assert 'Claude Code' in fallback.locator('.flow-local').inner_text()
        assert not errors, errors
        assert all(request.startswith(base) for request in requests), requests
        report = {
            'languages': ['zh', 'en'], 'widths': [320, 375, 390, 768, 1024, 1440],
            'checks': ['no overflow', 'local images', 'six topology nodes stay inside diagram without overlap',
                       'localized topology labels and keyboard route selection',
                       'six selected call flows, deselection and live language changes', 'smooth highlights without layout shifts', 'keyboard tabs',
                       'clipboard', 'language persistence', 'FAQ', 'mobile navigation', 'reduced motion',
                       'blocked storage and clipboard', 'no-JS fallback', 'no remote runtime requests', 'local runtime and Agent hierarchy fits all widths'],
            'pageErrors': errors
        }
        (out / 'browser-verification.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
        browser.close()


if __name__ == '__main__':
    main()
