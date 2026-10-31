from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
EXTENSION = ROOT.parent / 'extension'


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlsplit(self.path)
        route = parsed.path
        if route in ('/', '/watch'):
            background = route == '/watch' and parse_qs(parsed.query).get('fixture') == ['background']
            self.path = '/background-fixture.html' if background else '/fixture.html'
        elif route.startswith('/extension/'):
            filename = route.removeprefix('/extension/')
            if filename not in ('page-hook.js', 'content.js'):
                self.send_error(404)
                return
            file = EXTENSION / filename
            if not file.is_file():
                self.send_error(404)
                return
            source = file.read_text()
            content = source.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/javascript; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return
        super().do_GET()


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 8766), Handler)
    print('Experimental click fixture: http://127.0.0.1:8766/watch?v=fixture', flush=True)
    print('Background fixture: http://127.0.0.1:8766/watch?v=background-fixture&fixture=background', flush=True)
    server.serve_forever()
