# Electron Portable Update Test

这是一个快速验证 N.E.K.O Portable 更新链路的独立 Windows 测试项目。它的界面和后端很小：Electron 页面会显示版本与色彩主题，并启动一个 FastAPI `/api/status` 服务；升级至新版本后，版本号、主题颜色和文字会明显变化。

更新部分不是重新实现：以下文件逐字复制自 `D:\xxynet\N.E.K.O.-PC`，可以用 `npm run check:updater-parity` 验证哈希一致。

- `src/main/portable-update.js`：manifest 校验、全量/差分选择、下载、SHA-256 校验、Windows PowerShell 原子应用与回滚。
- `src/main/portable-update-posix.js`：macOS/Linux 辅助应用器（保留以保证代码基线一致）。
- `src/main/update-source.js`、`src/main/update-check-service.js`：统一更新服务兼容 GitHub Release 的检查、回退与对话框逻辑。
- `scripts/create-portable-update.js`：全量 ZIP、文件级差分和 manifest 生成器。

因此这个项目有意维持 `N.E.K.O_*` 资源命名、`N.E.K.O` product、`N.E.K.O.exe` 入口及 `/v1/download/N.E.K.O/...` 路由；它验证的是现有实现，而不是抽象后的新协议。

## 准备

在项目根目录执行：

```powershell
npm install
python -m pip install -r .\backend\requirements.txt
npm run check:updater-parity
```

FastAPI 后端由 Electron 通过 `python` 启动。若希望指定解释器，可以在启动应用前设置 `PORTABLE_TEST_PYTHON`。本地更新服务使用 `N.E.K.O.-Update` 的虚拟环境，所以该仓库也需要已安装依赖。

## 完整实际更新测试

先生成一个旧版本和一个包含从旧版本开始的差分包的新版本：

```powershell
.\scripts\build-demo.ps1
```

或者手动运行：

```powershell
npm run build:portable -- --version 1.0.0 --flavor 'Ocean / 初始版本' --accent '#38bdf8'
npm run build:portable -- --version 1.0.1 --flavor 'Aurora / 更新后版本' --accent '#a3e635' --previous '.\dist\releases\1.0.0\N.E.K.O_1.0.0_win_manifest.json'
```

再启动实际流程：

```powershell
.\scripts\run-e2e.ps1
```

它会：

1. 用当前 `N.E.K.O.-Update` 的 `create_app()` 启动本地更新服务，并注册 1.0.1 的真实产物。
2. 通过同样的 GitHub 兼容端点返回 Release JSON：`/v1/compat/github/N.E.K.O/stable/releases/latest`。
3. 通过同样的镜像调度下载端点返回 307：`/v1/download/N.E.K.O/stable/<version>/<asset>`；仅本地回环地址允许 HTTP。
4. 启动 1.0.0 的真实 unpacked Portable 应用。点击“检查并应用 Portable 更新”，在原版原生确认框选择更新；应用会先等待后台助手写入“已接管”标记，确认后才退出。
5. 更新器下载并验证差分 ZIP，应用退出后由 PowerShell 辅助程序替换文件并重启为 1.0.1。页面变为 Aurora 主题。

测试服务进程会在后台运行；完成后可在任务管理器结束该 Python 进程。测试数据只写入 `.local-update-data/`，构建产物在 `dist/`，两者均被忽略。

## GitHub Release 实测

`.github/workflows/portable-release.yml` 复用 N.E.K.O 的 Windows Portable 发布路径：构建完整 ZIP 与 manifest，并从上一份 stable Release 下载 manifest 生成差分 ZIP。手动运行工作流或推送 `v*` tag 都会创建对应的正式 stable GitHub Release。

GitHub 实测使用固定的 stable 测试选择器，不经过更新服务：先用较旧版本启动应用，再设置：

```powershell
$env:NEKO_PORTABLE_UPDATE_TEST_RELEASE = 'xxynet/electron-portable-update-test@stable'
```

然后检查更新。该选择器只能读取上面的固定测试仓库 latest Release，不能被任意环境变量改为其他 GitHub 仓库。

## 边界

此项目故意只构建 Windows x64：这是当前最短、可见且与 N.E.K.O ZIP Portable 完全一致的路径。保留的 POSIX 更新器和生成器代码也与上游一致，但未在本项目增加 macOS/Linux 打包步骤。
