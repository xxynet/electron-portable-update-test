'use strict';

const net = require('node:net');
const DEFAULT_UPDATE_SERVICE_URL = 'https://update.project-neko.cn';
const UPDATE_SERVICE_URL_ENV = 'NEKO_UPDATE_SERVICE_URL';

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1' || normalized === '[::1]') return true;
  return net.isIP(normalized) === 4 && normalized.split('.')[0] === '127';
}

function normalizeUpdateServiceBaseUrl(value = DEFAULT_UPDATE_SERVICE_URL) {
  const raw = String(value || '').trim() || DEFAULT_UPDATE_SERVICE_URL;
  const withProtocol = raw.includes('://') ? raw : `https://${raw}`;
  const url = new URL(withProtocol);
  const isSecure = url.protocol === 'https:';
  const isLocalDebug = url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if ((!isSecure && !isLocalDebug)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new Error('update_service_url_invalid');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname === '/' ? '' : pathname}`;
}

function getConfiguredUpdateServiceBaseUrl(processRef = process) {
  const configured = processRef?.env?.[UPDATE_SERVICE_URL_ENV];
  return normalizeUpdateServiceBaseUrl(configured || DEFAULT_UPDATE_SERVICE_URL);
}

function buildUpdateServiceReleaseUrl(baseUrl, channel = 'stable') {
  const base = normalizeUpdateServiceBaseUrl(baseUrl);
  if (channel === 'nightly') {
    return `${base}/v1/compat/github/N.E.K.O/nightly/releases/tags/nightly`;
  }
  return `${base}/v1/compat/github/N.E.K.O/stable/releases/latest`;
}

function isUpdateServiceDownloadUrl(value, baseUrl) {
  try {
    if (!baseUrl) return false;
    const base = new URL(normalizeUpdateServiceBaseUrl(baseUrl));
    const url = new URL(String(value || ''));
    if (url.origin !== base.origin || url.username || url.password || url.hash) return false;
    const basePath = base.pathname.replace(/\/+$/, '');
    const downloadPrefix = `${basePath}/v1/download/N.E.K.O/`;
    return url.pathname.startsWith(downloadPrefix);
  } catch (_) {
    return false;
  }
}

function isAllowedUpdateRedirectUrl(value, allowUpdateServiceMirrors = false) {
  try {
    const url = new URL(String(value || ''));
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') {
      // The signed manifest and its pinned public key authenticate assets
      // served through an explicitly enabled update-service mirror.
      return allowUpdateServiceMirrors || url.hostname === 'github.com'
        || url.hostname.endsWith('.githubusercontent.com')
        || url.hostname.endsWith('.amazonaws.com');
    }
    return allowUpdateServiceMirrors
      && url.protocol === 'http:'
      && isLoopbackHostname(url.hostname);
  } catch (_) {
    return false;
  }
}

module.exports = {
  DEFAULT_UPDATE_SERVICE_URL,
  UPDATE_SERVICE_URL_ENV,
  buildUpdateServiceReleaseUrl,
  getConfiguredUpdateServiceBaseUrl,
  isAllowedUpdateRedirectUrl,
  isLoopbackHostname,
  isUpdateServiceDownloadUrl,
  normalizeUpdateServiceBaseUrl,
};
