# dsh-worktree-env

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![npm](https://img.shields.io/npm/v/dsh-worktree-env)](https://www.npmjs.com/package/dsh-worktree-env) [![npm downloads](https://img.shields.io/npm/dm/dsh-worktree-env?style=flat-square&color=orange)](https://www.npmjs.com/package/dsh-worktree-env) [![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/leezhian/dsh-worktree-env)

[English](README.md) | 简体中文

DeepSeek Harness (DSH) 原生 Worktree 增强插件，在 DSH 内置 Git 工作树能力之上补齐本地环境编排与全生命周期管理。

## 核心功能

- **本地环境编排**：读取项目内 `.agents/environments/*.toml`（与 DSH 内置 `.agents/worktrees` 同目录，与 `.codex/` 完全隔离），支持分平台 `[setup]` / `[cleanup]` 脚本（默认 / macOS / Linux / Windows）、实时 SSE 日志流、POSIX 环境变量差集自动捕获。
- **快捷操作（Actions）**：支持自定义名称、图标（工具 / 运行 / 调试 / 测试）、多行脚本与平台过滤，直接显示在**会话顶部栏**一键执行——优先拉起 DSH 原生交互终端运行，未启用原生终端时自动降级到右侧面板日志页签（或悬浮日志抽屉）。
- **带改动转入 & 三方回流**：无损打包暂存/未暂存/未跟踪改动转入新 worktree（可选 `git fetch`），支持 `git apply --3way` 冲突预检、目标分支选择/新建分支与源目录未提交保护。
- **无损快照归档与自动恢复**：归档或自动清理前自动写入隐藏 Git 快照（`refs/dsh-worktree-env/snapshots/…`），拦截嵌套仓库与已初始化子模块，重开已归档会话时在输入框上方呈现仅属于该会话的悬浮**恢复工作树**横幅，一键恢复未提交改动并按配置重跑 setup（恢复后清理已消费快照引用）。
- **设置与托管工作树**：工作树项目内相对目录（默认 `.agents/worktrees`）直接同步官方内置 `@deepseek-ai/dsh-experimental-worktree`，按 `keepCount` 自动清理旧 worktree（保护已置顶与进行中的会话），且仅扫描 DSH 创建的工作树。
- **实时多语言界面**：无缝接入 DSH 语言服务，随系统设置实时切换全部 8 种内置语言（中文、English、日本語、Español、Français、Deutsch、Русский、Português）。
- **原生集成**：6 个 Agent 工具、`systemPrompt` 上下文、`shellEnv` 环境变量注入、侧边栏全局 **Worktrees** 面板（设置 & 环境）、会话顶部栏快捷操作、会话级悬浮**恢复工作树**横幅（`conversation.input.dock`）、会话右键弹窗（带改动转入 Worktree 弹窗、选分支应用回主目录弹窗、恢复工作树）。

## 环境配置（`.agents/environments/environment.toml`）

```toml
version = 1
name = "my-app"

[setup]
script = """
npm install
"""

[setup.darwin]
script = """
pnpm install
"""

[cleanup]
script = """
docker compose down --remove-orphans || true
"""

[[actions]]
name = "dev"
icon = "run"
command = "npm run dev"
```

也可以通过仓库级 Git 配置指定自定义路径（或设为 `__none__` 禁用）：

```bash
git config --local dsh.localEnvironmentConfigPath .agents/environments/custom.toml
# 禁用：
git config --local dsh.localEnvironmentConfigPath __none__
```

## 安装与本地开发

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-worktree-env

# 或直接从 GitHub 安装
dsh plugin --profile web add github:leezhian/dsh-worktree-env

# 运行全部单元测试（零第三方依赖）
node --test tests/*.test.js

# 叠加到本地 DSH Web profile 调试
dsh web --patch ./cordis.patch.yml

# 从本地源码目录安装
dsh plugin --profile web add .
```

## 文档

- 插件详情说明：[docs/DETAIL.zh.md](docs/DETAIL.zh.md) | [docs/DETAIL.md](docs/DETAIL.md)
- 设计与架构调研：[docs/chatgpt-worktree-research.md](docs/chatgpt-worktree-research.md)
