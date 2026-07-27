'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.resolve(ROOT, '..', 'N.E.K.O.-PC');
const FILES = [
  'src/main/portable-update.js',
  'src/main/portable-update-posix.js',
  'src/main/update-source.js',
  'src/main/update-check-service.js',
  'scripts/create-portable-update.js',
];

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

let failed = false;
for (const relative of FILES) {
  const upstream = path.join(SOURCE, relative);
  const local = path.join(ROOT, relative);
  if (!fs.existsSync(upstream) || hash(upstream) !== hash(local)) {
    console.error(`DIFF: ${relative}`);
    failed = true;
  } else console.log(`OK: ${relative}`);
}
if (failed) process.exitCode = 1;
