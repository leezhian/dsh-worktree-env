# dsh-worktree-env

DeepSeek Harness (DSH) 原生 Worktree 增强插件，补齐对标 ChatGPT / Codex Worktree 的本地环境编排与全生命周期管理能力。

## 核心功能

- **本地环境编排**：读取项目内 `.agents/environments/*.toml`（与 DSH 内置 `.agents/worktrees` 同目录，支持分平台 `[setup]` / `[cleanup]` 脚本、实时日志流、POSIX 环境变量差集自动捕获）。
- **快捷 Actions**：支持自定义名称、图标（工具/运行/调试/测试）、多行脚本与平台过滤，在右侧栏一键执行。
- **带改动转入 & 三方回流**：无损打包未提交/未跟踪改动转入新 worktree（可选 `git fetch`），支持 `git apply --3way` 预检与回流主目录。
- **无损快照归档与恢复**：归档前写入隐藏 Git 快照（`refs/dsh-worktree-env/snapshots/…`），自动拦截嵌套仓库/子模块，恢复时还原未提交改动并按配置重跑 setup。
- **设置与托管工作树**：工作树相对目录直接同步官方内置 `@deepseek-ai/dsh-experimental-worktree`，按 `keepCount` 自动清理旧 worktree（保护已置顶与进行中的会话），并仅扫描 DSH 创建的工作树。
- **原生集成**：6 个 Agent 工具、`systemPrompt` 上下文、`shellEnv` 环境变量注入、`/worktree` 命令、侧边栏全局管理面板与右侧栏快捷面板。

## 本地测试与调试

```bash
# 运行全部单元测试（零第三方依赖）
node --test tests/*.test.js

# 叠加到本地 DSH Web profile 调试
dsh web --patch ./cordis.patch.yml

# 安装到指定 profile
dsh plugin --profile web add .
```

更多设计与架构说明见 [docs/chatgpt-worktree-research.md](docs/chatgpt-worktree-research.md) 与 [docs/DETAIL.md](docs/DETAIL.md)。
