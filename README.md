# dsh-auto-task · 自动化任务构建器

DeepSeek Harness（DSH）Host 插件：给会话里的 AI 提供一个 `auto_task` 工具，把平铺的时间描述确定性编译成 DSH 定时任务并管理全生命周期，**无需手写 RRULE**。

> English quickstart: ask your DSH agent to install this bundle with
> `plugin_manager` → `install_bundle`, target = `git+https://github.com/runweok/dsh-auto-task.git#<commit>`
> (see [Install](#安装) below), then verify by running the `auto_task` tool with `{"action": "list"}`.

## 功能（五个 action）

| action | 作用 |
|---|---|
| `create` | 批量创建任务（1–10 条/次，逐条返回成败），`when` 规则六选一：once / daily / weekly / every / cron / after |
| `plan` | 只编译校验并返回将要提交的请求，不创建（拿不准时先与用户确认） |
| `list` | 列出全部任务（可按 active 过滤），含规则、状态、下次触发时刻、最近投递 |
| `edit` | 按 id 批量修改：title / prompt / **when（同样无需 RRULE）** / target / active（暂停恢复）/ remove（删除），支持 `expectedUpdatedAt` 乐观锁 |
| `cleanup` | 一键删除全部已结束（ended）任务 |

`when` 示例：

```jsonc
{ "freq": "daily",   "time": "17:30" }
{ "freq": "weekly",  "weekdays": ["周一", "周三", 5], "time": "10:00" }
{ "freq": "once",    "date": "2026-11-12", "time": "09:00" }
{ "freq": "every",   "minutes": 30 }
{ "freq": "after",   "minutes": 10 }
{ "freq": "cron",    "expression": "*/15 9-17 * * 1-5" }
```

时区缺省 `Asia/Shanghai`；星期支持 1–7（周一=1）、「周一」…「周日」、mon..sun。

## 安装

### 前提

- 桌面版 DSH `>=0.2.1-rc.2, <0.3.0`（`engines.dsh` 已声明，安装时自动校验）
- 当前 preset 挂载了 `schedule` 服务（桌面 standard / cordis / ptc 预设都挂载；minimal 不挂）

### 方式一：从 npm 安装（推荐）

对本机 DSH 里的 AI 说（或自己在会话里让 agent 执行）：

> 用 plugin_manager 的 install_bundle 安装插件，target 给 `dsh-auto-task@1.0.0`

返回 `application: applied` 即生效，无需重启。验证：让 AI 调 `auto_task` 的 `{"action": "list"}`。

包页面：https://www.npmjs.com/package/dsh-auto-task

### 方式二：从 GitHub 直接安装

对本机 DSH 里的 AI 说（或自己在会话里让 agent 执行）：

> 用 plugin_manager 的 install_bundle 安装插件，target 给
> `git+https://github.com/runweok/dsh-auto-task.git#<commit>`
> （commit 用仓库最新一次提交的 SHA）

返回 `application: applied` 即生效，无需重启。验证：让 AI 调 `auto_task` 的 `{"action": "list"}`。

### 方式三：克隆后从本地目录安装

```bash
git clone https://github.com/runweok/dsh-auto-task.git
```

然后同样用 `install_bundle`，target 给克隆出来的目录绝对路径（**装好后目录别移动/删除**，安装是目录链接）。

### 方式四：插件市场（订阅本仓库索引）

在 DSH 设置的插件市场索引源里添加：

```
https://raw.githubusercontent.com/runweok/dsh-auto-task/main/index.json
```

之后在插件市场页搜索 "auto task" 或「自动化任务构建器」即可一键安装与更新。

### 更新

GitHub 有新版本后：重新执行方式一（换新 commit），或市场订阅的情况下在市场页更新；本地目录安装则 `git pull` 后 `remove_bundle` + `install_bundle` 重装一次。

## 从源码发布你自己的索引

`index.json` 是 [format-1 插件市场索引](https://github.com/runweok/dsh-auto-task)（官方 `@deepseek-ai/dsh-plugin-market-index` 校验器格式）。fork 后改 `plugins[0]` 的元数据和 `versions[].source.commit`（40 位 commit SHA），把 raw URL 分享给他人即可让他们订阅你的分发。

## 设计说明

- **零依赖、零静态导入**：只用运行时 `ctx`（tools / schedule 服务），不 import 任何 `@deepseek-ai/*` 包，macOS / Windows 行为一致，安装不需要额外下载任何依赖。
- 时间规则编译目标为 schedule 服务的管理 selector（`{kind, <selector>}` 精确键），出错逐条返回结构化错误码（`invalid_rule` / `not_future` / `schedule_conflict` 等）。
- 委派的子代理拒绝调用（与 DSH 内置 schedule 工具同口径）；只有用户明确要求时才创建/修改定时任务。

## License

[MIT](LICENSE)
