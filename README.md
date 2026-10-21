# docs-check

只读 Markdown 格式与本地链接检查工具。项目提供规则和扫描范围，工具提供固定的检查引擎组合。

当前版本为 `0.2.0` 本地候选，尚未公开发行。需要 Node.js 22+ 和 npm；本地预检记录实际运行版本，macOS/Linux 与 Node 22/24 的远端验证留待后续人工验收后执行。

## 安装与使用

从 GitHub Release 下载指定版本的 `.tgz` 和 `SHA256SUMS`，放在同一目录。在源码仓库中安装：

```sh
./install.sh dist/docs-check-0.2.0.tgz
docs-check --version
```

默认 prefix 为 `~/.local`，完整运行包安装到其 `lib/node_modules/docs-check/`，命令入口在 `bin/docs-check`。安装器核对相邻校验文件，使用离线模式安装已携带的依赖，不修改 PATH 或 Shell 配置。`~/.local/bin` 需要已在 PATH 中。

可指定临时目录预检：

```sh
./install.sh --prefix /path/to/test-prefix dist/docs-check-0.2.0.tgz
/path/to/test-prefix/bin/docs-check --version
```

没有源码仓库时，也可先自行核对 SHA-256，再使用 npm 的本地包安装：

```sh
npm install --global --prefix "$HOME/.local" --ignore-scripts --offline --no-audit --no-fund ./docs-check-0.2.0.tgz
```

已有其他来源的同名命令时，安装器明确失败，先核对再迁移；它不会替换未知入口。源码修改不会改变已安装版本。更新与回退均重新安装明确版本的发行包。

在目标项目中运行，或从其他位置指定根目录：

```sh
docs-check
docs-check --root /path/to/project --json
docs-check --list-files
docs-check --version
docs-check --help
```

检查不安装依赖、不改写项目、不自动修复，也不请求外部网页。扫描范围以目标项目配置为准。配置契约与退出码见 [配置说明](docs/configuration.md)。

## 卸载

```sh
npm uninstall --global --prefix "$HOME/.local" --ignore-scripts docs-check
```

自定义 prefix 使用同一 prefix 卸载。源码、Node.js、项目配置和本地验收记录保留。

## 开发与发行

依赖与回归在源码仓库中维护；安装包由锁文件重建，不把开发目录链接成日常命令。

```sh
npm ci --ignore-scripts
npm test
node cli.mjs --root .
```

候选构建、产物验证、CI 和发行边界见 [开发与发行](docs/releasing.md)。变更见 [变更记录](CHANGELOG.md)，自有代码采用 [MIT 许可](LICENSE)，依赖保留各自许可。
