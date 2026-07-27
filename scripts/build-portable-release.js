'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const BUILD_INFO_PATH = path.join(ROOT, 'resources', 'build-info.json');

function argument(name, required = true) {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1] : '';
  if (required && (!value || value.startsWith('--'))) throw new Error(`Missing --${name}`);
  return value || '';
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with ${result.status}`);
}

function main() {
  const version = argument('version');
  const flavor = argument('flavor', false) || 'Ocean blue';
  const previous = argument('previous', false);
  const accent = argument('accent', false) || '#2dd4bf';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid version: ${version}`);

  const originalPackage = fs.readFileSync(PACKAGE_PATH, 'utf8');
  const originalBuildInfo = fs.readFileSync(BUILD_INFO_PATH, 'utf8');
  const stage = path.join(ROOT, 'dist', 'stage', version);
  const unpacked = path.join(stage, 'win-unpacked');
  const release = path.join(ROOT, 'dist', 'releases', version);
  const builderCli = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');

  try {
    const packageJson = JSON.parse(originalPackage);
    packageJson.version = version;
    fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
    fs.writeFileSync(BUILD_INFO_PATH, `${JSON.stringify({ version, flavor, accent }, null, 2)}\n`, 'utf8');

    run(process.execPath, [builderCli, '--win', '--dir', `--config.directories.output=${stage}`]);
    fs.rmSync(release, { recursive: true, force: true });
    const updaterArgs = ['scripts/create-portable-update.js', '--dir', unpacked, '--version', version, '--out', release];
    if (previous) updaterArgs.push('--previous', path.resolve(ROOT, previous));
    run(process.execPath, updaterArgs);
    if (previous) {
      const manifestPath = path.join(release, `N.E.K.O_${version}_win_manifest.json`);
      const previousManifest = JSON.parse(fs.readFileSync(path.resolve(ROOT, previous), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (!manifest.deltas.some((delta) => delta.fromVersion === previousManifest.version)) {
        throw new Error(`Expected a delta from ${previousManifest.version} to ${version}`);
      }
    }
    console.log(`\nBuilt Portable test release v${version}`);
    console.log(`Run this build: ${path.join(unpacked, 'N.E.K.O.exe')}`);
    console.log(`Serve these assets: ${release}`);
  } finally {
    fs.writeFileSync(PACKAGE_PATH, originalPackage, 'utf8');
    fs.writeFileSync(BUILD_INFO_PATH, originalBuildInfo, 'utf8');
  }
}

try { main(); } catch (error) { console.error(error.message || error); process.exitCode = 1; }
