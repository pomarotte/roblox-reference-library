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
    html = html.replace('<span id="collection-games">Reading local images</span>', '<span id="collection-games">Reading local images</span><span id="last-updated" hidden></span>')
    html = html.replace("img-src 'self' blob:", "img-src 'self' blob: https://rolibrary.win")
    html = html.replace("connect-src 'self'", "connect-src 'self' https://rolibrary.win")
    html = html.replace('Choose your dataset folder above to show its saved images.', '')
    html = html.replace('<button id="clear-filters"', '<label>FIRST SAVED THUMBNAIL</label><div class="visit-inputs"><div><label for="first_from">FROM</label><input id="first_from" type="date"></div><div><label for="first_to">TO</label><input id="first_to" type="date"></div></div><button id="clear-filters"')
    if extend:
        html = html.replace('<div class="toolbar-options">', '<div class="toolbar-options">'
            '<label class="sort-control daily-view">View<select id="daily-category">'
            '<option value="" selected>Full archive</option>'
            '<option value="new-images">New images for existing games</option>'
            '<option value="new-games">Newly indexed games</option></select></label>')
        (output / 'daily.css').write_text('.daily-view select { width: auto; max-width: 75vw; }', encoding='utf-8')
        html = html.replace('</head>', '<link rel="stylesheet" href="./daily.css">\n</head>')
    html_path.write_text(html, encoding='utf-8')


if __name__ == '__main__':
    build_cloud(HERE / 'dist')
