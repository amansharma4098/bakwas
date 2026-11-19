import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const dist = new URL('../dist/', import.meta.url);
await mkdir(dist, { recursive: true });
for (const page of ['index.html', 'team.html', 'clients.html', 'products.html']) await copyFile(new URL('../' + page, import.meta.url), new URL(page, dist));
await writeFile(new URL('_headers', dist), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'
`);
console.log('Built the page and static security headers in dist/.');
