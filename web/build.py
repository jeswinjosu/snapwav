#!/usr/bin/env python3
"""Build SnapWav from web/src into:
     dist/pwa/            installable web app (GitHub Pages / any static host)
     dist/android/www/    assets for the Android app (copied into android/app/src/main/assets/www)

   Usage:  python3 build.py [--no-android-sync] [--artifact OUT.html] [--refresh-icons LUCIDE_ICONS_DIR]
   Optional: `npm install` in web/ first to minify with esbuild (the build works without it).
"""
import argparse, json, os, re, shutil, subprocess, sys

WEB = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WEB)
SRC = os.path.join(WEB, 'src')
VENDOR = os.path.join(WEB, 'vendor')
DIST = os.path.join(WEB, 'dist')
ANDROID_ASSETS = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'www')
VERSION = json.load(open(os.path.join(WEB, 'package.json')))['version']

ap = argparse.ArgumentParser()
ap.add_argument('--no-android-sync', action='store_true', help='do not copy the Android build into android/app/src/main/assets/www')
ap.add_argument('--artifact', help='also write a single-file page (Google Fonts, no service worker) to this path')
ap.add_argument('--refresh-icons', help='copy the Lucide icons the app uses from this icons directory into web/vendor/lucide')
args = ap.parse_args()

css_src = open(os.path.join(SRC, 'style.css')).read()
body = open(os.path.join(SRC, 'body.html')).read()
js_files = sorted(f for f in os.listdir(os.path.join(SRC, 'js')) if f.endswith('.js'))
js_src = '\n'.join(open(os.path.join(SRC, 'js', f)).read() for f in js_files)

# ---------- minify (optional) ----------
def find_esbuild():
    for c in [os.environ.get('ESBUILD'), os.path.join(WEB, 'node_modules', '.bin', 'esbuild'), shutil.which('esbuild')]:
        if c and os.path.exists(c): return c
    return None
ESB = find_esbuild()
def esb(code, loader):
    if not ESB: return code
    r = subprocess.run([ESB, '--minify', f'--loader={loader}', '--target=es2020,chrome90,safari15'], input=code.encode(), capture_output=True)
    if r.returncode: sys.exit(r.stderr.decode())
    return r.stdout.decode().strip()
js, css = esb(js_src, 'js'), esb(css_src, 'css')
if not ESB: print('note: esbuild not found, building unminified (run `npm install` in web/ to minify)')

# ---------- icon sprite (Lucide, ISC) ----------
names = set(re.findall(r'#i-([a-z0-9-]+)', body + js_src))
for m in re.finditer(r'\bic\(([^;\n]*?)\)', js_src): names.update(re.findall(r"'([a-z0-9-]+)'", m.group(1)))
for m in re.finditer(r"\b(?:mi|chip|item|zoomChip)\(\s*'([a-z0-9-]+)'", js_src): names.add(m.group(1))
for m in re.finditer(r"\b(?:tile|B)\(\s*'[^']*',\s*'([a-z0-9-]+)'", js_src): names.add(m.group(1))
for m in re.finditer(r"\bicon:\s*([^,}\n]+)", js_src): names.update(re.findall(r"'([a-z0-9-]+)'", m.group(1)))
icon_dirs = [os.path.join(WEB, 'node_modules', 'lucide-static', 'icons'), os.path.join(VENDOR, 'lucide')]
if args.refresh_icons:
    for n in names:
        p = os.path.join(args.refresh_icons, n + '.svg')
        if os.path.exists(p): shutil.copy(p, os.path.join(VENDOR, 'lucide', n + '.svg'))
symbols, missing = [], []
for n in sorted(names):
    p = next((os.path.join(d, n + '.svg') for d in icon_dirs if os.path.exists(os.path.join(d, n + '.svg'))), None)
    if not p: missing.append(n); continue
    inner = re.search(r'<svg[^>]*>(.*)</svg>', open(p).read(), re.S).group(1)
    inner = re.sub(r'\s+', ' ', inner).strip()
    symbols.append('<symbol id="i-%s" viewBox="0 0 24 24">%s</symbol>' % (n, inner))
real_missing = [m for m in missing if m not in ('lg', 'sm', 'xs', 'master')]
if real_missing: print('warning: icons not found:', real_missing)
sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' + ''.join(symbols) + '</svg>'

# ---------- fonts ----------
GOOGLE_FONTS = ('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
                '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@500;600&display=swap">')
LOCAL_FONTS = ''.join(
    f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;src:url(fonts/{file}-latin-{w}-normal.woff2) format('woff2')}}"
    for fam, file, ws in [('Instrument Sans', 'instrument-sans', [400, 500, 600, 700]), ('JetBrains Mono', 'jetbrains-mono', [500, 600])] for w in ws)
# Sets light or dark before the first paint, so the app never flashes the wrong theme
THEME_JS = ("try{var t=JSON.parse(localStorage.getItem('snapwav.theme')||'\"system\"');"
            "if(t!=='light'&&t!=='dark'){var a=window.SnapWavAndroid,n=null;"
            "try{if(a&&a.info){n=JSON.parse(a.info()).night}}catch(e){}"
            "t=(typeof n==='boolean'?n:!matchMedia('(prefers-color-scheme: light)').matches)?'dark':'light'}"
            "document.documentElement.setAttribute('data-theme',t);"
            "var m=document.querySelector('meta[name=theme-color]');if(m)m.content=t==='light'?'#F4F4F5':'#0F0F11'}catch(e){}")
HEADER = f'<!-- SnapWav v{VERSION} · AGPL-3.0 · https://github.com/ (see README) · Icons: Lucide (ISC) -->'

def page(head_extra, platform_js):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#0F0F11">
<meta name="color-scheme" content="dark light">
<script>{THEME_JS}</script>
<meta name="description" content="SnapWav: a lightweight, touch-first multitrack audio workstation.">
{head_extra}
<title>SnapWav</title>
{HEADER}
<style>
{LOCAL_FONTS}
:root {{ padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }}
{css}
</style>
</head>
<body>
{body}
{sprite}
<script>{platform_js}</script>
<script>
{js}
</script>
</body>
</html>
'''

def copy_common(out):
    shutil.copytree(os.path.join(WEB, 'icons'), os.path.join(out, 'icons'))
    os.makedirs(os.path.join(out, 'fonts'))
    for f in os.listdir(os.path.join(VENDOR, 'fonts')): shutil.copy(os.path.join(VENDOR, 'fonts', f), os.path.join(out, 'fonts', f))
    os.makedirs(os.path.join(out, 'vendor'))
    shutil.copy(os.path.join(VENDOR, 'lame', 'lame.min.js'), os.path.join(out, 'vendor', 'lame.min.js'))
    shutil.copy(os.path.join(VENDOR, 'lame', 'LICENSE'), os.path.join(out, 'vendor', 'LAME-LICENSE.txt'))
    shutil.copy(os.path.join(ROOT, 'LICENSE'), os.path.join(out, 'LICENSE.txt'))

if os.path.exists(DIST): shutil.rmtree(DIST)

# ---------- PWA ----------
pwa = os.path.join(DIST, 'pwa'); os.makedirs(pwa)
copy_common(pwa)
open(os.path.join(pwa, 'index.html'), 'w').write(page(
    '<meta name="mobile-web-app-capable" content="yes">\n<link rel="manifest" href="manifest.webmanifest">\n<link rel="icon" href="icons/favicon-48.png" type="image/png" sizes="48x48">\n<link rel="icon" href="icons/icon-192.png" type="image/png" sizes="192x192">\n<link rel="apple-touch-icon" href="icons/icon-192.png">',
    'window.SNAPWAV_PWA = true;'))
open(os.path.join(pwa, '.nojekyll'), 'w').write('')
manifest = {
    "name": "SnapWav", "short_name": "SnapWav",
    "description": "Lightweight, touch-first multitrack audio workstation: arrange, mix and add effects to your own audio files.",
    "id": "./", "start_url": "./", "scope": "./", "display": "standalone", "orientation": "any",
    "background_color": "#0F0F11", "theme_color": "#0F0F11", "categories": ["music", "productivity"],
    "icons": [
        {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
        {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        {"src": "icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"}],
    "share_target": {"action": "./share-target", "method": "POST", "enctype": "multipart/form-data",
                     "params": {"title": "title", "files": [{"name": "audio", "accept": ["audio/*", ".wav", ".mp3", ".ogg", ".flac", ".m4a", ".opus"]}]}},
    "file_handlers": [{"action": "./", "accept": {"audio/*": [".wav", ".mp3", ".ogg", ".flac", ".m4a", ".opus"]}}],
}
open(os.path.join(pwa, 'manifest.webmanifest'), 'w').write(json.dumps(manifest, indent=2))
fonts = sorted(os.listdir(os.path.join(pwa, 'fonts')))
shell = ['./', './index.html', './manifest.webmanifest', './icons/favicon-48.png', './icons/icon-192.png', './icons/icon-512.png',
         './icons/maskable-512.png', './vendor/lame.min.js'] + [f'./fonts/{f}' for f in fonts if f.endswith('.woff2')]
open(os.path.join(pwa, 'sw.js'), 'w').write(f'''/* SnapWav service worker: offline app shell + Android share target */
const CACHE = 'snapwav-v{VERSION}';
const SHELL = {json.dumps(shell)};
self.addEventListener('install', e => {{ e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); }});
self.addEventListener('activate', e => {{
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE && k !== 'snapwav-share').map(k => caches.delete(k)))).then(() => self.clients.claim()));
}});
self.addEventListener('fetch', e => {{
  const req = e.request, url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {{
    e.respondWith((async () => {{
      const form = await req.formData();
      const cache = await caches.open('snapwav-share');
      let i = 0;
      for (const f of form.getAll('audio')) {{
        if (!f || !f.size) continue;
        await cache.put(new Request('./shared/' + (Date.now() + i++)), new Response(f, {{ headers: {{ 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'shared-audio') }} }}));
      }}
      return Response.redirect('./?shared=1', 303);
    }})());
    return;
  }}
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (req.mode === 'navigate') {{
    e.respondWith(fetch(req).then(res => {{ const copy = res.clone(); caches.open(CACHE).then(c => c.put('./index.html', copy)); return res; }}).catch(() => caches.match('./index.html')));
    return;
  }}
  e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
}});
''')

# ---------- Android assets ----------
andr = os.path.join(DIST, 'android', 'www'); os.makedirs(andr)
copy_common(andr)
open(os.path.join(andr, 'index.html'), 'w').write(page('<link rel="icon" href="icons/favicon-48.png" type="image/png">', 'window.SNAPWAV_APP = "android";'))
if not args.no_android_sync and os.path.isdir(os.path.dirname(os.path.dirname(ANDROID_ASSETS))):
    if os.path.exists(ANDROID_ASSETS): shutil.rmtree(ANDROID_ASSETS)
    shutil.copytree(andr, ANDROID_ASSETS)
    print('synced Android assets →', os.path.relpath(ANDROID_ASSETS, ROOT))

# ---------- optional single-file page (used for the hosted Claude artifact) ----------
if args.artifact:
    open(args.artifact, 'w').write(f'<title>SnapWav</title>\n{HEADER}\n<script>{THEME_JS}</script>\n{GOOGLE_FONTS}\n<style>\n{css}\n</style>\n{body}\n{sprite}\n<script>\n{js}\n</script>\n')
    print('artifact →', args.artifact)

print(f'built v{VERSION}: {len(symbols)} icons, index {os.path.getsize(os.path.join(pwa, "index.html")) // 1024} KB')
