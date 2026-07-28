# Electron Portable Update Test

这是一个快速验证 N.E.K.O Portable 更新链路的独立 Windows 测试项目。它的界面和后端很小：Electron 页面会显示版本与色彩主题，并启动一个 FastAPI `/api/status` 服务；升级至新版本后，版本号、主题颜色和文字会明显变化。

更新部分不是重新实现：以下文件逐字复制自 `D:\xxynet\N.E.K.O.-PC`，可以用 `npm run check:updater-parity` 验证哈希一致。

- `src/main/portable-update.js`：manifest 校验、全量/差分选择、下载、SHA-256 校验、Windows PowerShell 原子应用与回滚。
- `src/main/portable-update-posix.js`：macOS/Linux 辅助应用器（保留以保证代码基线一致）。
- `src/main/update-source.js`、`src/main/update-check-service.js`：统一更新服务兼容 GitHub Release 的检查、回退与对话框逻辑。
- `scripts/create-portable-update.js`：全量 ZIP、文件级差分和 manifest 生成器。

因此这个项目有意维持 `N.E.K.O_*` 资源命名、`N.E.K.O` product、`N.E.K.O.exe` 入口及 `/v1/download/N.E.K.O/...` 路由；它验证的是现有实现，而不是抽象后的新协议。

## 准备

完整的本地 E2E 流程会直接导入相邻目录的 `N.E.K.O.-Update` 源码，因此先拉取并初始化它：

```powershell
# 在 electron-portable-update-test 的同级目录执行
git clone https://github.com/Project-N-E-K-O/N.E.K.O.-Update.git N.E.K.O.-Update

Set-Location .\N.E.K.O.-Update
uv sync --group dev
Set-Location ..\electron-portable-update-test
```

如果 `N.E.K.O.-Update` 不在同级目录，可在后面的 E2E 命令中通过 `-Python` 指定其虚拟环境里的 Python。

在项目根目录执行：

```powershell
npm install
python -m pip install -r .\backend\requirements.txt
npm run check:updater-parity
```

FastAPI 后端由 Electron 通过 `python` 启动。E2E 脚本会把 `N.E.K.O.-Update` 虚拟环境中的 Python 同时传给测试应用和本地更新服务；若单独启动测试应用，可预先设置 `PORTABLE_TEST_PYTHON`。

## 完整实际更新测试

以下流程会进行真实的文件下载、SHA-256 校验、退出、替换和重启。请只对 `dist` 下的测试构件执行，**不要**在开发目录或唯一副本上测试。

先生成一个旧版本和一个包含从旧版本开始的差分包的新版本：

```powershell
.\scripts\build-demo.ps1
```

或者手动运行：

```powershell
npm run build:portable -- --version 1.0.0 --flavor Ocean
npm run build:portable -- --version 1.0.1 --flavor Aurora --previous '.\dist\releases\1.0.0\N.E.K.O_1.0.0_win_manifest.json'
```

demo 不传 `--accent`：Ocean 使用 `#5b8cff`，Aurora 使用 `#2dd4bf`。手动传入 `--accent` 时才覆盖该默认主题色。

构建前务必关闭此前启动的 `N.E.K.O.exe`，否则 Windows 会锁定 `dxcompiler.dll` 等文件而导致重建失败。

再启动实际流程：

```powershell
.\scripts\run-e2e.ps1
```

默认会从 1.0.0 升到 1.0.1、监听 8001 端口，并使用 `..\N.E.K.O.-Update\.venv\Scripts\python.exe`。需要改变版本、端口或 Update 环境时可以显式传参：

```powershell
.\scripts\run-e2e.ps1 `
  -FromVersion 1.0.0 `
  -ToVersion 1.0.1 `
  -Port 8001 `
  -Python '..\N.E.K.O.-Update\.venv\Scripts\python.exe'
```

运行前应确认：

- `dist\stage\<FromVersion>\win-unpacked\N.E.K.O.exe` 存在；
- `dist\releases\<ToVersion>` 存在且包含 manifest 与 ZIP；
- 目标端口没有被其他服务占用；
- 所有旧的测试应用窗口和更新辅助程序均已退出。

它会：

1. 用当前 `N.E.K.O.-Update` 的 `create_app()` 启动本地更新服务，并注册 1.0.1 的真实产物。
2. 通过同样的 GitHub 兼容端点返回 Release JSON：`/v1/compat/github/N.E.K.O/stable/releases/latest`。
3. 通过同样的镜像调度下载端点返回 307：`/v1/download/N.E.K.O/stable/<version>/<asset>`；仅本地回环地址允许 HTTP。
4. 启动 1.0.0 的真实 unpacked Portable 应用。点击“检查并应用 Portable 更新”，在原版原生确认框选择更新；应用会先等待后台助手写入“已接管”标记，确认后才退出。
5. 更新器下载并验证差分 ZIP，应用退出后由 PowerShell 辅助程序替换文件并重启为 1.0.1。页面应显示 `v1.0.1`、`Aurora` 和 `#2dd4bf` 对应的主题色。

成功条件是：原 1.0.0 进程退出，应用自动重启，界面版本变为 `v1.0.1` 且主题文字为 `Aurora`。测试服务进程会在后台运行，完成后可在任务管理器结束该 Python 进程；也可以执行：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -like '*scripts\run-local-update-service.py*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

测试数据只写入 `.local-update-data/`，构建产物在 `dist/`，两者均被忽略。

## GitHub Release 实测

`.github/workflows/portable-release.yml` 复用 N.E.K.O 的 Windows Portable 发布路径：构建完整 ZIP 与 manifest，并从上一份 stable Release 下载 manifest 生成差分 ZIP。手动运行工作流或推送 `v*` tag 都会创建对应的正式 stable GitHub Release。

GitHub 实测使用显式的 Portable 测试选择器，不经过更新服务：先用较旧版本启动应用，再设置：

```powershell
$env:NEKO_PORTABLE_UPDATE_TEST_RELEASE = 'xxynet/electron-portable-update-test@stable'
```

然后检查更新。值的格式为 `<owner/repo>@<stable|nightly>`；只有已打包的 Portable 进程会接受此显式测试配置，生产默认更新路径不受影响。

## 边界

此项目故意只构建 Windows x64：这是当前最短、可见且与 N.E.K.O ZIP Portable 完全一致的路径。保留的 POSIX 更新器和生成器代码也与上游一致，但未在本项目增加 macOS/Linux 打包步骤。
