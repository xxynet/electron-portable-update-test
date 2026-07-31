'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const https = require('node:https');
const { spawn } = require('node:child_process');
const {
  buildAppImageUpdaterShell,
  buildArchiveUpdaterShell,
} = require('./portable-update-posix');
const {
  isAllowedUpdateRedirectUrl,
  isUpdateServiceDownloadUrl,
} = require('./update-source');

const MANIFEST_SCHEMA_VERSION = 1;
const DISTRIBUTION_MARKER_NAME = 'neko-distribution.json';
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30000;
const PACKAGE_DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_REDIRECTS = 5;
const MAX_NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 500;
const SUPPORTED_ARCHES = new Set(['x64', 'arm64']);
const DEFAULT_RELEASE_REPOSITORY = 'xxynet/electron-portable-update-test';
const MANAGED_FILES_NAME = 'neko-portable-managed-files.json';
const ALLOWED_RELEASE_REPOSITORIES = new Set([
  DEFAULT_RELEASE_REPOSITORY,
]);

function normalizeArch(value) {
  const arch = String(value || '').toLowerCase();
  if (arch === 'amd64' || arch === 'x86_64') return 'x64';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

function getTargetKey(platform, arch, distribution = 'archive-portable') {
  const normalizedArch = normalizeArch(arch);
  if (platform === 'win32' && normalizedArch === 'x64' && distribution === 'archive-portable') return 'win';
  if (platform === 'darwin' && SUPPORTED_ARCHES.has(normalizedArch) && distribution === 'archive-portable') {
    return `mac_${normalizedArch}`;
  }
  if (platform === 'linux' && normalizedArch === 'x64') {
    return distribution === 'appimage-portable' ? 'linux_x64_appimage' : 'linux_x64';
  }
  return null;
}

function getArchiveExtension(platform) {
  return platform === 'win32' ? '.zip' : '.tar.gz';
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || value.includes(':')) return false;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function isSafeSymlinkTarget(linkPath, value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || value.includes(':') || value.startsWith('/')) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), value));
  return resolved !== '..' && !resolved.startsWith('../') && !resolved.startsWith('/');
}

function isSha256(value) {
  return /^[a-f0-9]{64}$/.test(String(value || ''));
}

function retryTransientNetworkError(error, options, retry) {
  const retryCount = Number(options.retryCount || 0);
  if (!['ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'ETIMEDOUT'].includes(error?.code)
    || retryCount >= MAX_NETWORK_RETRIES) return false;
  setTimeout(retry, NETWORK_RETRY_DELAY_MS * (retryCount + 1));
  return true;
}

function createTimeoutError() {
  const error = new Error('portable_update_timeout');
  error.code = 'ETIMEDOUT';
  return error;
}

function createElectronNetTransport(netRef) {
  if (!netRef || typeof netRef.request !== 'function') return null;
  return {
    get(urlValue, options, callback) {
      // Electron follows redirects by default. Keep them manual so the same
      // allowlist and redirect limit used by the Node transport applies here.
      const request = netRef.request({ method: 'GET', url: urlValue, redirect: 'manual' });
      for (const [name, value] of Object.entries(options?.headers || {})) {
        request.setHeader?.(name, value);
      }
      request.on('response', callback);
      // Electron ClientRequest has abort(), rather than Node's destroy(error).
      // Keep the small Node-compatible surface used by the updater below.
      if (typeof request.destroy !== 'function') {
        request.destroy = (error) => {
          try { request.abort?.(); } catch (_) {}
          if (error) queueMicrotask(() => request.emit('error', error));
        };
      }
      if (typeof request.setTimeout !== 'function') {
        request.setTimeout = (timeoutMs, onTimeout) => {
          let timer = null;
          const clear = () => {
            if (timer) clearTimeout(timer);
            timer = null;
          };
          const arm = () => {
            clear();
            timer = setTimeout(() => {
              timer = null;
              onTimeout?.();
            }, timeoutMs);
          };
          // Electron's ClientRequest has no socket-level timeout.  Keep an
          // idle timer armed for the body as well as the connection: headers
          // alone must not let a stalled manifest/package read hang forever.
          arm();
          request.once('response', (response) => {
            response.on?.('data', arm);
            response.once?.('end', clear);
            response.once?.('error', clear);
            response.once?.('close', clear);
          });
          request.once('error', clear);
          request.once('abort', clear);
          return request;
        };
      }
      request.end();
      return request;
    },
  };
}

function getManagedFilesPath(target) {
  if (!target?.targetPath) return null;
  const resourcesPath = target.platform === 'darwin'
    ? path.join(target.targetPath, 'Contents', 'Resources')
    : path.join(target.targetPath, 'resources');
  return path.join(resourcesPath, MANAGED_FILES_NAME);
}

function getInstalledManagedFiles(target, fsRef = fs) {
  const resourcesPrefix = target?.platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const managed = new Set([`${resourcesPrefix}/${DISTRIBUTION_MARKER_NAME}`]);
  const inventoryPath = getManagedFilesPath(target);
  if (!inventoryPath) return managed;
  try {
    const inventory = JSON.parse(fsRef.readFileSync(inventoryPath, 'utf8'));
    if (inventory?.schemaVersion !== MANIFEST_SCHEMA_VERSION || inventory?.product !== 'N.E.K.O'
      || !Array.isArray(inventory.files)) return managed;
    for (const filePath of inventory.files) {
      if (isSafeRelativePath(filePath)) managed.add(filePath);
    }
    managed.add(`${resourcesPrefix}/${MANAGED_FILES_NAME}`);
  } catch (_) {}
  return managed;
}

function managedPathKey(filePath, platform) {
  const value = String(filePath || '');
  return platform === 'linux' ? value : value.toLowerCase();
}

function collectUnmanagedPortableEntries(root, managedFiles, fsRef = fs, platform = 'win32') {
  const entries = [];
  const managed = new Set([...managedFiles].map((value) => managedPathKey(value, platform)));
  const visit = (directory, prefix = '') => {
    let children;
    try { children = fsRef.readdirSync(directory, { withFileTypes: true }); } catch (_) { return false; }
    for (const child of children) {
      const relative = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = path.join(directory, child.name);
      const key = managedPathKey(relative, platform);
      let stat;
      try { stat = fsRef.lstatSync(absolute); } catch (_) { continue; }
      // Electron's patched fs exposes an ASAR file as a virtual directory.
      // Never descend into that virtual tree: its entries are part of a
      // managed archive, not user files placed beside the Portable app.
      const isAsarArchive = relative.toLowerCase().endsWith('.asar');
      if (stat.isDirectory() && !stat.isSymbolicLink() && !isAsarArchive) {
        const hasChildren = visit(absolute, relative);
        // Empty user directories still carry user intent. Record them so a
        // later managed file at the same path cannot silently replace them.
        if (!hasChildren && !managed.has(key) && isSafeRelativePath(relative)) {
          entries.push(relative);
        }
      } else if (!managed.has(key) && isSafeRelativePath(relative)) {
        entries.push(relative);
      }
    }
    return children.length > 0;
  };
  visit(root);
  return entries;
}

function hasManagedPathConflict(filePath, managedFiles, platform = 'win32') {
  const candidate = managedPathKey(filePath, platform);
  return [...managedFiles].some((managedPath) => {
    const managed = managedPathKey(managedPath, platform);
    return candidate === managed
      || candidate.startsWith(`${managed}/`)
      || managed.startsWith(`${candidate}/`);
  });
}

function findUnmanagedManagedConflicts(root, installedManagedFiles, targetManagedFiles, fsRef = fs, platform = 'win32') {
  return collectUnmanagedPortableEntries(root, installedManagedFiles, fsRef, platform)
    .filter((filePath) => hasManagedPathConflict(filePath, targetManagedFiles, platform));
}

function prunePortableUpdateCache(userDataPath, fsRef = fs) {
  const cacheRoot = path.join(String(userDataPath || ''), 'portable-updates');
  if (!userDataPath) return;
  let versions;
  try { versions = fsRef.readdirSync(cacheRoot, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of versions) {
    if (!entry.isDirectory()) continue;
    const versionDir = path.join(cacheRoot, entry.name);
    let children;
    try { children = fsRef.readdirSync(versionDir, { withFileTypes: true }); } catch (_) { continue; }
    for (const child of children) {
      // Keep the diagnostic log, but remove packages, plans, launchers and
      // helpers left by a previously successful updater invocation.
      if (child.name === 'portable-update.log') continue;
      try { fsRef.rmSync(path.join(versionDir, child.name), { recursive: true, force: true }); } catch (_) {}
    }
  }
}

function normalizeReleaseRepository(value, testReleaseRepository = null) {
  const repository = String(value || '').trim();
  const configuredTestRepository = String(testReleaseRepository || '').trim();
  const isConfiguredTestRepository = repository === configuredTestRepository
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configuredTestRepository);
  return (ALLOWED_RELEASE_REPOSITORIES.has(repository) || isConfiguredTestRepository)
    && (!configuredTestRepository || repository === configuredTestRepository || repository === DEFAULT_RELEASE_REPOSITORY)
    ? repository : null;
}

function isAllowedReleaseAssetUrl(
  value,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  updateServiceBaseUrl = null,
  testReleaseRepository = null,
) {
  if (isUpdateServiceDownloadUrl(value, updateServiceBaseUrl)) return true;
  try {
    const repository = normalizeReleaseRepository(releaseRepository, testReleaseRepository);
    if (!repository) return false;
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith(`/${repository}/releases/download/`);
  } catch (_) {
    return false;
  }
}

function findReleaseAsset(
  release,
  assetName,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  updateServiceBaseUrl = null,
  testReleaseRepository = null,
) {
  const asset = Array.isArray(release?.assets)
    ? release.assets.find((candidate) => candidate?.name === assetName)
    : null;
  if (!asset || !isAllowedReleaseAssetUrl(
    asset.browser_download_url,
    releaseRepository,
    updateServiceBaseUrl,
    testReleaseRepository,
  )) return null;
  return asset;
}

function findPortableManifestAsset(
  release,
  target = {},
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  updateServiceBaseUrl = null,
  testReleaseRepository = null,
) {
  const candidates = Array.isArray(release?.assets) ? release.assets : [];
  const targetKey = getTargetKey(target.platform, target.arch, target.distribution);
  const exactName = target.version && targetKey
    ? `N.E.K.O_${target.version}_${targetKey}_manifest.json`
    : '';
  return candidates.find((asset) => (
    (exactName ? asset?.name === exactName : /^N\.E\.K\.O_[0-9A-Za-z.-]+_(?:win|mac_(?:x64|arm64)|linux_x64(?:_appimage)?)_manifest\.json$/.test(String(asset?.name || '')))
      && isAllowedReleaseAssetUrl(
        asset?.browser_download_url,
        releaseRepository,
        updateServiceBaseUrl,
        testReleaseRepository,
      )
  )) || null;
}

function validateFileRecord(record, platform) {
  if (!record || !isSafeRelativePath(record.path)) return false;
  if (record.type === 'symlink') {
    return platform !== 'win32' && isSafeSymlinkTarget(record.path, record.linkTarget);
  }
  return (!record.type || record.type === 'file')
    && Number.isSafeInteger(record.size)
    && record.size >= 0
    && isSha256(record.sha256)
    && (platform === 'win32' || (Number.isSafeInteger(record.mode) && record.mode >= 0 && record.mode <= 0o777));
}

function validatePortableManifest(manifest, expectedVersion = '', expectedTarget = null) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error('portable_manifest_schema_invalid');
  }
  const distribution = manifest.distribution || (manifest.platform === 'win32' ? 'archive-portable' : '');
  const targetKey = getTargetKey(manifest.platform, manifest.arch, distribution);
  if (manifest.product !== 'N.E.K.O' || !targetKey) {
    throw new Error('portable_manifest_target_invalid');
  }
  if (expectedTarget && (
    manifest.platform !== expectedTarget.platform
    || normalizeArch(manifest.arch) !== normalizeArch(expectedTarget.arch)
    || distribution !== expectedTarget.distribution
  )) throw new Error('portable_manifest_target_mismatch');
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('portable_manifest_version_invalid');
  }
  if (expectedVersion && manifest.version !== expectedVersion) {
    throw new Error('portable_manifest_version_mismatch');
  }
  const isAppImage = distribution === 'appimage-portable';
  const expectedFullAssetName = `N.E.K.O_${manifest.version}_${targetKey}${isAppImage ? '.AppImage' : getArchiveExtension(manifest.platform)}`;
  if (!manifest.full
    || manifest.full.assetName !== expectedFullAssetName
    || !Number.isSafeInteger(manifest.full.size)
    || manifest.full.size <= 0
    || !isSha256(manifest.full.sha256)) {
    throw new Error('portable_manifest_full_invalid');
  }
  if (isAppImage) {
    if (!Number.isSafeInteger(manifest.full.blockSize)
      || manifest.full.blockSize < 64 * 1024
      || !Array.isArray(manifest.full.blocks)
      || manifest.full.blocks.length === 0
      || manifest.full.blocks.some((block, index) => !block
        || !Number.isSafeInteger(block.size)
        || block.size <= 0
        || block.size > manifest.full.blockSize
        || (index < manifest.full.blocks.length - 1 && block.size !== manifest.full.blockSize)
        || !isSha256(block.sha256))) {
      throw new Error('portable_manifest_blocks_invalid');
    }
    if (manifest.full.blocks.reduce((sum, block) => sum + block.size, 0) !== manifest.full.size) {
      throw new Error('portable_manifest_blocks_size_invalid');
    }
  } else if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('portable_manifest_files_invalid');
  }

  const latestPaths = new Set();
  const latestPathKeys = new Set();
  for (const record of Array.isArray(manifest.files) ? manifest.files : []) {
    const pathKey = manifest.platform === 'linux' ? String(record?.path || '') : String(record?.path || '').toLowerCase();
    if (!validateFileRecord(record, manifest.platform) || latestPathKeys.has(pathKey)) {
      throw new Error('portable_manifest_file_invalid');
    }
    latestPaths.add(record.path);
    latestPathKeys.add(pathKey);
  }
  const symlinkPaths = (manifest.files || [])
    .filter((record) => record.type === 'symlink')
    .map((record) => record.path);
  if ((manifest.files || []).some((record) => symlinkPaths.some((linkPath) => (
    record.path !== linkPath && record.path.startsWith(`${linkPath}/`)
  )))) throw new Error('portable_manifest_symlink_prefix_invalid');
  const entrypoint = manifest.entrypoint || (manifest.platform === 'win32' ? 'N.E.K.O.exe' : '');
  const entrypointRecord = (manifest.files || []).find((record) => record.path === entrypoint);
  if (!isAppImage && (!isSafeRelativePath(entrypoint) || !entrypointRecord || entrypointRecord.type === 'symlink')) {
    throw new Error('portable_manifest_executable_missing');
  }

  const fromVersions = new Set();
  for (const delta of Array.isArray(manifest.deltas) ? manifest.deltas : []) {
    if (!delta
      || typeof delta.fromVersion !== 'string'
      || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(delta.fromVersion)
      || fromVersions.has(delta.fromVersion)
      || delta.fromVersion === manifest.version
      || delta.assetName !== `N.E.K.O_${delta.fromVersion}_to_${manifest.version}_${targetKey}_delta${isAppImage ? '.bin' : getArchiveExtension(manifest.platform)}`
      || !Number.isSafeInteger(delta.size)
      || delta.size <= 0
      || !isSha256(delta.sha256)
      || (!isAppImage && (!Array.isArray(delta.files) || !Array.isArray(delta.delete)))
      || (isAppImage && !Array.isArray(delta.blocks))) {
      throw new Error('portable_manifest_delta_invalid');
    }
    fromVersions.add(delta.fromVersion);
    if (isAppImage) {
      const blockIndexes = new Set();
      const deltaIndexes = new Set();
      for (const block of delta.blocks) {
        const targetBlock = manifest.full.blocks?.[block?.index];
        if (!block || !Number.isSafeInteger(block.index) || block.index < 0 || blockIndexes.has(block.index)
          || !Number.isSafeInteger(block.deltaIndex) || block.deltaIndex < 0 || deltaIndexes.has(block.deltaIndex)
          || !targetBlock || block.size !== targetBlock.size || block.sha256 !== targetBlock.sha256) {
          throw new Error('portable_manifest_delta_block_invalid');
        }
        blockIndexes.add(block.index);
        deltaIndexes.add(block.deltaIndex);
      }
      if (delta.blocks.some((_, index) => !deltaIndexes.has(index))
        || delta.blocks.reduce((sum, block) => sum + block.size, 0) !== delta.size) {
        throw new Error('portable_manifest_delta_blocks_size_invalid');
      }
      continue;
    }
    const deltaPaths = new Set();
    for (const filePath of delta.files) {
      const pathKey = manifest.platform === 'linux' ? String(filePath || '') : String(filePath || '').toLowerCase();
      if (!isSafeRelativePath(filePath) || !latestPaths.has(filePath) || deltaPaths.has(pathKey)) {
        throw new Error('portable_manifest_delta_file_invalid');
      }
      deltaPaths.add(pathKey);
    }
    const deletePaths = new Set();
    for (const filePath of delta.delete) {
      const pathKey = manifest.platform === 'linux' ? String(filePath || '') : String(filePath || '').toLowerCase();
      if (!isSafeRelativePath(filePath) || latestPathKeys.has(pathKey) || deletePaths.has(pathKey)) {
        throw new Error('portable_manifest_delta_delete_invalid');
      }
      deletePaths.add(pathKey);
    }
  }
  return manifest;
}

function selectPortablePackage(
  manifest,
  release,
  currentVersion,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  updateServiceBaseUrl = null,
  testReleaseRepository = null,
) {
  const delta = (manifest.deltas || []).find((candidate) => candidate.fromVersion === currentVersion);
  const fileMap = new Map((manifest.files || []).map((record) => [record.path, record]));
  const defaultEntrypoint = manifest.platform === 'win32'
    ? 'N.E.K.O.exe'
    : (manifest.platform === 'darwin' ? 'Contents/MacOS/N.E.K.O' : 'n.e.k.o');
  const postApplyFullFiles = new Set([
    manifest.entrypoint || defaultEntrypoint,
    'resources/app.asar',
    'Contents/Resources/app.asar',
    `resources/${DISTRIBUTION_MARKER_NAME}`,
    `Contents/Resources/${DISTRIBUTION_MARKER_NAME}`,
    `resources/${MANAGED_FILES_NAME}`,
    `Contents/Resources/${MANAGED_FILES_NAME}`,
  ]);
  const packageFor = (descriptor, mode, fullDelete = []) => {
    const asset = findReleaseAsset(
      release,
      descriptor.assetName,
      releaseRepository,
      updateServiceBaseUrl,
      testReleaseRepository,
    );
    if (!asset) return null;
    return {
      mode,
      assetName: descriptor.assetName,
      url: asset.browser_download_url,
      size: descriptor.size,
      sha256: descriptor.sha256,
      allowUpdateServiceMirrors: isUpdateServiceDownloadUrl(
        asset.browser_download_url,
        updateServiceBaseUrl,
      ),
      files: manifest.distribution === 'appimage-portable'
        ? []
        : (mode === 'delta' ? descriptor.files.map((filePath) => fileMap.get(filePath)) : manifest.files),
      // A full package is fully checked in the staging directory before an
      // atomic directory swap. Re-hashing every file after that swap provides
      // little extra assurance but can take minutes. Verify the executable,
      // app archive, and updater metadata again instead. Delta updates touch
      // an existing tree, so their final verification remains exhaustive.
      postApplyVerifyFiles: manifest.distribution === 'appimage-portable'
        ? []
        : (mode === 'full'
          ? manifest.files.filter((record) => postApplyFullFiles.has(record.path))
          : manifest.files),
      verifyFiles: manifest.distribution === 'appimage-portable' ? [] : manifest.files,
      // A full package selected as a delta fallback must retain the delta's
      // known removals. This lets directory updaters preserve user files while
      // still removing files managed by the immediately preceding release.
      delete: mode === 'delta' ? descriptor.delete || [] : fullDelete,
      blocks: mode === 'delta' ? descriptor.blocks || [] : [],
    };
  };
  const selectedDelta = delta ? packageFor(delta, 'delta') : null;
  const selected = selectedDelta || packageFor(manifest.full, 'full', delta?.delete || []);
  if (!selected) throw new Error(`portable_update_asset_missing:${manifest.full.assetName}`);
  if (selectedDelta) selected.fallbackPackage = packageFor(manifest.full, 'full', delta.delete || []);
  return selected;
}

function resolvePortableRedirectUrl(location, urlValue, allowUpdateServiceMirrors) {
  let nextUrl;
  try {
    nextUrl = new URL(String(location || ''), urlValue).toString();
  } catch (_) {
    throw new Error('portable_update_redirect_invalid');
  }
  if (!isAllowedUpdateRedirectUrl(nextUrl, allowUpdateServiceMirrors === true)) {
    throw new Error('portable_update_redirect_rejected');
  }
  return nextUrl;
}

function requestBuffer(urlValue, options = {}) {
  const url = new URL(urlValue);
  const transport = options.transport || (url.protocol === 'http:' ? (options.http || http) : (options.https || https));
  const timeoutMs = options.timeoutMs || DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes || MAX_MANIFEST_BYTES;
  const redirects = options.redirects || 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const retryOrReject = (error) => {
      if (settled) return;
      settled = true;
      if (retryTransientNetworkError(error, options, () => {
        requestBuffer(urlValue, { ...options, retryCount: Number(options.retryCount || 0) + 1 }).then(resolve, reject);
      })) return;
      reject(error);
    };
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('portable_update_too_many_redirects'));
      return;
    }
    const request = transport.get(urlValue, {
      headers: { 'User-Agent': options.userAgent || 'N.E.K.O/unknown' },
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        let nextUrl;
        try {
          nextUrl = resolvePortableRedirectUrl(
            response.headers?.location,
            urlValue,
            options.allowUpdateServiceMirrors,
          );
        } catch (error) {
          response.resume?.();
          retryOrReject(error);
          return;
        }
        response.resume?.();
        settled = true;
        requestBuffer(nextUrl, { ...options, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume?.();
        reject(new Error(`portable_update_http_${statusCode || 'unknown'}`));
        return;
      }
      const chunks = [];
      let received = 0;
      response.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        received += buffer.length;
        if (received > maxBytes) {
          settled = true;
          response.destroy?.();
          reject(new Error('portable_update_response_too_large'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks));
      });
      response.on('error', retryOrReject);
    });
    request.on('error', retryOrReject);
    request.setTimeout?.(timeoutMs, () => request.destroy(createTimeoutError()));
  });
}

async function requestPortableManifest(release, expectedVersion, options = {}) {
  const target = options.target || { platform: 'win32', arch: 'x64', distribution: 'archive-portable' };
  const targetKey = getTargetKey(target.platform, target.arch, target.distribution);
  const expectedAssetName = expectedVersion && targetKey ? `N.E.K.O_${expectedVersion}_${targetKey}_manifest.json` : '';
  const asset = expectedAssetName
    ? findReleaseAsset(
      release,
      expectedAssetName,
      options.releaseRepository,
      options.updateServiceBaseUrl,
      options.testReleaseRepository,
    )
    : findPortableManifestAsset(
      release,
      { ...target, version: expectedVersion },
      options.releaseRepository,
      options.updateServiceBaseUrl,
      options.testReleaseRepository,
    );
  if (!asset) return null;
  const buffer = await requestBuffer(asset.browser_download_url, {
    ...options,
    allowUpdateServiceMirrors: isUpdateServiceDownloadUrl(
      asset.browser_download_url,
      options.updateServiceBaseUrl,
    ),
    maxBytes: MAX_MANIFEST_BYTES,
  });
  let manifest;
  try {
    manifest = JSON.parse(buffer.toString('utf8'));
  } catch (_) {
    throw new Error('portable_manifest_json_invalid');
  }
  return validatePortableManifest(manifest, expectedVersion, target);
}

function downloadFile(urlValue, destination, options = {}) {
  const fsRef = options.fs || fs;
  const url = new URL(urlValue);
  const transport = options.transport || (url.protocol === 'http:' ? (options.http || http) : (options.https || https));
  const timeoutMs = options.timeoutMs || PACKAGE_DOWNLOAD_TIMEOUT_MS;
  const redirects = options.redirects || 0;
  const expectedSize = options.expectedSize;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  return new Promise((resolve, reject) => {
    let temporary = null;
    let settled = false;
    const retryOrReject = (error) => {
      if (settled) return;
      settled = true;
      if (temporary) {
        try { fsRef.unlinkSync(temporary); } catch (_) {}
      }
      if (retryTransientNetworkError(error, options, () => {
        downloadFile(urlValue, destination, { ...options, retryCount: Number(options.retryCount || 0) + 1 }).then(resolve, reject);
      })) return;
      reject(error);
    };
    if (redirects > MAX_REDIRECTS) {
      reject(new Error('portable_update_too_many_redirects'));
      return;
    }
    const request = transport.get(urlValue, {
      headers: { 'User-Agent': options.userAgent || 'N.E.K.O/unknown' },
    }, (response) => {
      const statusCode = Number(response.statusCode || 0);
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        let nextUrl;
        try {
          nextUrl = resolvePortableRedirectUrl(
            response.headers?.location,
            urlValue,
            options.allowUpdateServiceMirrors,
          );
        } catch (error) {
          response.resume?.();
          retryOrReject(error);
          return;
        }
        response.resume?.();
        settled = true;
        downloadFile(nextUrl, destination, { ...options, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (statusCode !== 200) {
        response.resume?.();
        reject(new Error(`portable_update_http_${statusCode || 'unknown'}`));
        return;
      }
      temporary = `${destination}.part`;
      const output = fsRef.createWriteStream(temporary, { flags: 'w' });
      let received = 0;
      const contentLength = Number(response.headers?.['content-length']);
      const total = Number.isSafeInteger(expectedSize) && expectedSize > 0
        ? expectedSize
        : (Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : 0);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (Number.isSafeInteger(expectedSize) && received > expectedSize) {
          const error = new Error(`portable_update_size_exceeded:${received}`);
          output.destroy(error);
          response.destroy?.(error);
          retryOrReject(error);
          return;
        }
        if (onProgress) {
          try {
            onProgress({
              received,
              total,
              percent: total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null,
            });
          } catch (_) {}
        }
      });
      response.on('error', (error) => output.destroy(error));
      output.on('error', (error) => {
        try { fsRef.unlinkSync(temporary); } catch (_) {}
        retryOrReject(error);
      });
      output.on('finish', () => {
        output.close(() => {
          if (settled) return;
          if (Number.isSafeInteger(expectedSize) && received !== expectedSize) {
            retryOrReject(new Error(`portable_update_size_mismatch:${received}`));
            return;
          }
          try {
            fsRef.renameSync(temporary, destination);
            settled = true;
            resolve({ path: destination, size: received });
          } catch (error) {
            retryOrReject(error);
          }
        });
      });
      response.pipe(output);
    });
    request.on('error', retryOrReject);
    request.setTimeout?.(timeoutMs, () => request.destroy(createTimeoutError()));
  });
}

function hashFile(filePath, fsRef = fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fsRef.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function getPortableRoot(processRef = process) {
  if (processRef.platform === 'darwin') {
    let current = path.resolve(processRef.execPath);
    while (current !== path.dirname(current)) {
      if (current.toLowerCase().endsWith('.app')) return current;
      current = path.dirname(current);
    }
  }
  return path.dirname(path.resolve(processRef.execPath));
}

function getDistributionMarker(resourcesPath, fsRef = fs) {
  if (!resourcesPath) return null;
  const markerPath = path.join(resourcesPath, DISTRIBUTION_MARKER_NAME);
  try {
    const marker = JSON.parse(fsRef.readFileSync(markerPath, 'utf8'));
    const distribution = marker?.distribution === 'zip-portable' ? 'archive-portable' : marker?.distribution;
    return marker?.schemaVersion === MANIFEST_SCHEMA_VERSION
      && distribution === 'archive-portable'
      && marker?.product === 'N.E.K.O'
      && getTargetKey(marker?.platform, marker?.arch, distribution)
      ? { ...marker, distribution }
      : null;
  } catch (_) {
    return null;
  }
}

function resolvePortableTarget(processRef = process, fsRef = fs) {
  const platform = processRef.platform;
  const arch = normalizeArch(processRef.arch);
  // electron-builder's single-file Portable target exposes these variables.
  // Its parent directory belongs to the user (commonly Downloads), not to the
  // extracted application, so it must never be treated as a directory package.
  if (platform === 'win32' && (processRef.env?.PORTABLE_EXECUTABLE_FILE || processRef.env?.PORTABLE_EXECUTABLE_DIR)) {
    return null;
  }
  if (platform === 'linux' && processRef.env?.APPIMAGE) {
    let targetPath = path.resolve(processRef.env.APPIMAGE);
    try {
      if (!fsRef.statSync(targetPath).isFile()) return null;
      targetPath = fsRef.realpathSync?.(targetPath) || targetPath;
    } catch (_) { return null; }
    return { platform, arch, distribution: 'appimage-portable', targetPath };
  }
  const marker = getDistributionMarker(processRef.resourcesPath, fsRef);
  if (!marker || marker.platform !== platform || normalizeArch(marker.arch) !== arch) return null;
  return {
    platform,
    arch,
    distribution: 'archive-portable',
    targetPath: getPortableRoot(processRef),
    marker,
  };
}

function waitForChildSpawn(child) {
  return new Promise((resolve, reject) => {
    if (!child || typeof child.once !== 'function') {
      reject(new Error('portable_update_helper_invalid'));
      return;
    }
    const onError = (error) => reject(error);
    child.once('error', onError);
    child.once('spawn', () => {
      child.removeListener?.('error', onError);
      resolve(child);
    });
  });
}

function waitForHelperReady(readyPath, {
  fsRef = fs,
  timeoutMs = 5000,
  pollIntervalMs = 50,
} = {}) {
  return new Promise((resolve, reject) => {
    if (!readyPath || typeof fsRef?.existsSync !== 'function') {
      reject(new Error('portable_update_helper_ready_invalid'));
      return;
    }
    const startedAt = Date.now();
    const check = () => {
      try {
        if (fsRef.existsSync(readyPath)) {
          resolve();
          return;
        }
      } catch (_) {}
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error('portable_update_helper_start_timeout'));
        return;
      }
      setTimeout(check, pollIntervalMs);
    };
    check();
  });
}

function buildUpdaterPowerShell() {
  return String.raw`param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
$planData = Get-Content -LiteralPath $Plan -Raw -Encoding UTF8 | ConvertFrom-Json
$logPath = [string]$planData.logPath
$readyPath = [string]$planData.readyPath
function Write-UpdateLog([string]$Message) {
  $line = ('[{0}] {1}' -f ([DateTime]::UtcNow.ToString('o')), $Message)
  try { Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8 } catch { }
}
$progressForm = $null
$progressLabel = $null
function Show-UpdateProgress([string]$Message) {
  Write-UpdateLog $Message
  if ([string]$env:NEKO_PORTABLE_UPDATE_NO_UI -eq '1') { return }
  try {
    if ($null -eq $progressForm) {
      Add-Type -AssemblyName System.Windows.Forms
      $progressForm = New-Object -TypeName System.Windows.Forms.Form
      $progressForm.Text = 'N.E.K.O. Update'
      $progressForm.StartPosition = 'CenterScreen'
      $progressForm.FormBorderStyle = 'FixedDialog'
      $progressForm.ControlBox = $false
      $progressForm.MaximizeBox = $false
      $progressForm.MinimizeBox = $false
      $progressForm.Width = 420
      $progressForm.Height = 132
      $progressLabel = New-Object -TypeName System.Windows.Forms.Label
      $progressLabel.AutoSize = $false
      $progressLabel.Left = 24
      $progressLabel.Top = 30
      $progressLabel.Width = 372
      $progressLabel.Height = 64
      $progressLabel.TextAlign = 'MiddleCenter'
      [void]$progressForm.Controls.Add($progressLabel)
      $progressForm.Show()
    }
    $progressLabel.Text = $Message
    [System.Windows.Forms.Application]::DoEvents()
  } catch {
    Write-UpdateLog ('Update progress UI unavailable: ' + $_.Exception.Message)
  }
}
function Close-UpdateProgress() {
  try { if ($null -ne $progressForm) { $progressForm.Close(); $progressForm.Dispose() } } catch { }
  $progressForm = $null
  $progressLabel = $null
}
$readyPath = $readyPath.Trim()
if ([string]::IsNullOrWhiteSpace($readyPath)) { throw 'helper_ready_path_missing' }
Show-UpdateProgress 'Preparing update. Waiting for N.E.K.O. to close...'
try { New-Item -ItemType File -Path $readyPath -Force | Out-Null } catch { Write-UpdateLog ('Update helper readiness failed: ' + $_.Exception.Message); throw }
function Resolve-SafePath([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains(':') -or $Relative.Contains('\')) { throw 'unsafe_relative_path' }
  foreach ($part in $Relative.Split('/')) { if ([string]::IsNullOrWhiteSpace($part) -or $part -eq '.' -or $part -eq '..') { throw 'unsafe_relative_path' } }
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $candidate = [IO.Path]::GetFullPath((Join-Path $rootFull ($Relative.Replace('/', [IO.Path]::DirectorySeparatorChar))))
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'path_escaped_root' }
  return $candidate
}
function Assert-HelperPath([string]$Value, [string]$Root, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Value) -or [string]::IsNullOrWhiteSpace($Root)) { throw ('helper_' + $Name + '_missing') }
  $valueFull = [IO.Path]::GetFullPath($Value)
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
  if (-not $valueFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw ('helper_' + $Name + '_outside_root') }
  return $valueFull
}
function Assert-ArchiveFiles([string]$Root, $Files) {
  foreach ($file in $Files) {
    $source = Resolve-SafePath $Root ([string]$file.path)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('missing_update_file:' + $file.path) }
    if ((Get-Item -LiteralPath $source).Length -ne [long]$file.size) { throw ('update_file_size_mismatch:' + $file.path) }
    $actual = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$file.sha256).ToLowerInvariant()) { throw ('update_file_hash_mismatch:' + $file.path) }
  }
}
function Assert-ArchiveEntries([string]$ArchivePath, [string]$Root, $Files) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $expected = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $Files) { [void]$expected.Add([string]$file.path) }
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $relative = [string]$entry.FullName
      $isDirectory = [string]::IsNullOrEmpty([string]$entry.Name)
      if ($isDirectory) { $relative = $relative.TrimEnd('/') }
      if ([string]::IsNullOrEmpty($relative)) { continue }
      [void](Resolve-SafePath $Root $relative)
      if (-not $isDirectory -and -not $expected.Remove($relative)) { throw ('unexpected_update_file:' + $relative) }
    }
  } finally {
    $archive.Dispose()
  }
  if ($expected.Count -ne 0) { throw ('missing_update_file:' + (($expected | Select-Object -First 1))) }
}
function Move-WithRetry([string]$Source, [string]$Destination) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try { Move-Item -LiteralPath $Source -Destination $Destination -Force; return } catch { $lastError = $_; Start-Sleep -Seconds 1 }
  }
  throw $lastError
}
function Copy-WithRetry([string]$Source, [string]$Destination) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try { Copy-Item -LiteralPath $Source -Destination $Destination -Force; return } catch { $lastError = $_; Start-Sleep -Seconds 1 }
  }
  throw $lastError
}
function Copy-PreservedEntries([string]$SourceRoot, [string]$DestinationRoot, $Entries) {
  foreach ($relative in $Entries) {
    $source = Resolve-SafePath $SourceRoot ([string]$relative)
    if (-not (Test-Path -LiteralPath $source)) { continue }
    $destination = Resolve-SafePath $DestinationRoot ([string]$relative)
    New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
    Copy-WithRetry $source $destination
  }
}
function Remove-WithRetry([string]$Target) {
  $lastError = $null
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try { Remove-Item -LiteralPath $Target -Force; return } catch { $lastError = $_; Start-Sleep -Seconds 1 }
  }
  throw $lastError
}
$targetDir = [IO.Path]::GetFullPath([string]$planData.targetDir).TrimEnd([IO.Path]::DirectorySeparatorChar)
$parentDir = Split-Path -Parent $targetDir
$token = [string]$planData.token
$expectedTargetDir = [IO.Path]::GetFullPath([string]$env:NEKO_PORTABLE_UPDATE_TARGET_DIR).TrimEnd([IO.Path]::DirectorySeparatorChar)
$expectedUpdateRoot = [IO.Path]::GetFullPath([string]$env:NEKO_PORTABLE_UPDATE_ROOT).TrimEnd([IO.Path]::DirectorySeparatorChar)
if ($targetDir -ne $expectedTargetDir) { throw 'helper_target_dir_changed' }
if ($token -notmatch '^[0-9A-Za-z-]+$') { throw 'helper_token_invalid' }
$planPathFull = Assert-HelperPath $Plan $expectedUpdateRoot 'plan'
$scriptPathFull = Assert-HelperPath $PSCommandPath $expectedUpdateRoot 'script'
$archivePath = Assert-HelperPath ([string]$planData.archivePath) $expectedUpdateRoot 'archive'
$logPath = Assert-HelperPath ([string]$planData.logPath) $expectedUpdateRoot 'log'
$readyPath = Assert-HelperPath ([string]$planData.readyPath) $expectedUpdateRoot 'ready'
$expectedExecutable = [string]$env:NEKO_PORTABLE_UPDATE_ENTRYPOINT
if ($expectedExecutable -ne [string]$planData.executableRelativePath) { throw 'helper_entrypoint_changed' }
if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) { throw 'helper_target_dir_missing' }
$stagingDir = Join-Path $parentDir ('.neko-update-staging-' + $token)
$backupDir = Join-Path $parentDir ('.neko-update-backup-' + $token)
$success = $false
$applicationExitTimedOut = $false
try {
  $running = Get-Process -Id ([int]$planData.currentPid) -ErrorAction SilentlyContinue
  if ($null -ne $running) { Wait-Process -Id ([int]$planData.currentPid) -Timeout 180 -ErrorAction SilentlyContinue }
  if ($null -ne (Get-Process -Id ([int]$planData.currentPid) -ErrorAction SilentlyContinue)) { $applicationExitTimedOut = $true; throw 'application_exit_timeout' }
  Start-Sleep -Seconds 2
  Show-UpdateProgress 'Extracting update files...'
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
  if (Test-Path -LiteralPath $backupDir) { Remove-Item -LiteralPath $backupDir -Recurse -Force }
  New-Item -ItemType Directory -Path $stagingDir | Out-Null
  Write-UpdateLog ('Extracting ' + $planData.archivePath)
  Assert-ArchiveEntries ([string]$planData.archivePath) $stagingDir $planData.files
  Expand-Archive -LiteralPath ([string]$planData.archivePath) -DestinationPath $stagingDir -Force
  Show-UpdateProgress 'Verifying downloaded update...'
  Assert-ArchiveFiles $stagingDir $planData.files
  if ([string]$planData.mode -eq 'full') {
      Move-WithRetry $targetDir $backupDir
      try {
        Copy-PreservedEntries $backupDir $stagingDir $planData.preserveEntries
        Move-WithRetry $stagingDir $targetDir
        Show-UpdateProgress 'Verifying installed update...'
        Assert-ArchiveFiles $targetDir $planData.postApplyVerifyFiles
        $executable = Resolve-SafePath $targetDir ([string]$planData.executableRelativePath)
        Write-UpdateLog ('Starting updated application ' + $executable)
        Start-Process -FilePath $executable -WorkingDirectory $targetDir
        $success = $true
        Write-UpdateLog ('Update completed: ' + $planData.targetVersion)
      } catch {
        if (Test-Path -LiteralPath $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction SilentlyContinue }
        if (Test-Path -LiteralPath $backupDir) { Move-WithRetry $backupDir $targetDir }
        throw
      }
  } else {
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    $applied = New-Object System.Collections.ArrayList
    try {
      Show-UpdateProgress 'Applying differential update...'
      foreach ($file in $planData.files) {
        $source = Resolve-SafePath $stagingDir ([string]$file.path)
        $target = Resolve-SafePath $targetDir ([string]$file.path)
        $backup = Resolve-SafePath $backupDir ([string]$file.path)
        $existed = Test-Path -LiteralPath $target -PathType Leaf
        if ($existed -and (Get-Item -LiteralPath $target).Length -eq [long]$file.size) {
          $currentHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
          if ($currentHash -eq ([string]$file.sha256).ToLowerInvariant()) { continue }
        }
        if ($existed) { New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null; Copy-WithRetry $target $backup }
        New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
        [void]$applied.Add([pscustomobject]@{ path = [string]$file.path; existed = $existed })
        Copy-WithRetry $source $target
      }
      foreach ($relative in $planData.delete) {
        $target = Resolve-SafePath $targetDir ([string]$relative)
        if (Test-Path -LiteralPath $target -PathType Leaf) {
          $backup = Resolve-SafePath $backupDir ([string]$relative)
          New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
          Copy-WithRetry $target $backup
          [void]$applied.Add([pscustomobject]@{ path = [string]$relative; existed = $true })
          Remove-WithRetry $target
        }
      }
      Show-UpdateProgress 'Verifying installed update...'
      Assert-ArchiveFiles $targetDir $planData.postApplyVerifyFiles
      $executable = Resolve-SafePath $targetDir ([string]$planData.executableRelativePath)
      Write-UpdateLog ('Starting updated application ' + $executable)
      Start-Process -FilePath $executable -WorkingDirectory $targetDir
      $success = $true
      Write-UpdateLog ('Update completed: ' + $planData.targetVersion)
  } catch {
      for ($index = $applied.Count - 1; $index -ge 0; $index--) {
        $item = $applied[$index]
        $target = Resolve-SafePath $targetDir ([string]$item.path)
        $backup = Resolve-SafePath $backupDir ([string]$item.path)
        if (Test-Path -LiteralPath $backup -PathType Leaf) { New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null; Copy-WithRetry $backup $target }
        elseif (-not $item.existed -and (Test-Path -LiteralPath $target -PathType Leaf)) { Remove-WithRetry $target }
      }
      throw
    }
  }
} catch {
  Write-UpdateLog ('Update failed: ' + $_.Exception.Message)
  Show-UpdateProgress 'Update failed. Restoring the previous version...'
  try {
    if (-not (Test-Path -LiteralPath $targetDir) -and (Test-Path -LiteralPath $backupDir)) { Move-WithRetry $backupDir $targetDir }
    $oldExecutable = Resolve-SafePath $targetDir ([string]$planData.executableRelativePath)
    if (-not $applicationExitTimedOut -and (Test-Path -LiteralPath $oldExecutable -PathType Leaf)) { Start-Process -FilePath $oldExecutable -WorkingDirectory $targetDir }
  } catch { Write-UpdateLog ('Rollback/restart failed: ' + $_.Exception.Message) }
  Start-Sleep -Seconds 3
} finally {
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($success -and (Test-Path -LiteralPath $backupDir)) { Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue }
  if ($success) { Remove-Item -LiteralPath ([string]$planData.archivePath) -Force -ErrorAction SilentlyContinue }
  Close-UpdateProgress
}
if (-not $success) { exit 1 }
`;
}

function buildUpdaterLauncherCmd(scriptPath, planPath) {
  const quote = (value) => `"${String(value)}"`;
  return [
    '@echo off',
    `start "" /b powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ${quote(scriptPath)} -Plan ${quote(planPath)}`,
    'exit /b 0',
    '',
  ].join('\r\n');
}

function createPortableUpdater(context = {}) {
  const app = context.app;
  const processRef = context.process || process;
  const fsRef = context.fs || fs;
  const httpRef = context.http || http;
  const httpsRef = context.https || https;
  const electronNetTransport = createElectronNetTransport(context.net);
  const spawnRef = context.spawn || spawn;
  const testReleaseRepository = String(context.testReleaseRepository || '').trim() || null;
  const releaseRepository = normalizeReleaseRepository(context.releaseRepository, testReleaseRepository)
    || DEFAULT_RELEASE_REPOSITORY;
  const updateServiceBaseUrl = context.updateServiceBaseUrl || null;
  const quit = context.quit || (() => app.quit());
  const writeLog = (...args) => { try { context.log?.(...args); } catch (_) {} };
  try { prunePortableUpdateCache(app?.getPath?.('userData'), fsRef); } catch (_) {}

  async function resolve(release, currentVersion, latestVersion) {
    const target = resolvePortableTarget(processRef, fsRef);
    if (!target) return null;
    const manifest = await requestPortableManifest(release, latestVersion, {
      https: httpsRef,
      http: httpRef,
      transport: electronNetTransport,
      userAgent: `N.E.K.O/${currentVersion}`,
      target,
      releaseRepository,
      updateServiceBaseUrl,
      testReleaseRepository,
    });
    if (!manifest) return null;
    return {
      manifest,
      package: selectPortablePackage(
        manifest,
        release,
        currentVersion,
        releaseRepository,
        updateServiceBaseUrl,
        testReleaseRepository,
      ),
      target,
    };
  }

  async function downloadAndApply(resolved, options = {}) {
    const packageInfo = resolved.package;
    const targetVersion = resolved.manifest.version;
    const target = resolved.target || resolvePortableTarget(processRef, fsRef);
    if (!target) throw new Error('portable_update_target_unavailable');
    const installedManagedFiles = getInstalledManagedFiles(target, fsRef);
    const targetManagedFiles = new Set(packageInfo.verifyFiles.map((file) => file.path));
    const unmanagedConflicts = findUnmanagedManagedConflicts(
      target.targetPath,
      installedManagedFiles,
      targetManagedFiles,
      fsRef,
      target.platform,
    );
    if (unmanagedConflicts.length > 0) {
      throw new Error(`portable_update_unmanaged_path_conflict:${unmanagedConflicts[0]}`);
    }
    const updateRoot = path.join(app.getPath('userData'), 'portable-updates', targetVersion);
    fsRef.mkdirSync(updateRoot, { recursive: true });
    const archivePath = path.join(updateRoot, packageInfo.assetName);
    try { fsRef.unlinkSync(archivePath); } catch (_) {}
    writeLog('[Update] 开始下载 Portable 更新:', packageInfo.assetName);
    try {
      await downloadFile(packageInfo.url, archivePath, {
        fs: fsRef,
        http: httpRef,
        https: httpsRef,
        transport: electronNetTransport,
        expectedSize: packageInfo.size,
        userAgent: `N.E.K.O/${app.getVersion()}`,
        onProgress: options.onProgress,
        allowUpdateServiceMirrors: packageInfo.allowUpdateServiceMirrors === true,
      });
      const actualHash = await hashFile(archivePath, fsRef);
      if (actualHash !== packageInfo.sha256) throw new Error('portable_update_archive_hash_mismatch');
    } catch (error) {
      try { fsRef.unlinkSync(archivePath); } catch (_) {}
      if (packageInfo.mode === 'delta' && packageInfo.fallbackPackage) {
        writeLog('[Update] 增量包不可用，回退全量包:', error?.message || error);
        return downloadAndApply({ ...resolved, package: packageInfo.fallbackPackage }, options);
      }
      throw error;
    }

    const targetDir = target.targetPath;
    const executableRelativePath = resolved.manifest.entrypoint || path.basename(processRef.execPath);
    const token = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const logPath = path.join(updateRoot, 'portable-update.log');
    const readyPath = path.join(updateRoot, `portable-update-ready-${token}`);
    const planPath = path.join(updateRoot, 'portable-update-plan.json');
    const scriptPath = path.join(updateRoot, processRef.platform === 'win32' ? 'apply-portable-update.ps1' : 'apply-portable-update.sh');
    const launcherPath = path.join(updateRoot, 'launch-portable-update.cmd');
    try { fsRef.unlinkSync(readyPath); } catch (_) {}
    const obsoleteManagedFiles = packageInfo.mode === 'full'
      ? [...installedManagedFiles].filter((filePath) => !targetManagedFiles.has(filePath))
      : packageInfo.delete;
    const preserveEntries = packageInfo.mode === 'full' && target.platform === 'win32'
      ? collectUnmanagedPortableEntries(
        target.targetPath,
        new Set([...installedManagedFiles, ...targetManagedFiles]),
        fsRef,
      ).filter((filePath) => !hasManagedPathConflict(filePath, targetManagedFiles))
      : [];
    const plan = {
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      mode: packageInfo.mode,
      token,
      currentPid: processRef.pid,
      targetDir,
      executableRelativePath,
      archivePath,
      targetVersion,
      files: packageInfo.files,
      verifyFiles: packageInfo.verifyFiles,
      postApplyVerifyFiles: packageInfo.postApplyVerifyFiles,
      delete: [...new Set([...packageInfo.delete, ...obsoleteManagedFiles])],
      preserveEntries,
      logPath,
      readyPath,
    };
    try {
      options.onStage?.({
        phase: 'installing',
        mode: packageInfo.mode,
        version: targetVersion,
      });
    } catch (_) {}
    let helperCommand;
    let helperArgs;
    if (processRef.platform === 'win32') {
      fsRef.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
      fsRef.writeFileSync(scriptPath, buildUpdaterPowerShell(), 'utf8');
      fsRef.writeFileSync(launcherPath, buildUpdaterLauncherCmd(scriptPath, planPath), 'utf8');
      helperCommand = 'cmd.exe';
      helperArgs = ['/d', '/s', '/c', launcherPath];
    } else {
      const posixPlan = {
        ...plan,
        platform: processRef.platform,
        targetPath: target.targetPath,
        entrypoint: executableRelativePath,
        targetSize: resolved.manifest.full.size,
        targetSha256: resolved.manifest.full.sha256,
        targetMode: target.targetPath && (() => { try { return fsRef.statSync(target.targetPath).mode & 0o777; } catch (_) { return 0o755; } })(),
        blockSize: resolved.manifest.full.blockSize,
        blocks: (resolved.manifest.full.blocks || []).map((block, index) => ({
          ...block,
          deltaIndex: packageInfo.blocks.find((changed) => changed.index === index)?.deltaIndex,
        })),
      };
      const helper = target.distribution === 'appimage-portable'
        ? buildAppImageUpdaterShell(posixPlan)
        : buildArchiveUpdaterShell(posixPlan);
      fsRef.writeFileSync(scriptPath, helper, { encoding: 'utf8', mode: 0o700 });
      try { fsRef.chmodSync(scriptPath, 0o700); } catch (_) {}
      helperCommand = '/bin/sh';
      helperArgs = [scriptPath];
    }
    const child = spawnRef(helperCommand, helperArgs, {
      cwd: updateRoot,
      detached: true,
      windowsHide: processRef.platform === 'win32',
      stdio: 'ignore',
      env: {
        ...(processRef.env || process.env),
        NEKO_PORTABLE_UPDATE_TARGET_DIR: targetDir,
        NEKO_PORTABLE_UPDATE_ROOT: updateRoot,
        NEKO_PORTABLE_UPDATE_ENTRYPOINT: executableRelativePath,
      },
    });
    await waitForChildSpawn(child);
    await waitForHelperReady(readyPath, { fsRef });
    child.unref?.();
    writeLog('[Update] Portable 更新已就绪，正在退出并交给辅助程序应用');
    quit();
    return { launched: true, mode: packageInfo.mode, archivePath };
  }

  return { downloadAndApply, resolve };
}

module.exports = {
  DISTRIBUTION_MARKER_NAME,
  buildUpdaterLauncherCmd,
  buildUpdaterPowerShell,
  createPortableUpdater,
  createElectronNetTransport,
  downloadFile,
  findPortableManifestAsset,
  findUnmanagedManagedConflicts,
  getDistributionMarker,
  getInstalledManagedFiles,
  getTargetKey,
  isAllowedReleaseAssetUrl,
  isSafeRelativePath,
  collectUnmanagedPortableEntries,
  normalizeArch,
  prunePortableUpdateCache,
  requestBuffer,
  resolvePortableTarget,
  requestPortableManifest,
  selectPortablePackage,
  validatePortableManifest,
  waitForChildSpawn,
  waitForHelperReady,
};
