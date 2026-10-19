#!/usr/bin/env python3
"""在真实 Chromium 验证语言、主题与偏好存储；仅使用显式隔离 fixture，不证明生产会话或设备链路。"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import sync_playwright, expect

WORDS = {
    'zh-CN': {'title': 'Rovloom 管理', 'language': '语言', 'theme': '主题', 'refresh': '刷新',
              'cancel': '取消读取', 'unavailable': '管理读取尚不可用', 'unauthenticated': '管理会话未登录或已过期',
              'forbidden': '没有此范围的查看权限', 'stale': '设备观测已过期', 'unknown': '连接未核实'},
    'en': {'title': 'Rovloom Management', 'language': 'Language', 'theme': 'Theme', 'refresh': 'Refresh',
           'cancel': 'Cancel read', 'unavailable': 'Management reads are unavailable',
           'unauthenticated': 'The management session is missing or expired',
           'forbidden': 'cannot view this scope', 'stale': 'Device observation expired', 'unknown': 'Connection unverified'}
}


def contrast_check(page):
    """从实际渲染读取前景/有效背景，检查普通文字与状态标签的4.5:1对比度。"""
    ratios = page.evaluate('''/* 只读检查当前DOM中的实际文字对比度。 */ () => {
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const context=canvas.getContext('2d');
      /** 将浏览器计算色值解析成RGBA，不改页面样式。 */
      function rgb(color) { context.clearRect(0,0,1,1); context.fillStyle=color; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data]; }
      /** 按WCAG公式计算线性相对亮度。 */
      function luminance(color) { const channels=color.slice(0,3).map(/* 将色彩通道转换为线性亮度。 */ value=>{const s=value/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4});return channels[0]*0.2126+channels[1]*0.7152+channels[2]*0.0722; }
      /** 沿父元素寻找真正承载文字的不透明背景。 */
      function background(element) { for(let node=element;node;node=node.parentElement){const value=rgb(getComputedStyle(node).backgroundColor);if(value[3]===255)return value;}return [255,255,255,255]; }
      return [...document.querySelectorAll('.badge, .muted, main a, dt')].filter(/* 排除没有文字的节点。 */ element=>element.textContent.trim()).map(/* 逐节点比较文字与背景亮度。 */ element=>{
        const foreground=luminance(rgb(getComputedStyle(element).color));const behind=luminance(background(element));return (Math.max(foreground,behind)+0.05)/(Math.min(foreground,behind)+0.05);
      });
    }''')
    assert ratios and min(ratios) >= 4.5, min(ratios)


def controls(page):
    """取得不随文案改变而失效的两个稳定偏好控件。"""
    return page.locator('.preference select').nth(0), page.locator('.preference select').nth(1)


def main():
    """在全新浏览器上下文检查两语两主题、系统变化、保存回退和认证失败生命周期。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or url.path not in ('', '/'):
        raise SystemExit('only the explicit loopback UI fixture server is supported')
    output = Path(args.output).resolve()
    if output.is_relative_to(Path(__file__).resolve().parents[2]):
        raise SystemExit('browser evidence must be outside the checkout')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    base = args.url.rstrip('/')
    checks = []
    errors = []

    def page_error(error):
        """只收集隔离页面运行时异常，不读取管理正文或凭据。"""
        errors.append(str(error))

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
        for language, locale in [('zh-CN', 'zh-TW'), ('en', 'en-GB')]:
            for theme in ['light', 'dark']:
                words = WORDS[language]
                other = 'en' if language == 'zh-CN' else 'zh-CN'
                context = browser.new_context(locale=locale, color_scheme=theme, viewport={'width': 1280, 'height': 960})
                page = context.new_page()
                page.on('pageerror', page_error)
                response = page.goto(base + '/')
                page.get_by_text(words['unavailable'], exact=False).wait_for()
                assert page.title() == words['title']
                assert page.locator('html').get_attribute('lang') == language
                assert page.locator('html').get_attribute('data-theme') == theme
                assert page.evaluate("CSS.supports('color', 'light-dark(white, black)')")
                assert page.get_by_role('combobox', name=words['language'], exact=True).count() == 1
                assert page.get_by_role('combobox', name=words['theme'], exact=True).count() == 1
                assert page.evaluate('localStorage.length + sessionStorage.length') == 0
                assert page.evaluate('typeof window.webUiFixture') == 'undefined'
                csp = response.headers['content-security-policy']
                assert 'unsafe-inline' not in csp and 'unsafe-eval' not in csp
                checks.append(f'{language}/{theme}: browser/system defaults, localized metadata and protected unavailable entry')

                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                device_name = page.locator('.device-name').first.inner_text()
                page.locator('.device-name').first.click()
                page.locator('.provider-card').first.wait_for()
                assert page.get_by_role('heading', name=device_name, exact=True).count() == 1
                assert page.locator('main code').first.inner_text() == 'fixture-a'
                logo = page.get_by_role('img', name='Rovloom', exact=True)
                assert logo.evaluate('/* 核对品牌原图与实际显示尺寸。 */ (el)=>el.complete&&el.naturalWidth===192&&el.naturalHeight===192&&el.width===48&&el.height===48')
                contrast_check(page)
                page.evaluate("window.webUiFixture.mode='hold'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.wait_for_function('window.webUiFixture.pending.length===1')
                before = page.evaluate('({reads:window.webUiFixture.reads,aborted:window.webUiFixture.aborted,hash:location.hash})')
                language_select, theme_select = controls(page)
                language_select.focus()
                language_select.select_option(other)
                assert page.title() == WORDS[other]['title']
                assert page.evaluate('document.activeElement===document.querySelectorAll(".preference select")[0]')
                theme_select.focus()
                theme_select.select_option('dark' if theme == 'light' else 'light')
                after = page.evaluate('({reads:window.webUiFixture.reads,aborted:window.webUiFixture.aborted,hash:location.hash})')
                assert before == after
                assert page.evaluate('window.webUiFixture.pending.length') == 1
                assert page.get_by_role('heading', name=device_name, exact=True).count() == 1
                assert page.locator('main').get_attribute('aria-busy') == 'true'
                checks.append(f'{language}/{theme}: language/theme changes preserve route, device, focus and pending read without cancellation')
                page.get_by_role('button', name=WORDS[other]['cancel'], exact=True).click()
                page.evaluate("window.webUiFixture.mode='normal';window.webUiFixture.release()")
                language_select.select_option(language)
                theme_select.select_option(theme)
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                expect(page.get_by_role('button', name=words['refresh'], exact=True)).to_be_enabled()
                page.screenshot(path=str(output / f'{language}-{theme}-desktop.png'))
                page.set_viewport_size({'width': 320, 'height': 900})
                assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                language_select.focus()
                page.keyboard.press('Tab')
                assert theme_select.evaluate('/* 核对键盘焦点与可见轮廓。 */ (el)=>document.activeElement===el&&getComputedStyle(el).outlineStyle!=="none"')
                page.screenshot(path=str(output / f'{language}-{theme}.png'), full_page=True)
                checks.append(f'{language}/{theme}: square logo, text contrast, keyboard focus and 320px layout')

                page.evaluate("window.webUiFixture.mode='stale_children'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.get_by_text(words['stale'], exact=False).first.wait_for()
                language_select.select_option(other)
                assert page.locator('main .badges .good, .provider-card .good').count() == 0
                page.get_by_text(WORDS[other]['stale'], exact=False).first.wait_for()
                language_select.select_option(language)
                page.evaluate("window.webUiFixture.mode='unverified'")
                page.get_by_role('button', name=words['refresh'], exact=True).click()
                page.get_by_text(words['unknown'], exact=False).first.wait_for()
                language_select.select_option(other)
                page.get_by_text(WORDS[other]['unknown'], exact=False).first.wait_for()
                assert page.locator('main .badges .good, .provider-card .good').count() == 0
                checks.append(f'{language}/{theme}: switching never revives expired or unverified observations')

                for mode, error in [('401', 'unauthenticated'), ('403', 'forbidden'), ('expired', 'unauthenticated')]:
                    page.goto(base + '/fixtures/')
                    page.locator('.device-card').first.wait_for()
                    language_select, theme_select = controls(page)
                    language_select.select_option(language)
                    theme_select.select_option(theme)
                    page.evaluate('/* 仅调整显式隔离fixture情景。 */ (mode)=>{window.webUiFixture.mode=mode}', mode)
                    page.get_by_role('button', name=words['refresh'], exact=True).click()
                    page.get_by_text(words[error], exact=False).wait_for()
                    count = page.evaluate('window.webUiFixture.reads')
                    language_select.select_option(other)
                    theme_select.select_option('dark' if theme == 'light' else 'light')
                    page.get_by_text(WORDS[other][error], exact=False).wait_for()
                    assert page.locator('.device-card,.provider-card').count() == 0
                    assert page.get_by_role('button', name=WORDS[other]['refresh'], exact=True).is_disabled()
                    assert page.evaluate('window.webUiFixture.reads') == count
                checks.append(f'{language}/{theme}: 401/403/session expiry remain cleared and stopped across language/theme changes')

                page.goto(base + '/fixtures/')
                page.locator('.device-card').first.wait_for()
                language_select, theme_select = controls(page)
                language_select.select_option('en')
                theme_select.select_option('dark')
                page.reload()
                page.locator('.device-card').first.wait_for()
                assert page.locator('html').get_attribute('lang') == 'en'
                assert page.locator('html').get_attribute('data-theme') == 'dark'
                assert page.evaluate('Object.fromEntries(Object.entries(localStorage))') == {'rovloom.webui.language': 'en', 'rovloom.webui.theme': 'dark'}
                assert page.evaluate('sessionStorage.length') == 0
                checks.append(f'{language}/{theme}: reload restores only the two fixed non-sensitive preference keys')
                context.close()

        context = browser.new_context(locale='zh-CN', color_scheme='light')
        page = context.new_page()
        page.on('pageerror', page_error)
        page.goto(base + '/fixtures/')
        page.locator('.device-card').first.wait_for()
        language_select, theme_select = controls(page)
        page.locator('.device-name').first.focus()
        focused = page.locator('.device-name').first.get_attribute('href')
        page.evaluate("Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']});window.dispatchEvent(new Event('languagechange'))")
        assert page.locator('html').get_attribute('lang') == 'en'
        assert page.evaluate('document.activeElement.getAttribute("href")') == focused
        page.emulate_media(color_scheme='dark')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        language_select.select_option('zh-CN')
        theme_select.select_option('light')
        page.evaluate("window.dispatchEvent(new Event('languagechange'))")
        page.emulate_media(color_scheme='light')
        page.emulate_media(color_scheme='dark')
        assert page.locator('html').get_attribute('lang') == 'zh-CN'
        assert page.locator('html').get_attribute('data-theme') == 'light'
        language_select.select_option('system')
        theme_select.select_option('system')
        expect(page.locator('html')).to_have_attribute('data-theme', 'dark')
        assert page.locator('html').get_attribute('lang') == 'en'
        checks.append('system language/theme changes are live; manual choices remain independent; focused route link survives localization')
        page.goto(base + '/fixtures/#machine=fixture-a')
        page.locator('.provider-card').first.wait_for()
        language_select, theme_select = controls(page)
        language_select.select_option('en')
        page.evaluate("window.webUiFixture.mode='near_stale'")
        page.get_by_role('button', name='Refresh', exact=True).click()
        page.get_by_text('Management readiness: Ready (ready)', exact=True).wait_for()
        count = page.evaluate('window.webUiFixture.reads')
        language_select.select_option('zh-CN')
        theme_select.select_option('light')
        page.get_by_text('运行观测已过期', exact=False).first.wait_for(timeout=3500)
        assert page.locator('main .badges .good,.provider-card .good').count() == 0
        assert page.evaluate('window.webUiFixture.reads') == count
        checks.append('language/theme switches preserve the original monotonic expiry boundary without a new read')
        page.evaluate("Object.defineProperty(navigator,'languages',{configurable:true,value:['en-US']})")
        language_select.select_option('system')
        theme_select.select_option('system')
        before = page.evaluate('({language:document.documentElement.lang,theme:document.documentElement.dataset.theme})')
        page.evaluate("window.webUiFixture.dispose();Object.defineProperty(navigator,'languages',{configurable:true,value:['zh-CN']});window.dispatchEvent(new Event('languagechange'))")
        page.emulate_media(color_scheme='light')
        page.wait_for_timeout(100)
        assert page.locator('#rovloom-management').inner_text() == ''
        assert page.evaluate('({language:document.documentElement.lang,theme:document.documentElement.dataset.theme})') == before
        checks.append('unmount removes native language/theme listeners and never recreates disposed content')
        context.close()

        for failure in ['invalid', 'blocked', 'quota']:
            context = browser.new_context(locale='en-US', color_scheme='dark')
            if failure == 'invalid':
                context.add_init_script("if(localStorage.getItem('rovloom.webui.language')===null){localStorage.setItem('rovloom.webui.language','{principal_id:fake}');localStorage.setItem('rovloom.webui.theme','javascript:fake')}localStorage.setItem('other-app.preference','preserve')")
            elif failure == 'blocked':
                context.add_init_script("Object.defineProperty(window,'localStorage',{/** 模拟隐私策略拒绝访问存储。 */get(){throw new DOMException('blocked','SecurityError')}})")
            else:
                context.add_init_script("Storage.prototype.setItem=/** 模拟存储配额拒绝保存。 */function(){throw new DOMException('full','QuotaExceededError')}")
            page = context.new_page()
            page.on('pageerror', page_error)
            page.goto(base + '/fixtures/')
            page.locator('.device-card').first.wait_for()
            assert page.locator('html').get_attribute('lang') == 'en'
            assert page.locator('html').get_attribute('data-theme') == 'dark'
            language_select, theme_select = controls(page)
            assert language_select.input_value() == 'system'
            assert theme_select.input_value() == 'system'
            language_select.select_option('zh-CN')
            theme_select.select_option('light')
            assert page.locator('html').get_attribute('lang') == 'zh-CN'
            assert page.locator('html').get_attribute('data-theme') == 'light'
            page.reload()
            page.locator('.device-card').first.wait_for()
            assert page.locator('html').get_attribute('lang') == ('zh-CN' if failure == 'invalid' else 'en')
            assert page.locator('html').get_attribute('data-theme') == ('light' if failure == 'invalid' else 'dark')
            if failure == 'invalid':
                assert page.evaluate("localStorage.getItem('other-app.preference')") == 'preserve'
            assert page.evaluate('sessionStorage.length') == 0
            checks.append(f'{failure} storage: safe defaults, working in-memory choices and explicit reload behavior')
            context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors,
              'evidence': 'synthetic UI projection in real Chromium',
              'management_backend_verified': False, 'real_connector_verified': False}
    (output / 'preferences.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
