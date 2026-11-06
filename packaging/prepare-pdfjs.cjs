'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const renderer = path.resolve(process.argv[2] || path.join(__dirname, '..', 'renderer'));
const destination = path.join(renderer, 'pdfjs');

fs.mkdirSync(destination, { recursive: true });
for (const name of ['cmaps', 'iccs', 'standard_fonts', 'wasm']) {
  fs.cpSync(path.join(packageRoot, name), path.join(destination, name), { recursive: true });
}
fs.copyFileSync(path.join(packageRoot, 'LICENSE'), path.join(destination, 'LICENSE'));

const buildDestination = path.join(destination, 'build');
fs.mkdirSync(buildDestination, { recursive: true });
for (const name of fs.readdirSync(path.join(packageRoot, 'build'))) {
  if (name.endsWith('.mjs')) {
    fs.copyFileSync(path.join(packageRoot, 'build', name), path.join(buildDestination, name));
  }
}
