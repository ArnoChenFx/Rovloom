#!/usr/bin/env python3
"""通过生产browser.js和临时Store/HTTP会话fixture验收provider与配对页面；不控制用户设备。"""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect


def control(context, base, **value):
    """只操作显式loopback测试服务的自有内存fixture。"""
    reply = context.request.post(base + '/__fixture', data=value, headers={'origin': base})
    assert reply.ok
    return reply.json()


def metadata(context, base):
    """只读取公开状态及动作名称，不输出任何凭据。"""
    return context.request.get(base + '/__fixture').json()


def confirm(page):
    """快速重复点击仍只提交原确认一次。"""
    page.locator('dialog[data-phase="awaiting_confirmation"]').wait_for()
    page.locator('.operation-confirm').evaluate('''/* 重复人工事件不能形成第二次提交。 */ button => {button.click(); button.click()}''')
    page.locator('dialog[data-phase="committed"]').wait_for()


def close(page):
    """关闭原状态机对话框并保留页面进度面板。"""
    page.locator('.operation-controls button').last.click()
    expect(page.locator('dialog')).not_to_be_visible()


def create(page, name=None):
    """注册表单只输入非秘密名称和既有策略引用。"""
    page.locator('[data-pairing-action="create"]:enabled').click()
    if name:
        page.locator('[name="device-name"]').fill(name)
    page.locator('[name="pairing-policy"]').fill('fixture_policy')
    page.locator('.operation-form button').click()


def main():
    """覆盖两语两主题、桌面/窄屏、持久回执及进度权限边界。"""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    url = urlsplit(args.url)
    assert url.scheme == 'http' and url.hostname == '127.0.0.1'
    base = args.url.rstrip('/')
    output = Path(args.output).resolve()
    assert not output.is_relative_to(Path(__file__).resolve().parents[2])
    output.mkdir(parents=True, exist_ok=False)
    checks, errors = [], []

    def page_error(error):
        """只收集浏览器运行时错误，不记录认证材料。"""
        errors.append(str(error))
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
        for language in ['en', 'zh-CN']:
            for theme in ['light', 'dark']:
                for width in [1280, 320]:
                    context = browser.new_context(locale=language, color_scheme=theme, viewport={'width': width, 'height': 900})
                    data = control(context, base, mode='reset')
                    page = context.new_page()
                    page.on('pageerror', page_error)
                    machine = data['devices'][0]['machine_id']
                    page.goto(base + '/fixtures/#machine=' + machine)
                    page.locator('[data-provider-action="disable"]:enabled').wait_for()
                    page.locator('[data-provider-action="disable"]').click()
                    page.locator('dialog[data-phase="awaiting_confirmation"]').wait_for()
                    assert 'fixture-provider' in page.locator('.operation-facts').inner_text()
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}-provider.png'))
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    confirm(page)
                    facts = metadata(context, base)
                    assert facts['calls'].count('providers_disable') == 1
                    assert facts['providers'][0]['binding_revision'] == 2 and not facts['providers'][0]['enabled']
                    assert facts['providers'][1]['enabled']
                    close(page)
                    expect(page.locator('[data-provider-action="disable"]')).to_be_disabled()
                    assert page.locator('.provider-card button:disabled').count() == 2
                    assert 'providerEnable' in page.locator('.provider-card').inner_text()
                    checks.append(f'{language}/{theme}/{width}: exact provider confirmation, one commit, independent instance, enable unavailable')
                    page.goto(base + '/fixtures/')
                    page.locator('[data-pairing-action="create"]:enabled').wait_for()
                    create(page, f'owned_new_{language.lower().replace("-", "_")}_{theme}_{width}')
                    confirm(page)
                    assert metadata(context, base)['calls'].count('pairings_create') == 1
                    assert 'pending' in page.locator('dialog').inner_text()
                    assert 'unverified' in page.locator('dialog').inner_text().lower() or '未核实' in page.locator('dialog').inner_text()
                    close(page)
                    panel = page.locator('.pairing-progress')
                    expect(panel).to_be_visible()
                    assert panel.locator('[name="pairing-machine"]').input_value()
                    assert panel.locator('[name="pairing-id"]').input_value()
                    panel.locator('form button').click()
                    expect(panel.locator('[role="status"]')).to_contain_text('devices_read')
                    assert metadata(context, base)['calls'].count('pairings_create') == 1
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    page.screenshot(path=str(output / f'{language}-{theme}-{width}-registration.png'))
                    checks.append(f'{language}/{theme}/{width}: registration form, pending receipt, unverified issuance, no automatic devices_read or resubmit')
                    context.close()

        context = browser.new_context(locale='en', color_scheme='light')
        for outcome in ['cancelled', 'expired', 'paired']:
            data = control(context, base, mode='reset')
            machine = data['devices'][2]['machine_id']
            page = context.new_page()
            page.goto(base + '/fixtures/#machine=' + machine)
            page.locator('[data-pairing-action="create"]:enabled').wait_for()
            create(page)
            confirm(page)
            close(page)
            panel = page.locator('.pairing-progress')
            panel.locator('form button').click()
            expect(panel.locator('[role="status"]')).to_have_text('Pending (pending)')
            if outcome == 'cancelled':
                panel.get_by_role('button', name='Cancel pairing request', exact=True).click()
                confirm(page)
                close(page)
            elif outcome == 'expired':
                control(context, base, advance=600001)
            else:
                control(context, base, mode='complete_pairing', pairing_id=panel.locator('[name="pairing-id"]').input_value())
            panel.locator('form button').click()
            expect(panel.locator('[role="status"]')).to_contain_text(outcome)
            expect(panel.get_by_role('button', name='Cancel pairing request', exact=True)).to_be_disabled()
            assert metadata(context, base)['calls'].count('pairings_create') == 1
            checks.append(f'authorized original pairing: pending to {outcome}; terminal cancellation disabled')
            page.close()
        context.close()
        browser.close()
    assert not errors, errors
    report = {'passed': len(checks), 'checks': checks, 'page_errors': errors, 'production_browser_bundle': True, 'temporary_store_http_session_fixture': True, 'real_user_devices': False}
    (output / 'lifecycle.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
