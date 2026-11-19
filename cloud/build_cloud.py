"""Build a separate cloud-image preview using the existing saved catalogue."""
from pathlib import Path
import re
import sys
from hashlib import sha256

HERE = Path(__file__).resolve().parent
GALLERY = HERE.parent / 'roblox-gallery'
if not GALLERY.is_dir():
    GALLERY = HERE.parent
sys.path.insert(0, str(GALLERY))
from build_web import build


def build_cloud(output, extend=None, cache=GALLERY):
    output = Path(output)
    build(cache, output, extend=extend)
    host = (HERE / 'cloud-host.js').read_text(encoding='utf-8')
    html_path = output / 'index.html'
    html = html_path.read_text(encoding='utf-8')
    match = re.search(r'web-host\.[a-f0-9]+\.js', html)
    if not match:
        raise ValueError('Expected browser host script was not found')
    worker = re.search(r'search-worker\.[a-f0-9]+\.js', (output / match.group()).read_text(encoding='utf-8'))
    if not worker:
        raise ValueError('Expected search worker was not found')
    host = host.replace('search-worker.js', worker.group())
    host_name = f'cloud-host.{sha256(host.encode()).hexdigest()[:12]}.js'
    (output / host_name).write_text(host, encoding='utf-8')
    html = html.replace(match.group(), host_name)
    html = html.replace('<body class="web-disconnected">', '<body>')
    html = html.replace('<section class="folder-panel"', '<section hidden class="folder-panel"')
    html = html.replace('<button id="quit"', '<button hidden id="quit"')
    html = html.replace("img-src 'self' blob:", "img-src 'self' blob: https://rolibrary.win")
    html = html.replace("connect-src 'self'", "connect-src 'self' https://rolibrary.win")
    if extend:
        app_name = re.search(r'(?<=src="\./)app\.[a-f0-9]+\.js', html).group()
        app = (output / app_name).read_text(encoding='utf-8')
        app = app.replace("function parameters() {", "function parameters() {\n  const daily = $('daily-only').checked && !reference && !saved?.active;")
        app = app.replace("params.set('all_images',", "if (daily) { params.set('daily_only', '1'); params.set('sort', 'recent'); }\n  params.set('all_images',", 1)
        app = app.replace("status();\nload();", "$('daily-only').addEventListener('change', () => load(true));\nstatus();\nload();")
        daily_app = f'app.{sha256(app.encode()).hexdigest()[:12]}.js'
        (output / daily_app).write_text(app, encoding='utf-8')
        html = html.replace(app_name, daily_app)
        html = html.replace('<div class="toolbar-options">', '<div class="toolbar-options"><label class="check-control"><input id="daily-only" type="checkbox" checked>Latest daily scan</label>')
    html_path.write_text(html, encoding='utf-8')


if __name__ == '__main__':
    build_cloud(HERE / 'dist')
