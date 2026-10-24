#!/usr/bin/env python3
"""Draw bilingual README architecture artwork; optionally rasterize with Chromium.

Python standard library generates the self-contained SVGs. --png additionally
requires Python Playwright, Chromium and a CJK font (e.g. Noto Sans CJK SC).
"""
import argparse
import base64
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/assets/architecture'
INK, MUTED, LINE, ORANGE, SAGE = '#26352c', '#63735e', '#d6dfcc', '#e6532c', '#7b9470'
COPY = {
    'zh': {
        'title': '一个入口，连接每台机器。',
        'subtitle': '原生会话留在本机。Rovloom 负责连接、授权与路由。',
        'access': '接入层', 'accessSub': '客户端', 'agentSub': '你的 MCP 客户端',
        'cliSub': '命令行客户端', 'mcp': 'MCP · 请求与结果', 'commands': '命令与结果',
        'gatewayTag': '自部署 · 统一入口',
        'gateway1': '入口与访问控制', 'gateway1Sub': 'MCP · 设备注册 · 认证 · 策略',
        'gateway2': '路由与调用账本', 'gateway2Sub': '显式目标 · 调用记录 · 结果存储',
        'gateway3': '内置管理页', 'gateway3Sub': '设备与 Provider 管理',
        'deviceA': '设备 A', 'deviceB': '设备 B', 'deviceSub': '独立的本地工作环境',
        'connector': '一个 Connector', 'connectorSub': '一套设备身份 · 本地策略',
        'provider': 'Provider Adapter 适配层', 'providerSub': '每个原生实例独立可信绑定',
        'native1': '本地 Luvus', 'native2': '本地 Herdr',
        'native1Sub': 'Host / session', 'native2Sub': 'session runtime',
        'local': '工作区、会话与 Agent 登录保留在本机',
        'traffic': '请求 ↓ / 结果与事件 ↑',
        'legend1': '实线：双向业务通信', 'legend2': '虚线：Connector 主动发起 WSS',
        'note': '每台设备一个 Connector，多个 Provider。各 Runtime 保留自己的原生协议。',
        'description': 'AI Agent、Bot 与 CLI 接入一个自部署 Gateway。每台设备只有一个 Connector，主动通过 WSS 连接 Gateway；业务请求向下路由，结果与事件返回。Provider Adapter 独立绑定本机 Luvus Host/session 和 Herdr session runtime。管理页、调用账本与结果存储属于 Gateway。',
    },
    'en': {
        'title': 'One entry. Every machine.',
        'subtitle': 'Native sessions stay local. Rovloom connects, authorizes and routes.',
        'access': 'ACCESS', 'accessSub': 'Clients', 'agentSub': 'Your MCP client',
        'cliSub': 'Command-line client', 'mcp': 'MCP · requests & results', 'commands': 'Commands & results',
        'gatewayTag': 'SELF-HOSTED · ONE ENTRY',
        'gateway1': 'Access & control', 'gateway1Sub': 'MCP · registry · auth · policy',
        'gateway2': 'Routing & call ledger', 'gateway2Sub': 'Explicit targets · calls · results',
        'gateway3': 'Management UI', 'gateway3Sub': 'Devices & Providers',
        'deviceA': 'Device A', 'deviceB': 'Device B', 'deviceSub': 'Independent local workspace',
        'connector': 'One Connector', 'connectorSub': 'One device identity · local policy',
        'provider': 'Provider adapters', 'providerSub': 'Trusted binding per native instance',
        'native1': 'Local Luvus', 'native2': 'Local Herdr',
        'native1Sub': 'Host / session', 'native2Sub': 'session runtime',
        'local': 'Workspaces, sessions and Agent logins stay here',
        'traffic': 'Requests ↓ / results & events ↑',
        'legend1': 'Solid: application traffic', 'legend2': 'Dashed: Connector initiates WSS',
        'note': 'One Connector per device. Multiple Providers. Each runtime keeps its native protocol.',
        'description': 'AI Agents, Bots and CLI clients access one self-hosted Gateway. One Connector per device initiates outbound WSS. Requests route down; results and events return. Provider adapters bind separately to local Luvus Host/session and Herdr session runtimes. The management UI, call ledger and result storage belong to Gateway.',
    },
}


def draw(language):
    c = COPY[language]
    parts = []

    def add(value):
        parts.append(value)

    def rect(x, y, width, height, fill='#fffefa', stroke=LINE, radius=14):
        add(f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>')

    def text(x, y, value, size=20, color=INK, weight=400, anchor='start', spacing=None):
        tracking = f' letter-spacing="{spacing}"' if spacing is not None else ''
        add(f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" font-weight="{weight}" text-anchor="{anchor}"{tracking}>{escape(value)}</text>')

    def path(d, color=SAGE, dash=False, both=False, arrow=True, width=2):
        arrows = f' marker-end="url(#{"orange" if color == ORANGE else "sage"}-end)"' if arrow else ''
        if both:
            arrows += ' marker-start="url(#sage-start)"'
        dashed = ' stroke-dasharray="7 7"' if dash else ''
        add(f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"{dashed}{arrows}/>')

    def icon(x, y, kind, color=SAGE, size=28):
        shapes = {
            'agent': '<path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z"/>',
            'cli': '<rect x="2" y="3" width="20" height="18" rx="3"/><path d="m6 8 4 4-4 4m7 0h5"/>',
            'device': '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
            'link': '<path d="m9 15 6-6m-7 3-2 2a4 4 0 0 0 6 6l2-2m-4-12 2-2a4 4 0 0 1 6 6l-2 2"/>',
            'layers': '<path d="m12 2 10 5-10 5L2 7Zm-9 10 9 5 9-5M3 17l9 5 9-5"/>',
            'runtime': '<rect x="4" y="2" width="16" height="20" rx="3"/><path d="M4 9h16M4 16h16m-12-11h1m-1 7h1m-1 7h1"/>',
        }
        add(f'<svg x="{x}" y="{y}" width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{shapes[kind]}</svg>')

    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1340" viewBox="0 0 1440 1340" role="img" aria-labelledby="title description" xml:lang="{language}">')
    add(f'<title id="title">Rovloom — {escape(c["title"])}</title><desc id="description">{escape(c["description"])}</desc>')
    add('''<defs>
      <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.85" fill="#cbd6bf"/></pattern>
      <marker id="sage-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="m2 1 7 4-7 4" fill="none" stroke="#7b9470" stroke-width="1.5"/></marker>
      <marker id="sage-start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="m8 1-7 4 7 4" fill="none" stroke="#7b9470" stroke-width="1.5"/></marker>
      <marker id="orange-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="m2 1 7 4-7 4" fill="none" stroke="#e6532c" stroke-width="1.5"/></marker>
    </defs>''')
    add('<rect width="1440" height="1340" rx="24" fill="#fafaf6"/>')
    add('<g font-family="Noto Sans CJK SC, Noto Sans, Arial, sans-serif">')
    logo = base64.b64encode((ROOT / 'docs/assets/brand/rovloom-mark-transparent.png').read_bytes()).decode()
    add(f'<image x="64" y="48" width="46" height="46" href="data:image/png;base64,{logo}"/>')
    text(124, 83, 'Rovloom', 32, weight=700)
    text(1376, 78, 'SYSTEM ARCHITECTURE', 15, MUTED, 500, 'end', 2)
    text(64, 145, c['title'], 40, weight=700)
    text(64, 185, c['subtitle'], 21, MUTED)

    rect(64, 224, 1312, 132, '#f1f4eb', radius=18)
    text(92, 269, '01 / '+c['access'], 15, MUTED, 500, spacing=1)
    text(92, 308, c['accessSub'], 25, weight=600)
    for x, width, name, sub, symbol in [(340,450,'AI Agent / AI Bot',c['agentSub'],'agent'),(830,518,'CLI',c['cliSub'],'cli')]:
        rect(x,248,width,84,radius=12)
        rect(x+18,266,48,48,'#edf1e6',stroke='none',radius=10)
        icon(x+28,276,symbol)
        text(x+84,284,name,23,weight=600)
        text(x+84,312,sub,17,MUTED)

    # Solid arrows show application traffic, not socket initiation.
    path('M565 332V442',both=True)
    path('M1089 332V376Q1089 392 1073 392H968Q952 392 952 408V442',both=True)
    rect(405,373,292,32,'#fafaf6',stroke='none',radius=6)
    text(551,396,c['mcp'],17,MUTED,anchor='middle')
    rect(1006,356,228,30,'#fafaf6',stroke='none',radius=6)
    text(1120,378,c['commands'],17,MUTED,anchor='middle')

    rect(320,442,800,228,'#fff5eb','#eda17f',20)
    add(f'<image x="350" y="468" width="38" height="38" href="data:image/png;base64,{logo}"/>')
    text(404,498,'Gateway',32,weight=700)
    text(1090,492,c['gatewayTag'],14,'#b24825',500,'end',0.6)
    path('M352 526H1088',color=LINE,arrow=False,width=1)
    for x, title, body in [(352,'gateway1','gateway1Sub'),(610,'gateway2','gateway2Sub'),(868,'gateway3','gateway3Sub')]:
        text(x,568,c[title],21,weight=600)
        text(x,603,c[body],15,MUTED)
    # Device backgrounds precede wiring so connections remain visible in the header gap.
    for x,label in [(64,'deviceA'),(744,'deviceB')]:
        rect(x,790,632,442,'#f0f3e8',radius=18)
        add(f'<rect x="{x}" y="790" width="632" height="442" rx="18" fill="url(#dots)" opacity="0.65"/>')
        icon(x+30,814,'device')
        text(x+72,838,c[label],24,weight=600)
        text(x+602,837,c['deviceSub'],15,MUTED,anchor='end')

    # Outbound WSS takes the outer lanes, separate from application request/result paths.
    path('M96 900H56Q40 900 40 884V574Q40 558 56 558H320',color=ORANGE,dash=True)
    path('M1344 900H1384Q1400 900 1400 884V574Q1400 558 1384 558H1120',color=ORANGE,dash=True)
    path('M565 670V704Q565 720 549 720H396Q380 720 380 736V864',both=True)
    path('M952 670V704Q952 720 968 720H1044Q1060 720 1060 736V864',both=True)
    for x in [380,1060]:
        rect(x-172,745,344,30,'#fafaf6',stroke='none',radius=6)
        text(x,767,c['traffic'],17,MUTED,anchor='middle')

    for x in [64,744]:
        inner=x+32
        rect(inner,864,568,72,'#fffefa',radius=12)
        rect(inner+16,880,40,40,'#edf1e6',stroke='none',radius=9)
        icon(inner+24,888,'link',size=24)
        text(inner+74,895,c['connector'],23,weight=600)
        text(inner+74,920,c['connectorSub'],16,MUTED)
        path(f'M{x+316} 936V976',both=True)
        rect(inner,976,568,70,'#fffefa',radius=12)
        icon(inner+23,998,'layers',size=26)
        text(inner+74,1005,c['provider'],22,weight=600)
        text(inner+74,1030,c['providerSub'],16,MUTED)
        for center in [x+169,x+463]:
            path(f'M{x+316} 1046V1054Q{x+316} 1064 {x+306 if center<x+316 else x+326} 1064H{center+10 if center<x+316 else center-10}Q{center} 1064 {center} 1074V1090',both=True)
        for offset,label,sub in [(0,'native1','native1Sub'),(294,'native2','native2Sub')]:
            rect(inner+offset,1090,274,84,'#fffefa',radius=12)
            icon(inner+offset+18,1117,'runtime',size=24)
            text(inner+offset+60,1124,c[label],21,weight=600)
            text(inner+offset+60,1151,c[sub],16,MUTED)
        text(x+316,1209,c['local'],17,MUTED,anchor='middle')

    path('M64 1267H106',both=True)
    text(120,1274,c['legend1'],17,MUTED)
    path('M520 1267H568',color=ORANGE,dash=True)
    text(582,1274,c['legend2'],17,MUTED)
    text(64,1313,c['note'],17,MUTED)
    add('</g></svg>')
    return '\n'.join(parts)+'\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--png', action='store_true', help='also export 2x PNGs using Playwright')
    parser.add_argument('--chromium', default='/usr/bin/chromium')
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for language in COPY:
        (OUT / f'architecture.{language}.svg').write_text(draw(language), encoding='utf-8')
    if args.png:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
            page = browser.new_page(viewport={'width':1440,'height':1340}, device_scale_factor=2)
            for language in COPY:
                page.set_content((OUT / f'architecture.{language}.svg').read_text(encoding='utf-8'))
                page.evaluate('document.fonts.ready')
                page.locator('svg').first.screenshot(path=str(OUT / f'architecture.{language}.png'))
            browser.close()
    print('Architecture assets generated in docs/assets/architecture/')


if __name__ == '__main__':
    main()
