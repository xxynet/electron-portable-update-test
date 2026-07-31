'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const {
  createElectronNetTransport,
  createPortableUpdater,
  getDistributionMarker,
} = require('./portable-update');
const {
  buildUpdateServiceReleaseUrl,
  getConfiguredUpdateServiceBaseUrl,
} = require('./update-source');

const DEFAULT_RELEASE_API_URL = 'https://api.github.com/repos/xxynet/electron-portable-update-test/releases/latest';
const DEFAULT_RELEASES_URL_PREFIX = 'https://github.com/xxynet/electron-portable-update-test/releases/';
const DEFAULT_RELEASE_REPOSITORY = 'xxynet/electron-portable-update-test';
const ALLOWED_RELEASE_REPOSITORIES = new Set([DEFAULT_RELEASE_REPOSITORY]);
const PORTABLE_TEST_RELEASE_SELECTOR = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(stable|nightly)$/;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEVELOPMENT_DOWNLOAD_SIMULATION_MS = 10000;
const DEVELOPMENT_DOWNLOAD_SIMULATION_STEPS = 20;
const DEVELOPMENT_DOWNLOAD_SIMULATION_BYTES = 10 * 1024 * 1024;
const PORTABLE_UPDATE_STATE_FILE = 'portable-update-state.json';

function normalizeVersion(value) {
  const raw = String(value || '').trim().replace(/^v/i, '');
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrereleaseIdentifiers(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (typeof left[index] === 'undefined') return -1;
    if (typeof right[index] === 'undefined') return 1;
    if (left[index] === right[index]) continue;

    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) {
      return Number(left[index]) > Number(right[index]) ? 1 : -1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

function compareVersions(leftValue, rightValue) {
  const left = normalizeVersion(leftValue);
  const right = normalizeVersion(rightValue);
  if (!left || !right) return null;

  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease);
}

function detectDistributionMode(app, processRef = process) {
  if (!app || app.isPackaged !== true) return 'development';
  const env = processRef?.env || {};
  if (env.SteamAppId || env.SteamGameId) return 'steam';
  if (env.PORTABLE_EXECUTABLE_FILE || env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  if (processRef?.platform === 'linux' && env.APPIMAGE) return 'portable';
  if (getDistributionMarker(processRef?.resourcesPath)?.distribution === 'archive-portable') return 'portable';
  if (processRef?.platform === 'win32' && processRef?.execPath && processRef?.resourcesPath) {
    const executableDir = path.dirname(path.resolve(processRef.execPath));
    const resourcesDir = path.resolve(processRef.resourcesPath);
    const appAsarPath = path.join(resourcesDir, 'app.asar');
    const normalizedExecutableDir = executableDir.toLowerCase();
    const installedRoots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean)
      .map((value) => path.resolve(value).toLowerCase());
    const isCommonInstallLocation = installedRoots.some((root) => (
      normalizedExecutableDir === root || normalizedExecutableDir.startsWith(`${root}${path.sep}`)
    ));
    const isSquirrelInstall = !!env.LOCALAPPDATA && /^app-[^\\/]+$/i.test(path.basename(executableDir))
      && path.dirname(executableDir).toLowerCase() !== path.resolve(env.LOCALAPPDATA).toLowerCase();
    if (path.dirname(resourcesDir) === executableDir && fs.existsSync(appAsarPath)
      && !isCommonInstallLocation && !isSquirrelInstall) {
      return 'portable';
    }
  }
  return 'installed';
}

function getNightlyTestReleaseConfig(app, processRef = process) {
  if (app?.isPackaged !== true || detectDistributionMode(app, processRef) !== 'portable') return null;
  let repository = '';
  let channel = '';
  let bundledTestBuild = false;
  const resourcesPath = String(processRef?.resourcesPath || '').trim();
  if (resourcesPath) {
    try {
      const bundledConfig = JSON.parse(fs.readFileSync(path.join(resourcesPath, 'core_config.txt'), 'utf8'));
      if (bundledConfig?.portableUpdateTestBuild === true) {
        bundledTestBuild = true;
        repository = String(bundledConfig.portableUpdateTestRepository || '').trim();
        channel = String(bundledConfig.portableUpdateTestChannel || '').trim();
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
          || !['stable', 'nightly'].includes(channel)) return null;
      }
    } catch (_) {
      // Fall back to the legacy environment variable below.
    }
  }
  if (!repository) {
    const selector = String(processRef?.env?.NEKO_PORTABLE_UPDATE_TEST_RELEASE || '').trim();
    const match = selector.match(PORTABLE_TEST_RELEASE_SELECTOR);
    if (!match) return null;
    [, repository, channel] = match;
  }
  const isOfficialRepository = ALLOWED_RELEASE_REPOSITORIES.has(repository);
  const isBundledTestRepository = bundledTestBuild && repository && resourcesPath && channel
    && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository);
  if (!isOfficialRepository && !isBundledTestRepository) return null;
  const tag = channel === 'nightly' ? 'nightly' : null;
  return {
    repository,
    tag,
    channel,
    apiUrl: tag
      ? `https://api.github.com/repos/${repository}/releases/tags/${tag}`
      : `https://api.github.com/repos/${repository}/releases/latest`,
    releasesUrlPrefix: `https://github.com/${repository}/releases/`,
  };
}

function getPortableReleaseVersion(release) {
  const versions = new Set();
  for (const asset of Array.isArray(release?.assets) ? release.assets : []) {
    const match = String(asset?.name || '').match(
      /^N\.E\.K\.O_(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)_(?:win|mac_(?:x64|arm64)|linux_x64(?:_appimage)?)_manifest\.json$/,
    );
    if (match) versions.add(match[1]);
  }
  return versions.size === 1 ? [...versions][0] : null;
}

function isAllowedReleaseUrl(
  value,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  allowTestRepository = false,
  testReleaseRepository = null,
) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && (ALLOWED_RELEASE_REPOSITORIES.has(releaseRepository)
        || (allowTestRepository && releaseRepository === testReleaseRepository))
      && url.pathname.startsWith(`/${releaseRepository}/releases/`);
  } catch (_) {
    return false;
  }
}

function createUpdateCheckService(context = {}) {
  const {
    app,
    dialog,
    shell,
    http: httpRef = http,
    https,
    net,
    process: processRef = process,
    log = () => {},
    releaseApiUrl = DEFAULT_RELEASE_API_URL,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    quit,
    onStatusChange,
    showUpdateNotice,
    showUpdatePrompt,
    setTimeout: setTimeoutRef = setTimeout,
    autoCheckEnabled = true,
  } = context;

  const portableTestRelease = getNightlyTestReleaseConfig(app, processRef);
  const isNightlyTestRelease = portableTestRelease?.channel === 'nightly';
  const releaseRepository = portableTestRelease?.repository || DEFAULT_RELEASE_REPOSITORY;
  const effectiveReleaseApiUrl = portableTestRelease?.apiUrl || releaseApiUrl;
  const releasesUrlPrefix = portableTestRelease?.releasesUrlPrefix || DEFAULT_RELEASES_URL_PREFIX;
  let updateServiceBaseUrl = null;
  let updateServiceConfigurationError = null;
  try {
    updateServiceBaseUrl = getConfiguredUpdateServiceBaseUrl(processRef);
  } catch (error) {
    updateServiceConfigurationError = error;
  }
  const updateServiceChannel = isNightlyTestRelease ? 'nightly' : 'stable';
  const canUseUpdateService = !!updateServiceBaseUrl
    && !portableTestRelease;
  const updateServiceReleaseApiUrl = canUseUpdateService
    ? buildUpdateServiceReleaseUrl(updateServiceBaseUrl, updateServiceChannel)
    : null;
  const electronNetTransport = createElectronNetTransport(net);

  const portableUpdater = context.portableUpdater || createPortableUpdater({
    app,
    http: httpRef,
    https,
    net,
    process: processRef,
    log,
    quit,
    releaseRepository,
    testReleaseRepository: portableTestRelease?.repository || null,
    updateServiceBaseUrl,
  });

  let started = false;
  let checkPromise = null;
  let updatePromptPromise = null;

  function writeLog(...args) {
    try { log(...args); } catch (_) {}
  }

  if (updateServiceConfigurationError) {
    writeLog(
      '[Update] NEKO_UPDATE_SERVICE_URL 无效，统一更新服务已禁用，将直接使用 GitHub:',
      updateServiceConfigurationError?.message || updateServiceConfigurationError,
    );
  }

  function emitStatus(status) {
    if (typeof onStatusChange !== 'function') return;
    try { onStatusChange({ ...status }); } catch (_) {}
  }

  function isForcedDevelopmentCheck() {
    return app?.isPackaged !== true
      && processRef?.env?.NEKO_FORCE_UPDATE_CHECK === '1';
  }

  function isDevelopmentDownloadSimulation() {
    return isForcedDevelopmentCheck()
      && processRef?.env?.NEKO_UPDATE_TEST_DOWNLOAD === '1';
  }

  function getDevelopmentTestResolvedUpdate() {
    if (!isDevelopmentDownloadSimulation()) return null;
    return {
      package: {
        mode: 'simulation',
        size: DEVELOPMENT_DOWNLOAD_SIMULATION_BYTES,
      },
    };
  }

  async function simulateDevelopmentDownload(onProgress) {
    const stepDelayMs = DEVELOPMENT_DOWNLOAD_SIMULATION_MS / DEVELOPMENT_DOWNLOAD_SIMULATION_STEPS;
    for (let step = 1; step <= DEVELOPMENT_DOWNLOAD_SIMULATION_STEPS; step += 1) {
      await new Promise((resolve) => setTimeoutRef(resolve, stepDelayMs));
      const received = Math.floor(
        (DEVELOPMENT_DOWNLOAD_SIMULATION_BYTES * step) / DEVELOPMENT_DOWNLOAD_SIMULATION_STEPS,
      );
      onProgress({
        received,
        total: DEVELOPMENT_DOWNLOAD_SIMULATION_BYTES,
        percent: Math.floor((step * 100) / DEVELOPMENT_DOWNLOAD_SIMULATION_STEPS),
      });
    }
  }

  function shouldCheck() {
    if (processRef?.env?.NEKO_DISABLE_UPDATE_CHECK === '1') return false;
    if (isForcedDevelopmentCheck()) return true;
    const distributionMode = detectDistributionMode(app, processRef);
    return distributionMode === 'portable';
  }

  function getSkippedVersion() {
    const userData = app?.getPath?.('userData');
    if (!userData) return null;
    try {
      const state = JSON.parse(fs.readFileSync(path.join(userData, PORTABLE_UPDATE_STATE_FILE), 'utf8'));
      const key = portableTestRelease?.repository || DEFAULT_RELEASE_REPOSITORY;
      return state?.skippedVersions?.[key] || null;
    } catch (_) {
      return null;
    }
  }

  function saveSkippedVersion(version) {
    const userData = app?.getPath?.('userData');
    if (!userData) return;
    try {
      const statePath = path.join(userData, PORTABLE_UPDATE_STATE_FILE);
      let state = {};
      try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) {}
      const skippedVersions = state && typeof state.skippedVersions === 'object'
        ? state.skippedVersions
        : {};
      skippedVersions[portableTestRelease?.repository || DEFAULT_RELEASE_REPOSITORY] = version;
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(statePath, `${JSON.stringify({ skippedVersions }, null, 2)}\n`, 'utf8');
    } catch (error) {
      writeLog('[Update] 保存跳过版本失败:', error?.message || error);
    }
  }

  function getCurrentVersion() {
    if (isForcedDevelopmentCheck()) {
      const testVersion = String(processRef?.env?.NEKO_UPDATE_TEST_VERSION || '').trim();
      if (normalizeVersion(testVersion)) {
        writeLog('[Update] 开发测试模式使用模拟当前版本:', testVersion);
        return testVersion;
      }
    }
    return String(app?.getVersion?.() || '').trim();
  }

  function getDevelopmentTestRelease() {
    if (!isForcedDevelopmentCheck()) return null;
    const testVersion = String(processRef?.env?.NEKO_UPDATE_TEST_LATEST_VERSION || '').trim();
    if (!normalizeVersion(testVersion)) return null;
    writeLog('[Update] 开发测试模式使用模拟最新版本:', testVersion);
    return {
      tag_name: `v${testVersion.replace(/^v/i, '')}`,
      name: 'Development update dialog test',
      html_url: `${DEFAULT_RELEASES_URL_PREFIX}latest`,
    };
  }

  function requestRelease(urlValue, { github = false } = {}) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlValue);
      } catch (_) {
        reject(new Error('update_check_url_invalid'));
        return;
      }
      const transport = electronNetTransport || (url.protocol === 'http:' ? httpRef : https);
      if (!transport || typeof transport.get !== 'function') {
        reject(new Error(`${url.protocol === 'http:' ? 'http' : 'https'}_unavailable`));
        return;
      }

      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve(value);
      };

      const headers = {
        Accept: 'application/json',
        'User-Agent': `N.E.K.O/${app?.getVersion?.() || 'unknown'}`,
      };
      if (github) {
        headers.Accept = 'application/vnd.github+json';
        headers['X-GitHub-Api-Version'] = '2022-11-28';
      }
      const request = transport.get(urlValue, {
        headers: {
          ...headers,
        },
      }, (response) => {
        const statusCode = Number(response.statusCode || 0);
        if (statusCode !== 200) {
          if (typeof response.resume === 'function') response.resume();
          finish(new Error(`update_check_http_${statusCode || 'unknown'}`));
          return;
        }

        response.setEncoding('utf8');
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
            if (typeof response.destroy === 'function') response.destroy();
            finish(new Error('update_check_response_too_large'));
          }
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const payload = JSON.parse(body);
            if (!payload || Array.isArray(payload) || typeof payload !== 'object'
              || typeof payload.tag_name !== 'string' || !payload.tag_name.trim()) {
              finish(new Error('update_check_invalid_payload'));
              return;
            }
            finish(null, payload);
          } catch (_) {
            finish(new Error('update_check_invalid_json'));
          }
        });
        response.on('error', (error) => finish(error));
      });

      request.on('error', (error) => finish(error));
      request.setTimeout(requestTimeoutMs, () => {
        request.destroy(new Error('update_check_timeout'));
      });
    });
  }

  async function requestLatestRelease() {
    if (updateServiceReleaseApiUrl) {
      try {
        const release = await requestRelease(updateServiceReleaseApiUrl);
        writeLog('[Update] 使用统一更新服务:', updateServiceReleaseApiUrl);
        return { release, source: 'update-service' };
      } catch (error) {
        writeLog(
          '[Update] 统一更新服务不可用，回退 GitHub:',
          error?.message || error,
        );
      }
    }
    return {
      release: await requestRelease(effectiveReleaseApiUrl, { github: true }),
      source: 'github',
    };
  }

  async function resolveGitHubFallback(
    currentVersion,
    expectedVersion,
    { requireManifest = true } = {},
  ) {
    const release = await requestRelease(effectiveReleaseApiUrl, { github: true });
    const latestVersion = isNightlyTestRelease
      ? getPortableReleaseVersion(release)
      : String(release?.tag_name || '').trim().replace(/^v/i, '');
    if (!latestVersion || (expectedVersion && latestVersion !== expectedVersion)) {
      throw new Error(`update_fallback_version_mismatch:${latestVersion || '<missing>'}`);
    }
    const resolved = await portableUpdater.resolve(release, currentVersion, latestVersion);
    if (!resolved && requireManifest) throw new Error('update_fallback_manifest_missing');
    return { release, latestVersion, resolved };
  }

  function formatDownloadSize(size) {
    if (!Number.isFinite(size) || size <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = size;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return `${value.toFixed(index >= 2 ? 1 : 0)} ${units[index]}`;
  }

  function getDialogCopy(currentVersion, latestVersion, releaseName, resolved) {
    const locale = String(app?.getLocale?.() || '').toLowerCase();
    const isChinese = locale.startsWith('zh');
    const displayName = String(releaseName || '').trim();
    const isSimulation = resolved?.package?.mode === 'simulation';
    if (isChinese) {
      return {
        title: '发现 N.E.K.O 新版本',
        message: `发现新版本 ${latestVersion}`,
        detail: [
          `当前版本：${currentVersion}`,
          `最新版本：${latestVersion}`,
          displayName ? `版本说明：${displayName}` : '',
          '',
          resolved ? `更新方式：${isSimulation ? '开发模式模拟下载' : (resolved.package.mode === 'delta' ? '增量更新' : '完整包更新')}${formatDownloadSize(resolved.package.size) ? `（${formatDownloadSize(resolved.package.size)}）` : ''}` : '',
          '',
          resolved ? (isSimulation ? '是否开始模拟下载？此操作只验证托盘进度，不会下载、替换文件或退出应用。' : '是否下载并自动更新？应用将在下载完成后自动退出、更新并重新启动。') : '此版本未提供 Portable 更新清单，是否前往 GitHub 手动下载？',
        ].filter((line, index) => line || index === 3).join('\n'),
        buttons: [resolved ? '下载并更新' : '前往下载', '稍后', '跳过此版本'],
      };
    }
    return {
      title: 'N.E.K.O Update Available',
      message: `Version ${latestVersion} is available`,
      detail: [
        `Current version: ${currentVersion}`,
        `Latest version: ${latestVersion}`,
        displayName ? `Release: ${displayName}` : '',
        '',
        resolved ? `Update type: ${isSimulation ? 'development download simulation' : (resolved.package.mode === 'delta' ? 'differential' : 'full package')}${formatDownloadSize(resolved.package.size) ? ` (${formatDownloadSize(resolved.package.size)})` : ''}` : '',
        '',
        resolved ? (isSimulation ? 'Start the simulated download? This only verifies tray progress; no files are downloaded or replaced, and the app stays open.' : 'Download and install it now? The app will exit, update, and restart after downloading.') : 'No Portable update manifest is available. Open GitHub for a manual download?',
      ].filter((line, index) => line || index === 3).join('\n'),
      buttons: [resolved ? 'Download and Update' : 'Open Download Page', 'Later', 'Skip This Version'],
    };
  }

  async function showUpdateError(error) {
    const locale = String(app?.getLocale?.() || '').toLowerCase();
    const isChinese = locale.startsWith('zh');
    const payload = {
      title: isChinese ? 'Portable 更新失败' : 'Portable Update Failed',
      message: isChinese ? '更新文件下载或校验失败' : 'The update could not be downloaded or verified',
      detail: `${error?.message || error}\n${isChinese ? '你可以稍后重试，或前往 GitHub 手动下载完整便携包。' : 'Try again later or download the full Portable package from GitHub.'}`,
      primaryLabel: isChinese ? '确定' : 'OK',
    };
    if (typeof showUpdateNotice === 'function') {
      await showUpdateNotice(payload);
      return;
    }
    if (!dialog || typeof dialog.showMessageBox !== 'function') return;
    await dialog.showMessageBox({
      type: 'error',
      title: payload.title,
      message: payload.message,
      detail: payload.detail,
      buttons: [payload.primaryLabel],
      defaultId: 0,
      noLink: true,
    });
  }

  async function promptForUpdate(
    release,
    currentVersion,
    latestVersion,
    resolved,
    githubFallbackFactory = null,
  ) {
    const releaseUrl = isAllowedReleaseUrl(
      release?.html_url,
      releaseRepository,
      !!portableTestRelease,
      portableTestRelease?.repository,
    )
      ? release.html_url
      : `${releasesUrlPrefix}${isNightlyTestRelease ? 'tag/nightly' : 'latest'}`;
    const copy = getDialogCopy(currentVersion, latestVersion, release?.name, resolved);
    let accepted = false;
    if (typeof showUpdatePrompt === 'function') {
      accepted = await showUpdatePrompt({
        title: copy.title,
        message: copy.message,
        detail: copy.detail,
        primaryLabel: copy.buttons[0],
        secondaryLabel: copy.buttons[1],
        tertiaryLabel: copy.buttons[2],
      });
      if (accepted === 'tertiary') {
        saveSkippedVersion(latestVersion);
        return false;
      }
      accepted = accepted === 'primary';
    } else {
      if (!dialog || typeof dialog.showMessageBox !== 'function') return false;
      const result = await dialog.showMessageBox({
        type: 'info',
        title: copy.title,
        message: copy.message,
        detail: copy.detail,
        buttons: copy.buttons,
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result?.response === 2) {
        saveSkippedVersion(latestVersion);
        return false;
      }
      accepted = result?.response === 0;
    }
    if (!accepted) return false;
    if (resolved) {
      const baseStatus = {
        phase: 'downloading',
        version: latestVersion,
        mode: resolved.package.mode,
        received: 0,
        total: resolved.package.size,
        percent: 0,
      };
      emitStatus(baseStatus);
      try {
        const onProgress = (progress = {}) => {
          const received = Number.isFinite(progress.received) ? progress.received : 0;
          const total = Number.isFinite(progress.total) && progress.total > 0
            ? progress.total
            : baseStatus.total;
          const percent = Number.isFinite(progress.percent)
            ? Math.max(0, Math.min(100, Math.floor(progress.percent)))
            : (total > 0 ? Math.max(0, Math.min(100, Math.floor((received / total) * 100))) : null);
          emitStatus({ ...baseStatus, received, total, percent });
        };
        const onStage = (stage = {}) => {
          if (stage.phase !== 'installing') return;
          emitStatus({ ...baseStatus, phase: 'installing', received: baseStatus.total, percent: 100 });
        };
        if (isDevelopmentDownloadSimulation()) {
          writeLog('[Update] 开始开发模式模拟下载，不会修改应用文件');
          await simulateDevelopmentDownload(onProgress);
          emitStatus({ phase: 'idle' });
        } else {
          await portableUpdater.downloadAndApply(resolved, { onProgress, onStage });
          // The helper owns the remainder of the update after it asks this process to quit.
          // Keep the warning visible so no second helper can be launched during that window.
          emitStatus({ ...baseStatus, phase: 'installing', received: baseStatus.total, percent: 100 });
        }
        return true;
      } catch (error) {
        if (typeof githubFallbackFactory === 'function') {
          writeLog(
            '[Update] 统一更新服务下载失败，回退 GitHub:',
            error?.message || error,
          );
          try {
            const fallback = await githubFallbackFactory();
            const fallbackStatus = {
              ...baseStatus,
              mode: fallback.resolved.package.mode,
              total: fallback.resolved.package.size,
              received: 0,
              percent: 0,
            };
            emitStatus(fallbackStatus);
            const onFallbackProgress = (progress = {}) => {
              const received = Number.isFinite(progress.received) ? progress.received : 0;
              const total = Number.isFinite(progress.total) && progress.total > 0
                ? progress.total
                : fallbackStatus.total;
              const percent = Number.isFinite(progress.percent)
                ? Math.max(0, Math.min(100, Math.floor(progress.percent)))
                : (total > 0 ? Math.max(0, Math.min(100, Math.floor((received / total) * 100))) : null);
              emitStatus({ ...fallbackStatus, received, total, percent });
            };
            const onFallbackStage = (stage = {}) => {
              if (stage.phase !== 'installing') return;
              emitStatus({ ...fallbackStatus, phase: 'installing', received: fallbackStatus.total, percent: 100 });
            };
            await portableUpdater.downloadAndApply(fallback.resolved, {
              onProgress: onFallbackProgress,
              onStage: onFallbackStage,
            });
            emitStatus({ ...fallbackStatus, phase: 'installing', received: fallbackStatus.total, percent: 100 });
            return true;
          } catch (fallbackError) {
            emitStatus({ phase: 'idle' });
            writeLog('[Update] GitHub 回退更新失败:', fallbackError?.message || fallbackError);
            await showUpdateError(fallbackError);
            return false;
          }
        }
        emitStatus({ phase: 'idle' });
        writeLog('[Update] Portable 更新失败:', error?.message || error);
        await showUpdateError(error);
        return false;
      }
    }
    if (!shell || typeof shell.openExternal !== 'function') return false;
    await shell.openExternal(releaseUrl);
    return true;
  }

  async function checkNow(options = {}) {
    const awaitPrompt = options.awaitPrompt !== false;
    if (!checkPromise) checkPromise = (async () => {
      if (!shouldCheck()) {
        return { checked: false, reason: 'distribution_skipped' };
      }

      const currentVersion = getCurrentVersion();
      const parsedCurrent = normalizeVersion(currentVersion);
      if (!parsedCurrent || (parsedCurrent.prerelease.length > 0 && !isNightlyTestRelease)) {
        writeLog('[Update] 跳过非稳定版本检查:', currentVersion || '<missing>');
        return { checked: false, reason: 'non_stable_current_version' };
      }

      try {
        const developmentRelease = getDevelopmentTestRelease();
        const releaseResult = developmentRelease
          ? { release: developmentRelease, source: 'development' }
          : await requestLatestRelease();
        let { release } = releaseResult;
        let releaseSource = releaseResult.source;
        let latestVersion = isNightlyTestRelease
          ? getPortableReleaseVersion(release)
          : String(release?.tag_name || '').trim().replace(/^v/i, '');
        let comparison = isNightlyTestRelease
          ? (latestVersion ? (latestVersion === currentVersion ? 0 : 1) : null)
          : compareVersions(latestVersion, currentVersion);
        if (comparison === null) {
          if (releaseSource !== 'update-service') {
            throw new Error(`update_check_invalid_version:${release?.tag_name || '<missing>'}`);
          }
          writeLog('[Update] 统一更新服务版本无效，回退 GitHub:', release?.tag_name || '<missing>');
          const fallback = await resolveGitHubFallback(currentVersion, null, { requireManifest: false });
          release = fallback.release;
          latestVersion = fallback.latestVersion;
          releaseSource = 'github';
          comparison = isNightlyTestRelease
            ? (latestVersion === currentVersion ? 0 : 1)
            : compareVersions(latestVersion, currentVersion);
          if (comparison === null) {
            throw new Error(`update_check_invalid_version:${release?.tag_name || '<missing>'}`);
          }
        }
        if (comparison <= 0) {
          writeLog('[Update] 当前已是最新版本:', currentVersion);
          return { checked: true, updateAvailable: false, currentVersion, latestVersion };
        }

        if (getSkippedVersion() === latestVersion) {
          writeLog('[Update] 跳过已记录的版本:', latestVersion);
          return { checked: true, updateAvailable: false, reason: 'skipped_version', currentVersion, latestVersion };
        }

        writeLog('[Update] 发现新版本:', `${currentVersion} -> ${latestVersion}`);
        if (portableTestRelease) {
          writeLog('[Update] 使用 Portable 测试通道:', `${releaseRepository}@${portableTestRelease.channel} (${latestVersion})`);
        }
        let resolved;
        let effectiveLatestVersion = latestVersion;
        if (isForcedDevelopmentCheck()) {
          resolved = getDevelopmentTestResolvedUpdate();
        } else {
          try {
            resolved = await portableUpdater.resolve(release, currentVersion, latestVersion);
          } catch (error) {
            if (releaseSource !== 'update-service') throw error;
            writeLog(
              '[Update] 统一更新服务资产不可用，回退 GitHub:',
              error?.message || error,
            );
            const fallback = await resolveGitHubFallback(
              currentVersion,
              latestVersion,
              { requireManifest: false },
            );
            release = fallback.release;
            effectiveLatestVersion = fallback.latestVersion;
            resolved = fallback.resolved;
            releaseSource = 'github';
          }
          if (!resolved && releaseSource === 'update-service') {
            writeLog('[Update] 统一更新服务缺少当前平台资产，回退 GitHub');
            const fallback = await resolveGitHubFallback(
              currentVersion,
              latestVersion,
              { requireManifest: false },
            );
            release = fallback.release;
            effectiveLatestVersion = fallback.latestVersion;
            resolved = fallback.resolved;
            releaseSource = 'github';
          }
        }
        if (!resolved) writeLog('[Update] Release 未提供 Portable 更新清单，回退到 GitHub 手动下载');
        const githubFallbackFactory = releaseSource === 'update-service' && resolved
          ? () => resolveGitHubFallback(currentVersion, effectiveLatestVersion)
          : null;
        return {
          checked: true,
          updateAvailable: true,
          currentVersion,
          latestVersion: effectiveLatestVersion,
          promptForUpdate: () => promptForUpdate(
            release,
            currentVersion,
            effectiveLatestVersion,
            resolved,
            githubFallbackFactory,
          ),
        };
      } catch (error) {
        writeLog('[Update] 检查失败:', error?.message || error);
        return { checked: false, reason: 'request_failed', error: error?.message || String(error) };
      }
    })();
    try {
      const result = await checkPromise;
      if (!result?.promptForUpdate) return result;
      const { promptForUpdate: runPrompt, ...checkResult } = result;
      if (!updatePromptPromise) {
        updatePromptPromise = Promise.resolve()
          .then(runPrompt)
          .catch((error) => {
            writeLog('[Update] 更新提示失败:', error?.message || error);
            return false;
          })
          .finally(() => {
            updatePromptPromise = null;
          });
      }
      if (!awaitPrompt) {
        return { ...checkResult, startedUpdate: false, promptPending: true };
      }
      return { ...checkResult, startedUpdate: await updatePromptPromise };
    } finally {
      checkPromise = null;
    }
  }

  function start() {
    if (started) return false;
    started = true;
    if (autoCheckEnabled !== true && !isForcedDevelopmentCheck()) {
      writeLog('[Update] 用户已关闭自动更新检查');
      return false;
    }
    if (!shouldCheck()) {
      writeLog('[Update] 当前发行模式跳过更新检查:', detectDistributionMode(app, processRef));
      return false;
    }
    void checkNow({ awaitPrompt: false });
    return true;
  }

  return {
    canCheck: shouldCheck,
    checkNow,
    detectDistributionMode: () => detectDistributionMode(app, processRef),
    start,
  };
}

module.exports = {
  compareVersions,
  createUpdateCheckService,
  detectDistributionMode,
  getNightlyTestReleaseConfig,
  getPortableReleaseVersion,
  isAllowedReleaseUrl,
  normalizeVersion,
};
