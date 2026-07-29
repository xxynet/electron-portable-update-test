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
application_exit_timeout=0

log() {
  timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)
  printf '[%s] %s\\n' "$timestamp" "$1" >> "$log_path" 2>/dev/null || true
}

notify_update() {
  message=$1
  if [ "$platform" = darwin ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display notification \"$message\" with title \"N.E.K.O. Update\"" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send 'N.E.K.O. Update' "$message" >/dev/null 2>&1 || true
  fi
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
  if [ "$waited" -ge 180 ]; then application_exit_timeout=1; log 'Update failed: application_exit_timeout'; exit 1; fi
  sleep 1
  waited=$((waited + 1))
done
sleep 1
notify_update 'Installing update. N.E.K.O. will restart automatically.'
`;
}

function buildArchiveUpdaterShell(plan) {
  const files = Array.isArray(plan.files) ? plan.files : [];
  const verifyFiles = Array.isArray(plan.verifyFiles) ? plan.verifyFiles : files;
  const deletes = Array.isArray(plan.delete) ? plan.delete : [];
  const targetParent = path.posix.dirname(plan.targetPath);
  const targetName = path.posix.basename(plan.targetPath);
  const staging = path.posix.join(targetParent, `.${targetName}.neko-staging-${plan.token}`);
  const backup = path.posix.join(targetParent, `.${targetName}.neko-backup-${plan.token}`);
  const expected = path.posix.join(path.posix.dirname(plan.logPath), `archive-entries-${plan.token}.txt`);
  const actual = path.posix.join(path.posix.dirname(plan.logPath), `archive-actual-${plan.token}.txt`);
  const raw = path.posix.join(path.posix.dirname(plan.logPath), `archive-raw-${plan.token}.txt`);
  const entrypoint = assertPlanPath(plan.entrypoint);
  const filePaths = files.map((record) => assertPlanPath(record.path));

  let script = commonShell(plan);
  script += `staging=${shellQuote(staging)}
backup=${shellQuote(backup)}
expected=${shellQuote(expected)}
actual=${shellQuote(actual)}
raw=${shellQuote(raw)}
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
    notify_update 'Update failed. Restoring the previous version.'
    if [ "$swapped" -eq 1 ] && [ -e "$backup" ]; then
      rm -rf "$target" 2>/dev/null || true
      mv "$backup" "$target" 2>/dev/null || true
    fi
    if [ "$application_exit_timeout" -ne 1 ] && [ -e "$target" ]; then start_app >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$staging" 2>/dev/null || true
  if [ "$success" -eq 1 ]; then rm -rf "$backup" 2>/dev/null || true; fi
  rm -f "$expected" "$actual" "$raw" 2>/dev/null || true
  if [ "$success" -eq 1 ]; then rm -f "$archive" 2>/dev/null || true; fi
  exit "$status"
}
trap cleanup EXIT INT TERM HUP

rm -rf "$staging" "$backup"
mkdir -p "$staging"
`;

  // Linux Portable promises to retain files that are not part of the release.
  // A full archive therefore overlays a staged copy of the old tree too. For a
  // delta fallback, `delete` carries the known removals from that delta.
  if (plan.mode === 'delta' || plan.platform === 'linux') {
    if (plan.platform === 'darwin') script += 'ditto "$target" "$staging"\n';
    else script += 'cp -a "$target"/. "$staging"/\n';
  }

  script += `remove_conflicting_path() {
  relative=$1
  current="$staging"
  old_ifs=$IFS
  set -f
  IFS=/
  set -- $relative
  IFS=$old_ifs
  for part in "$@"; do
    current="$current/$part"
    if [ -L "$current" ]; then rm -f "$current"; fi
  done
  set +f
  rm -rf "$staging/$relative"
}
remove_deleted_path() {
  relative=$1
  current="$staging"
  old_ifs=$IFS
  set -f
  IFS=/
  set -- $relative
  IFS=$old_ifs
  for part in "$@"; do
    current="$current/$part"
    # Never traverse a user-provided symlink while handling a deletion.
    if [ -L "$current" ]; then set +f; return 0; fi
  done
  set +f
  # A release deletion only authorizes removal of the old managed leaf. If a
  # user replaced it with a directory, retain that directory and its contents.
  if [ -L "$staging/$relative" ] || [ -f "$staging/$relative" ]; then rm -f "$staging/$relative"; fi
}
`;
  for (const record of files) {
    script += `remove_conflicting_path ${shellQuote(record.path)}\n`;
  }
  for (const relative of deletes) {
    script += `remove_deleted_path ${shellQuote(assertPlanPath(relative))}\n`;
  }

  script += ': > "$expected"\n';
  for (const relative of filePaths) {
    script += `printf '%s\\n' ${shellQuote(relative)} >> "$expected"\n`;
  }
  script += `LC_ALL=C sort -o "$expected" "$expected"
: > "$actual"
tar -tzf "$archive" > "$raw"
while IFS= read -r item; do
  item=$(printf '%s' "$item" | sed 's#^\\./##; s#/$##')
  [ -z "$item" ] && continue
  case "$item" in /*|*\\\\*|*:*|../*|*/../*|*/..|..) log 'unsafe_archive_path'; exit 1 ;; esac
  printf '%s\\n' "$item" >> "$actual"
done < "$raw"
LC_ALL=C sort -o "$actual" "$actual"
cmp -s "$expected" "$actual" || { log 'archive_entries_mismatch'; exit 1; }
tar -xzf "$archive" -C "$staging"
`;

  for (const record of verifyFiles) {
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
    script += `target_was_signed=0
if codesign -dv "$target" >/dev/null 2>&1; then target_was_signed=1; fi
if [ "$target_was_signed" -eq 1 ]; then
  codesign --verify --deep --strict "$staging" || { log 'replacement_signature_invalid'; exit 1; }
elif codesign -dv "$staging" >/dev/null 2>&1; then
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
    notify_update 'Update failed. Restoring the previous version.'
    rm -f "$staging" 2>/dev/null || true
    if [ "$swapped" -eq 1 ] && [ -e "$backup" ]; then
      rm -f "$target" 2>/dev/null || true
      mv "$backup" "$target" 2>/dev/null || true
    fi
    if [ "$application_exit_timeout" -ne 1 ] && [ -f "$target" ]; then chmod +x "$target" 2>/dev/null || true; nohup "$target" >/dev/null 2>&1 & fi
  fi
  if [ "$success" -eq 1 ]; then rm -f "$backup" 2>/dev/null || true; fi
  if [ "$success" -eq 1 ]; then rm -f "$archive" 2>/dev/null || true; fi
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
      script += `dd if="${source}" bs=${plan.blockSize} iflag=fullblock skip=${sourceIndex} count=1 2>/dev/null >> "$staging"\n`;
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
