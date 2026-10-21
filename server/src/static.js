// Serves the built client (client/dist) so the whole app runs from one port.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
};

export function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return (req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    let file = path.join(root, rel);
    if (path.relative(root, file).startsWith('..')) {
      res.writeHead(403).end('forbidden');
      return;
    }
    // Unknown paths and folders fall back to the single-page app's index.html.
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Client not built. Run: npm run build');
      return;
    }

    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  };
}
