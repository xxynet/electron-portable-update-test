'use strict';

async function refresh() {
  const info = await window.portableTest.buildInfo();
  document.querySelector('#version').textContent = `v${info.appVersion}`;
  document.querySelector('#flavor').textContent = info.flavor;
  document.documentElement.style.setProperty('--accent', info.accent || '#5b8cff');
  const backend = await window.portableTest.backendStatus();
  document.querySelector('#backend').textContent = `${backend.backend || 'Unavailable'} · ${backend.version || ''}`;
}

document.querySelector('#check-update').addEventListener('click', async () => {
  const target = document.querySelector('#update-status');
  target.textContent = '正在检查…';
  const result = await window.portableTest.checkUpdate();
  target.textContent = result.updateAvailable ? `发现 v${result.latestVersion}` : (result.reason || '已是最新');
});

window.portableTest.onUpdateStatus((status) => {
  const progress = Number.isFinite(status.percent) ? ` ${status.percent}%` : '';
  document.querySelector('#update-status').textContent = `${status.phase || 'idle'}${progress}`;
});

void refresh();
