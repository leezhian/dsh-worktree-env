# Worktree 增强

本插件在 DSH 内置 Git 工作树能力（`create_worktree` 工具、新建会话工作树开关以及变更差异面板）之上，补齐本地环境编排与工作树全生命周期管理。它叠加在内置服务之上而不替换原有入口；即使关闭实验性工作树服务，核心功能仍可降级通过原生 Git 正常运行。

## 新增能力

- **本地环境编排**：读取项目内 `.agents/environments/*.toml`（与 DSH 的 `.agents/worktrees` 位于同一 `.agents` 目录，与 `.codex/` 隔离），支持分平台 `[setup]` / `[cleanup]` 脚本（默认 / macOS / Linux / Windows）以及可自定义图标（工具 / 运行 / 调试 / 测试）的 `[[actions]]` 快捷操作。创建工作树后可自动运行 `setup` 并实时流式输出日志，同时在 POSIX 环境下自动捕获环境变量差集供后续操作复用。
- **带未提交改动转入**：通过临时 Git 索引打包当前工作区的暂存、未暂存及未跟踪改动（不修改源目录），创建工作树并将改动无损应用到新目录后执行 `setup`；可选在创建前执行 `git fetch`（`upstreamRefreshMode: best-effort`）。
- **三方补丁回流**：支持按「分支全部改动（已提交 + 未提交）」或「仅未提交改动」生成补丁，经干跑冲突预检无误后使用 `git apply --3way` 合并回源目录，绝不静默覆盖冲突；Web UI 弹窗还支持选择目标本地分支或新建本地分支（含无副作用引用预检与源目录未提交保护）。
- **无损快照归档与自动恢复**：工作树归档、配额清理或在会话归档自动清理（受 `autoCleanupEnabled` / `snapshotOnArchive` 控制，取消归档时自动中止）前，若含未提交改动则自动写入隐藏 Git 快照引用（`refs/dsh-worktree-env/snapshots/…`），释放磁盘空间的同时随时可无损恢复；重新打开已归档会话时在输入框上方呈现仅属于该会话的悬浮**恢复工作树**横幅（`conversation.input.dock`，切换会话绝不串带；无损恢复后清理已消费的快照引用）；若目录内包含已初始化子模块或嵌套 Git 仓库会自动阻止销毁。
- **配额自动清理**：每个仓库最多保留 `keepCount`（默认 `15`）个活跃工作树，按最近访问时间自动归档旧目录，并保护已置顶会话、进行中会话及正在执行脚本的工作树。
- **Shell 环境变量注入**：在托管工作树内执行模型 Shell 命令时，自动注入 `DSH_WORKTREE_SOURCE_ROOT`、`DSH_WORKTREE_PATH`、`DSH_WORKTREE_BRANCH` 与 `DSH_WORKTREE_ENV_FILE`。
- **Agent 工具**：提供 `worktree_handoff`、`worktree_setup`、`worktree_actions`、`worktree_apply_patch`、`worktree_archive`、`worktree_restore` 共 6 个工具。
- **可视化界面与实时多语言**：提供侧边栏 **Worktrees** 面板——**设置**页签（项目内工作树相对目录并与 `@deepseek-ai/dsh-experimental-worktree` 同步、远程更新开关、自动删除旧工作树开关、保留数量、删除确认、支持手动运行 Setup 流式日志的折叠托管列表，以及支持一键恢复/彻底删除的**已归档工作树**列表）与**环境**页签（项目列表、带变量提示的只读详情预览、可视化 `.toml` 编辑器）、**会话顶部栏快捷操作**（优先在 DSH 原生交互终端中执行，未启用原生终端时自动降级到右侧面板按需日志页签或悬浮抽屉）、**会话级悬浮恢复横幅**（输入框上方 `conversation.input.dock`）以及会话右键弹窗（带改动转入 Worktree 弹窗、应用改动到主目录弹窗与恢复工作树）。全部界面文案随 DSH 语言设置实时切换。

## 配置说明

应用级设置可在 **Worktrees → 设置** 中直接修改（持久化于 `$DSH_HOME/plugins/dsh-worktree-env/config.json`）：
`worktreeDirectory`（同步至内置 `@deepseek-ai/dsh-experimental-worktree`）、`upstreamRefreshMode`、`keepCount`、`confirmBeforeDelete`，以及其他高级配置项（`autoRunSetup`、`autoRunCleanup`、`setupTimeoutMs`、`defaultCreationPreference`、`repositoryPreferences`、`snapshotOnArchive`、`autoCleanupEnabled`）。

仓库级环境配置默认存放于 `.agents/environments/*.toml`。也可通过仓库本地 Git 配置 `dsh.localEnvironmentConfigPath` 指定自定义文件路径，或设为 `__none__` 禁用该仓库的本地环境配置。

## 使用限制

- 环境变量差集自动捕获依赖 POSIX Shell（`env -0`）；在 Windows 上脚本仍会正常执行，但不会捕获环境变量差集。
- 补丁回流作用于源目录的工作区；检测到冲突时会中止操作并明确提示，不会静默覆盖。
- 快照引用保存在仓库的 Git 对象库中，只要引用未被删除，`git gc` 会一直保留快照数据。
