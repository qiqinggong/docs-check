# 开发与发行

源码与已安装版本分开维护。发行流程先完成本地候选包预检，再从版本标签构建单一最终包，完成矩阵验证并准备草稿 Release。正式命令切换、消费验收及公开发布按实际授权范围执行，消费项目记录和环境记录最后另行授权更新。

## 源码验证

```sh
npm ci --ignore-scripts
npm test
node cli.mjs --root .
```

构建前提交需要包含的源码和说明。构建器拒绝未提交的可见修改，并记录源码提交和源锁文件摘要；忽略的构建缓存、产物和本机报告不进入 Git。

## 候选包

```sh
npm run pack:release
npm run verify:package -- dist/docs-check-0.2.0.tgz --report-dir .local/preflight
```

验证既有发行包时，在对应版本标签或源码提交的独立检出目录中运行。预检会核对包内 `BUILD.json` 的 `sourceCommit` 与当前 `HEAD`，后续文档提交也会使两者不同。

构建器在独立临时目录从 `package-lock.json` 运行 `npm ci --ignore-scripts`，生成 shrinkwrap 与 `BUILD.json`，使用 bundleDependencies 携带运行依赖。输出包含 `.tgz`、`SHA256SUMS` 和构建摘要。已有同名输出时失败，复验可用 `--out-dir` 指定新目录，不覆盖已有验收包。

缓存默认在源码目录 `.local/npm-cache`，可用 `DOCS_CHECK_NPM_CACHE` 指定其他缓存。它只供构建和安装使用，文档检查不接触 npm。

预检在临时 prefix 和空 npm 缓存下离线安装，核对构建信息、实际引擎版本、入口隔离，再显式调用安装后的 CLI 运行全部回归。报告保存在 `--report-dir`，临时安装在验证结束后清理。

预检还核对未知入口保护、坏校验拒绝和已安装版本的失败恢复。独立运行安装入口回归可使用：

```sh
DOCS_CHECK_TEST_ENTRY=/path/to/prefix/lib/node_modules/docs-check/cli.mjs node --test test/cli.test.mjs
```

本地预检的运行环境、源码提交、锁文件摘要、包摘要、报告及未覆盖项一并交人工验收。不能用旧名包或源码入口的通过替代本次产物结果。

## GitHub 工作流

普通提交执行源码回归。发行工作流从 `v<版本>` 标签构建单一最终包，macOS/Linux 和 Node 22/24 矩阵安装并验证同一个包。最终包至少一次完成空缓存离线安装和产物回归。

发行作业只生成草稿 Release，上传已经验证的 `.tgz` 和 `SHA256SUMS`，不自动公开发布。使用同仓库工作流认证，构建读取内容，发行作业仅增加所需的内容写权限。

标签应指向已审查的公开提交；本地候选与 CI 重建摘要不同，须对最终包重新验收。草稿准备完成后核对工作流、版本、附件及摘要，再按实际授权范围继续。

## 公开内容与版本

`main` 保持可公开源码、通用样例和文档，内部原始审查分支不推送或合并进公开历史。本机报告与消费项目资料归档在 Git 之外。

`0.2.x` 维护兼容修复和安装改进，改变配置、CLI、JSON 或退出码兼容性的版本提升次版本。依赖修复可能改变诊断，发行说明应记录并复核消费影响。同一个已经公开发行的版本不替换标签或附件。

自有代码采用 MIT；第三方包的原有许可随依赖保留。当前不发布 npm registry，`private: true` 只用于防止 npm 发布，不限制 GitHub 仓库公开。
