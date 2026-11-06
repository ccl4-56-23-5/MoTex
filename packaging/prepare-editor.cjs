'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'renderer', 'vendor');
const bundle = buildSync({
  absWorkingDir: root,
  stdin: {
    contents: [
      "export { Annotation, Compartment, EditorState } from '@codemirror/state';",
      "export { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, keymap, lineNumbers, placeholder } from '@codemirror/view';",
      "export { defaultKeymap } from '@codemirror/commands';",
    ].join('\n'),
    resolveDir: root,
    sourcefile: 'codemirror-entry.mjs',
  },
  outfile: path.join(vendor, 'codemirror.mjs'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'eof',
  metafile: true,
  write: false,
});

const licenses = new Map();
for (const input of Object.keys(bundle.metafile.inputs)) {
  if (input === 'codemirror-entry.mjs') continue;
  let directory = path.dirname(path.resolve(root, input));
  while (!fs.existsSync(path.join(directory, 'package.json'))) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('No package metadata for ' + input);
    directory = parent;
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const label = metadata.name + '@' + metadata.version;
  if (licenses.has(label)) continue;
  const file = fs.readdirSync(directory).find(name => /^license(?:[.-].*)?$/i.test(name));
  if (!file) throw new Error('No license file for ' + label);
  licenses.set(label, fs.readFileSync(path.join(directory, file), 'utf8').trim());
}

fs.mkdirSync(vendor, { recursive: true });
for (const output of bundle.outputFiles) fs.writeFileSync(output.path, output.contents);
const notices = [...licenses.keys()].sort().map(label => label + '\n\n' + licenses.get(label));
fs.writeFileSync(path.join(vendor, 'codemirror-LICENSES.txt'), notices.join('\n\n' + '-'.repeat(64) + '\n\n') + '\n', 'utf8');
