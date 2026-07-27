'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const archiver = require('archiver');
const {
  getTargetKey,
  normalizeArch,
  validatePortableManifest,
} = require('../src/main/portable-update');

const APPIMAGE_BLOCK_SIZE = 1024 * 1024;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  for (const required of ['version', 'out']) {
    if (!values[required]) throw new Error(`Missing required --${required}`);
  }
  if (!values.dir && !values.appimage) throw new Error('Missing required --dir or --appimage');
  if (values.dir && values.appimage) throw new Error('Use only one of --dir or --appimage');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(values.version)) {
    throw new Error(`Invalid version: ${values.version}`);
  }
  return values;
}

function toPortablePath(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function listEntries(root) {
  const output = [];
  const visit = (directory) => {
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = toPortablePath(root, absolute);
      if (entry.isSymbolicLink()) output.push({ absolute, relative, type: 'symlink' });
      else if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) output.push({ absolute, relative, type: 'file' });
    }
  };
  visit(root);
  return output;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return output;
}

async function collectManifestFiles(root, platform = 'win32') {
  const entries = listEntries(root);
  return mapLimit(entries, 4, async (entry) => {
    if (entry.type === 'symlink') {
      return { path: entry.relative, type: 'symlink', linkTarget: fs.readlinkSync(entry.absolute) };
    }
    const stat = fs.statSync(entry.absolute);
    return {
      path: entry.relative,
      type: 'file',
      size: stat.size,
      sha256: await hashFile(entry.absolute),
      ...(platform === 'win32' ? {} : { mode: stat.mode & 0o777 }),
    };
  });
}

function createZip(destination, root, fileRecords) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'w' });
    const archive = archiver('zip', { zlib: { level: 6 }, forceZip64: true });
    output.on('close', () => resolve({ size: archive.pointer() }));
    output.on('error', reject);
    archive.on('warning', (error) => { if (error.code !== 'ENOENT') reject(error); });
    archive.on('error', reject);
    archive.pipe(output);
    for (const record of fileRecords) {
      if (record.type === 'symlink') archive.symlink(record.path, record.linkTarget);
      else archive.file(path.join(root, ...record.path.split('/')), { name: record.path });
    }
    archive.finalize();
  });
}

function createTarGz(destination, root, fileRecords) {
  const listPath = path.join(os.tmpdir(), `neko-portable-${process.pid}-${crypto.randomBytes(5).toString('hex')}.txt`);
  try {
    fs.writeFileSync(listPath, fileRecords.map((record) => `./${record.path}`).join('\n') + '\n', 'utf8');
    const result = spawnSync('tar', ['-czf', destination, '-C', root, '-T', listPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.stdout}`);
    return { size: fs.statSync(destination).size };
  } finally {
    try { fs.unlinkSync(listPath); } catch (_) {}
  }
}

function readPreviousManifest(filePath, expectedTarget) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const manifest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return validatePortableManifest(manifest, '', expectedTarget);
}

function recordsEqual(left, right) {
  return left?.type === right?.type
    && left?.size === right?.size
    && left?.sha256 === right?.sha256
    && left?.mode === right?.mode
    && left?.linkTarget === right?.linkTarget;
}

function calculateDelta(previous, latestFiles) {
  if (!previous) return null;
  const previousFiles = new Map(previous.files.map((record) => [record.path, record]));
  const latestPaths = new Set(latestFiles.map((record) => record.path));
  const changed = latestFiles.filter((record) => !recordsEqual(previousFiles.get(record.path), record));
  const deleted = previous.files
    .filter((record) => !latestPaths.has(record.path))
    .map((record) => record.path)
    .sort((left, right) => left.localeCompare(right, 'en'));
  return { changed, deleted };
}

function defaultEntrypoint(platform) {
  if (platform === 'darwin') return 'Contents/MacOS/N.E.K.O';
  if (platform === 'linux') return 'n.e.k.o';
  return 'N.E.K.O.exe';
}

function markerResourcesDir(bundleDir, platform) {
  return platform === 'darwin'
    ? path.join(bundleDir, 'Contents', 'Resources')
    : path.join(bundleDir, 'resources');
}

async function buildPortableUpdate(options) {
  const bundleDir = path.resolve(options.dir);
  const outputDir = path.resolve(options.out);
  const version = options.version;
  const platform = options.platform || 'win32';
  const arch = normalizeArch(options.arch || 'x64');
  const distribution = 'archive-portable';
  const targetKey = getTargetKey(platform, arch, distribution);
  const entrypoint = options.entrypoint || defaultEntrypoint(platform);
  if (!targetKey) throw new Error(`Unsupported Portable target: ${platform}-${arch}`);
  if (!fs.statSync(bundleDir).isDirectory()) throw new Error(`Bundle directory not found: ${bundleDir}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const resourcesDir = markerResourcesDir(bundleDir, platform);
  if (!fs.existsSync(path.join(resourcesDir, 'app.asar'))) {
    throw new Error(`Expected Electron app.asar was not found: ${resourcesDir}`);
  }
  if (!fs.existsSync(path.join(bundleDir, ...entrypoint.split('/')))) {
    throw new Error(`Expected Portable entrypoint was not found: ${entrypoint}`);
  }
  const marker = {
    schemaVersion: 1,
    distribution: platform === 'win32' ? 'zip-portable' : distribution,
    product: 'N.E.K.O',
    platform,
    arch,
    version,
  };
  fs.writeFileSync(path.join(resourcesDir, 'neko-distribution.json'), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const files = await collectManifestFiles(bundleDir, platform);
  const extension = platform === 'win32' ? '.zip' : '.tar.gz';
  const fullAssetName = `N.E.K.O_${version}_${targetKey}${extension}`;
  const fullPath = path.join(outputDir, fullAssetName);
  if (platform === 'win32') await createZip(fullPath, bundleDir, files);
  else createTarGz(fullPath, bundleDir, files);
  const manifest = {
    schemaVersion: 1,
    product: 'N.E.K.O',
    version,
    platform,
    arch,
    distribution,
    entrypoint,
    generatedAt: new Date().toISOString(),
    full: { assetName: fullAssetName, size: fs.statSync(fullPath).size, sha256: await hashFile(fullPath) },
    files,
    deltas: [],
  };

  const previous = readPreviousManifest(options.previous, { platform, arch, distribution });
  if (previous && previous.version !== version) {
    const delta = calculateDelta(previous, files);
    const deltaAssetName = `N.E.K.O_${previous.version}_to_${version}_${targetKey}_delta${extension}`;
    const deltaPath = path.join(outputDir, deltaAssetName);
    if (platform === 'win32') await createZip(deltaPath, bundleDir, delta.changed);
    else createTarGz(deltaPath, bundleDir, delta.changed);
    manifest.deltas.push({
      fromVersion: previous.version,
      assetName: deltaAssetName,
      size: fs.statSync(deltaPath).size,
      sha256: await hashFile(deltaPath),
      files: delta.changed.map((record) => record.path),
      delete: delta.deleted,
    });
  }

  validatePortableManifest(manifest, version, { platform, arch, distribution });
  const manifestPath = path.join(outputDir, `N.E.K.O_${version}_${targetKey}_manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, outputDir };
}

async function collectBlocks(filePath, blockSize = APPIMAGE_BLOCK_SIZE) {
  const blocks = [];
  const handle = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(blockSize);
  try {
    let position = 0;
    while (true) {
      const size = fs.readSync(handle, buffer, 0, blockSize, position);
      if (size === 0) break;
      blocks.push({ size, sha256: crypto.createHash('sha256').update(buffer.subarray(0, size)).digest('hex') });
      position += size;
    }
  } finally { fs.closeSync(handle); }
  return blocks;
}

async function buildAppImageUpdate(options) {
  const sourcePath = path.resolve(options.appimage);
  const outputDir = path.resolve(options.out);
  const version = options.version;
  const platform = 'linux';
  const arch = normalizeArch(options.arch || 'x64');
  const distribution = 'appimage-portable';
  const targetKey = getTargetKey(platform, arch, distribution);
  if (!targetKey || !fs.statSync(sourcePath).isFile()) throw new Error(`Invalid AppImage target: ${sourcePath}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const fullAssetName = `N.E.K.O_${version}_${targetKey}.AppImage`;
  const fullPath = path.join(outputDir, fullAssetName);
  fs.copyFileSync(sourcePath, fullPath);
  const blocks = await collectBlocks(fullPath);
  const manifest = {
    schemaVersion: 1,
    product: 'N.E.K.O',
    version,
    platform,
    arch,
    distribution,
    generatedAt: new Date().toISOString(),
    full: {
      assetName: fullAssetName,
      size: fs.statSync(fullPath).size,
      sha256: await hashFile(fullPath),
      blockSize: APPIMAGE_BLOCK_SIZE,
      blocks,
    },
    deltas: [],
  };
  const previous = readPreviousManifest(options.previous, { platform, arch, distribution });
  if (previous && previous.version !== version) {
    const changed = blocks
      .map((block, index) => ({ ...block, index }))
      .filter((block) => previous.full.blocks?.[block.index]?.sha256 !== block.sha256 || previous.full.blocks?.[block.index]?.size !== block.size);
    const deltaAssetName = `N.E.K.O_${previous.version}_to_${version}_${targetKey}_delta.bin`;
    const deltaPath = path.join(outputDir, deltaAssetName);
    const source = fs.openSync(fullPath, 'r');
    const output = fs.openSync(deltaPath, 'w');
    const buffer = Buffer.allocUnsafe(APPIMAGE_BLOCK_SIZE);
    try {
      changed.forEach((block, deltaIndex) => {
        const size = fs.readSync(source, buffer, 0, block.size, block.index * APPIMAGE_BLOCK_SIZE);
        if (size !== block.size) throw new Error(`AppImage block read failed: ${block.index}`);
        fs.writeSync(output, buffer, 0, size);
        block.deltaIndex = deltaIndex;
      });
    } finally {
      fs.closeSync(source);
      fs.closeSync(output);
    }
    const deltaSize = fs.statSync(deltaPath).size;
    if (deltaSize > 0 && deltaSize < manifest.full.size) {
      manifest.deltas.push({
        fromVersion: previous.version,
        assetName: deltaAssetName,
        size: deltaSize,
        sha256: await hashFile(deltaPath),
        blocks: changed,
      });
    } else {
      fs.unlinkSync(deltaPath);
    }
  }
  validatePortableManifest(manifest, version, { platform, arch, distribution });
  const manifestPath = path.join(outputDir, `N.E.K.O_${version}_${targetKey}_manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, manifestPath, outputDir };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.appimage ? await buildAppImageUpdate(options) : await buildPortableUpdate(options);
  const delta = result.manifest.deltas[0];
  console.log(`Portable full package: ${result.manifest.full.assetName}`);
  console.log(`Portable manifest: ${path.basename(result.manifestPath)}`);
  console.log(delta ? `Portable delta: ${delta.assetName}` : 'Portable delta: skipped (no useful previous manifest)');
}

if (require.main === module) {
  run().catch((error) => { console.error(error); process.exitCode = 1; });
}

module.exports = {
  APPIMAGE_BLOCK_SIZE,
  buildAppImageUpdate,
  buildPortableUpdate,
  calculateDelta,
  collectBlocks,
  collectManifestFiles,
  parseArgs,
};
