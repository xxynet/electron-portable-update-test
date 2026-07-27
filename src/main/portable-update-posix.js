'use strict';

const path = require('node:path');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function assertPlanPath(value) {
  const raw = String(value || '');
  if (!raw || /[\0\r\n\t]/.test(raw)) throw new Error('portable_update_helper_path_invalid');
  return raw;
}

function commonShell(plan) {
  const platform = plan.platform;
  const target = assertPlanPath(plan.targetPath);
  const archive = assertPlanPath(plan.archivePath);
  const logPath = assertPlanPath(plan.logPath);
  const readyPath = assertPlanPath(plan.readyPath || `${logPath}.ready`);
  const token = String(plan.token || '').replace(/[^0-9A-Za-z-]/g, '');
  if (!token) throw new Error('portable_update_helper_token_invalid');
  return `#!/bin/sh
set -eu
target=${shellQuote(target)}
archive=${shellQuote(archive)}
log_path=${shellQuote(logPath)}
ready_path=${shellQuote(readyPath)}
token=${shellQuote(token)}
current_pid=${shellQuote(plan.currentPid)}
platform=${shellQuote(platform)}

log() {
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)
  printf '[%s] %s\\n' "$timestamp" "$1" >> "$log_path" 2>/dev/null || true
}

: > "$ready_path"

hash_file() {
  if [ "$platform" = darwin ]; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

file_size() {
  if [ "$platform" = darwin ]; then stat -f '%z' "$1"; else stat -c '%s' "$1"; fi
}

file_mode() {
  if [ "$platform" = darwin ]; then stat -f '%Lp' "$1"; else stat -c '%a' "$1"; fi
}

waited=0
while kill -0 "$current_pid" 2>/dev/null; do
  if [ "$waited" -ge 180 ]; then log 'Update failed: application_exit_timeout'; exit 1; fi
  sleep 1
  waited=$((waited + 1))
done
sleep 1
`;
}

function buildArchiveUpdaterShell(plan) {
  const files = Array.isArray(plan.files) ? plan.files : [];
  const deletes = Array.isArray(plan.delete) ? plan.delete : [];
  const targetParent = path.posix.dirname(plan.targetPath);
  const targetName = path.posix.basename(plan.targetPath);
  const staging = path.posix.join(targetParent, `.${targetName}.neko-staging-${plan.token}`);
  const backup = path.posix.join(targetParent, `.${targetName}.neko-backup-${plan.token}`);
  const expected = path.posix.join(path.posix.dirname(plan.logPath), `archive-entries-${plan.token}.txt`);
  const actual = path.posix.join(path.posix.dirname(plan.logPath), `archive-actual-${plan.token}.txt`);
  const entrypoint = assertPlanPath(plan.entrypoint);
  const filePaths = files.map((record) => assertPlanPath(record.path));

  let script = commonShell(plan);
  script += `staging=${shellQuote(staging)}
backup=${shellQuote(backup)}
expected=${shellQuote(expected)}
actual=${shellQuote(actual)}
entrypoint=${shellQuote(entrypoint)}
success=0
swapped=0

start_app() {
  if [ "$platform" = darwin ]; then
    open -n "$target"
  else
    chmod +x "$target/$entrypoint" 2>/dev/null || true
    nohup "$target/$entrypoint" >/dev/null 2>&1 &
  fi
}

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$success" -ne 1 ]; then
    log "Update failed with status $status"
    if [ "$swapped" -eq 1 ] && [ -e "$backup" ]; then
      rm -rf "$target" 2>/dev/null || true
      mv "$backup" "$target" 2>/dev/null || true
    fi
    if [ -e "$target" ]; then start_app >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$staging" 2>/dev/null || true
  if [ "$success" -eq 1 ]; then rm -rf "$backup" 2>/dev/null || true; fi
  rm -f "$expected" "$actual" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

rm -rf "$staging" "$backup"
mkdir -p "$staging"
`;

  if (plan.platform === 'darwin') {
    if (plan.mode === 'delta') script += 'ditto "$target" "$staging"\n';
  } else {
    script += 'cp -a "$target"/. "$staging"/\n';
  }

  for (const record of files) {
    script += `rm -rf "$staging"/${shellQuote(record.path)}\n`;
  }
  for (const relative of deletes) {
    script += `rm -rf "$staging"/${shellQuote(assertPlanPath(relative))}\n`;
  }

  script += ': > "$expected"\n';
  for (const relative of filePaths) {
    script += `printf '%s\\n' ${shellQuote(relative)} >> "$expected"\n`;
  }
  script += `LC_ALL=C sort -o "$expected" "$expected"
: > "$actual"
tar -tzf "$archive" | while IFS= read -r item; do
  item=$(printf '%s' "$item" | sed 's#^\\./##; s#/$##')
  [ -z "$item" ] && continue
  case "$item" in /*|*\\\\*|*:*|../*|*/../*|*/..|..) log 'unsafe_archive_path'; exit 1 ;; esac
  printf '%s\\n' "$item"
done | LC_ALL=C sort > "$actual"
cmp -s "$expected" "$actual" || { log 'archive_entries_mismatch'; exit 1; }
tar -xzf "$archive" -C "$staging"
`;

  for (const record of files) {
    const absolute = `"$staging"/${shellQuote(record.path)}`;
    if (record.type === 'symlink') {
      script += `[ -L ${absolute} ] || { log ${shellQuote(`missing_update_link:${record.path}`)}; exit 1; }
[ "$(readlink ${absolute})" = ${shellQuote(record.linkTarget)} ] || { log ${shellQuote(`update_link_target_mismatch:${record.path}`)}; exit 1; }
`;
    } else {
      const expectedMode = Number(record.mode || 0).toString(8);
      script += `[ -f ${absolute} ] || { log ${shellQuote(`missing_update_file:${record.path}`)}; exit 1; }
[ "$(file_size ${absolute})" = ${shellQuote(record.size)} ] || { log ${shellQuote(`update_file_size_mismatch:${record.path}`)}; exit 1; }
[ "$(hash_file ${absolute})" = ${shellQuote(record.sha256)} ] || { log ${shellQuote(`update_file_hash_mismatch:${record.path}`)}; exit 1; }
`;
      if (expectedMode !== '0') {
        script += `[ "$(file_mode ${absolute})" = ${shellQuote(expectedMode)} ] || chmod ${shellQuote(expectedMode)} ${absolute}
`;
      }
    }
  }

  if (plan.platform === 'darwin') {
    script += `if codesign -dv "$staging" >/dev/null 2>&1; then
  codesign --verify --deep --strict "$staging"
fi
`;
  }

  script += `mv "$target" "$backup"
swapped=1
mv "$staging" "$target"
start_app
success=1
swapped=0
log ${shellQuote(`Update completed: ${plan.targetVersion}`)}
exit 0
`;
  return script;
}

function buildAppImageUpdaterShell(plan) {
  const targetParent = path.posix.dirname(plan.targetPath);
  const targetName = path.posix.basename(plan.targetPath);
  const staging = path.posix.join(targetParent, `.${targetName}.neko-staging-${plan.token}`);
  const backup = path.posix.join(targetParent, `.${targetName}.neko-backup-${plan.token}`);
  const blocks = Array.isArray(plan.blocks) ? plan.blocks : [];
  let script = commonShell(plan);
  script += `staging=${shellQuote(staging)}
backup=${shellQuote(backup)}
success=0
swapped=0

cleanup() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$success" -ne 1 ]; then
    log "Update failed with status $status"
    rm -f "$staging" 2>/dev/null || true
    if [ "$swapped" -eq 1 ] && [ -e "$backup" ]; then
      rm -f "$target" 2>/dev/null || true
      mv "$backup" "$target" 2>/dev/null || true
    fi
    if [ -f "$target" ]; then chmod +x "$target" 2>/dev/null || true; nohup "$target" >/dev/null 2>&1 & fi
  fi
  if [ "$success" -eq 1 ]; then rm -f "$backup" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

rm -f "$staging" "$backup"
`;
  if (plan.mode === 'full') {
    script += 'cp "$archive" "$staging"\n';
  } else {
    script += ': > "$staging"\n';
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const source = Number.isSafeInteger(block.deltaIndex) ? '$archive' : '$target';
      const sourceIndex = Number.isSafeInteger(block.deltaIndex) ? block.deltaIndex : index;
      script += `dd if="${source}" bs=${plan.blockSize} skip=${sourceIndex} count=1 2>/dev/null >> "$staging"\n`;
    }
  }
  script += `[ "$(file_size "$staging")" = ${shellQuote(plan.targetSize)} ] || { log 'appimage_size_mismatch'; exit 1; }
[ "$(hash_file "$staging")" = ${shellQuote(plan.targetSha256)} ] || { log 'appimage_hash_mismatch'; exit 1; }
chmod ${shellQuote(Number(plan.targetMode || 0o755).toString(8))} "$staging"
mv "$target" "$backup"
swapped=1
mv "$staging" "$target"
nohup "$target" >/dev/null 2>&1 &
success=1
swapped=0
log ${shellQuote(`Update completed: ${plan.targetVersion}`)}
exit 0
`;
  return script;
}

module.exports = {
  buildAppImageUpdaterShell,
  buildArchiveUpdaterShell,
  shellQuote,
};
