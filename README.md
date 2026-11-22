> **自用声明**：本仓是 [DSH-OrcaMind](https://github.com/HometownVoyager/DSH-OrcaMind) 个人工作区的自研插件独立发布仓，与 deepseek-ai 官方无关。路径按本机硬编码（Windows，工作区根 `D:\Tools\DeepSeek Harness`），不保证开箱即用；`*.local.json` 凭据文件不入库，缺失时按 README 说明重建。

# @dsh-external/dsh-desktop-notifier

DSH 桌面通知插件——对标 ZCode 的任务通知：**任务的每一种用户可感状态都弹 Windows 通知，并按状态播不同的系统提示音**。除「需要回答」外全部基于 DSH 现成事件，零源码补丁。

## 监听什么（全状态矩阵）

| 通知 | 事件 | 判定与正文 | 提示音 |
| --- | --- | --- | --- |
| 任务完成 | `session/event` → `turn/end` | `data.reason.kind === 'completed'` | Windows Notify System Generic |
| 任务完成（输出被截断） | 同上 | `reason.kind === 'max-tokens'` | 同上 |
| 任务失败 | 同上 | `reason.kind === 'error'`（**含 fetch failed 等网络错误**——模型调用抛错最终都走这条，`reason.error` 是结构化 LlmFailure），正文带 `error.message`（空则 `error.code`）摘要 | Windows Error（回退 Critical Stop） |
| 任务中止 | 同上 | `reason.kind === 'aborted'`，正文带中止原因：`手动停止 / 父会话中止 / 钩子中止·理由 / 会话已释放 / 历史导入` | Windows Exclamation |
| 任务被阻止 | 同上 | `reason.kind === 'blocked'`（本轮未开始即被钩子/策略拦截） | 同上 |
| 任务中断 | 同上 | `reason.kind === 'interrupted'`（崩溃孤儿轮在恢复时被封闭） | Windows Error 系 |
| （不通知） | 同上 | `reason.kind === 'forked'`：仅 fork 种子的记账标记，不是用户可感状态 | — |
| 等待确认 | `session/event` → `approval/asked` | 审批审计事件，正文带 `toolName` 与申请理由 | Windows Notify Email |
| 等待回答 | `user-questions/request` waterfall 旁听 | `ask_user_question` 工具把问题交给应答链的唯一通路，**没有审计事件**；监听器只通知后原样 `next()` 转发，异常全吞，不改变应答链判定 | Windows Notify Messaging |

「需要确认 / 等待回答」刻意不走 `approval/request` 的决策位本身——那是应答者的位置，观察者混进去要么短路审批链、要么白占一个 slot。确认与回答是阻塞动作，不受冷却限制、每次必弹。

## 提示音（v0.3.0）

win32 上用 PowerShell `System.Media.SoundPlayer` 播 `C:\Windows\Media` 的**系统自带 wav**（不引外部音源）。同一状态族共享一个音，按上表区分；每个音有候选链（如 Error → Critical Stop），文件缺失自动回退，全部缺失时无声。toast XML 里显式 `<audio silent="true"/>` 静音——音效只由 SoundPlayer 播一次，避免系统默认音与自播音双重响；气泡兜底路径同样播自选音。总开关 `sound: false` 可全关。

**深链已移除（v0.3.0）**：原「点击 toast 经 orcamind:// 协议跳转桌面端会话」因协议处理器指向便携自解压 exe、每次点击都要完整解压启动一个 Electron 实例（数秒级延迟），2026-10-06 应用户要求砍掉——插件不再生成 launch 属性，壳侧协议注册/解析代码已同步删除。网络类失败的自动续跑兜底由姊妹插件 `dsh-auto-continue` 承担。

## 通知通道

- **win32**：spawn `powershell.exe`，脚本经 `-EncodedCommand`（UTF-16LE base64）传入，所有可变文本走 base64 内嵌，零引号转义问题。首选 **WinRT toast**：先把 AUMID 注册进 `HKCU\SOFTWARE\Classes\AppUserModelId`（幂等写 `DisplayName` + `IconUri`），通知中心里显示的就是配置的应用名与图标（默认 OrcaMind 品牌而非「Windows PowerShell」）；toast 由系统通知宿主接管。WinRT 不可用/失败时自动退回 `NotifyIcon.ShowBalloonTip` 气泡（进程 10 秒自退，插件卸载时会清理未退的）。
- darwin / linux 分别走 `osascript` / `notify-send`；其余平台空操作。

## 配置（cordis.patch.yml 或 bundle 层的 `config:`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `onComplete` / `onMaxTokens` / `onError` / `onAborted` / `onBlocked` / `onInterrupted` | `true` | 六类轮次收尾通知各自的开关 |
| `onApproval` / `onQuestion` | `true` | 等待确认 / 等待回答的开关 |
| `notifySubagents` | `false` | 子代理会话（header 带 `parentSession` / `origin=subagent` / `delegationDepth>0`）默认不通知 |
| `minGapMs` | `3000` | 轮次类通知冷却；确认与回答不受限、每次必弹 |
| `titlePrefix` | `'DSH'` | 气泡标题前缀 |
| `toastAppName` | `'OrcaMind'` | toast 归属名（通知中心显示的应用名）；留空走无品牌气泡 |
| `toastAppId` | `'DeepSeekHarness.OrcaMind'` | AppUserModelID（与归属名一起注册）；留空跳过 toast 直接气泡 |
| `toastIconPath` | 工作区 `desktop/build/icon.png`（存在时） | toast 图标（.png/.ico 绝对路径）；留空用系统默认图标 |
| `sound` | `true` | 按状态播系统提示音（win32 SoundPlayer + C:\Windows\Media 自带 wav） |
| `debugLog` | `false` | 每次决策追加一行到 `%TEMP%\dsh-desktop-notifier.log`（排障用，超 256KB 截断） |

## 安装与验证

注册方式与 dsh-tool-gate 家族一致（bundle + `link:` 依赖）：profile 的 `package.json` 里 bundles 列表加 `@dsh-external/dsh-desktop-notifier`、dependencies 加 `link:` 条目，然后在 profile 目录 `pnpm install`。**bundle 层变化需重启 DSH 生效。**

```sh
# 构建（探测 D:\Tools\DeepSeek Harness\source，或用 DSH_CHECKOUT 覆盖）
bash scripts/build.sh
# 冒烟测试：假 ctx 驱动 apply()，真弹 8 个品牌 toast（全状态矩阵 + 分状态音效）
npm run smoke
# toast 模板检查：PowerShell 真跑生成的脚本，断言 audio silent 与 PlaySync 行随 sound 配置正确出现
npm run check:toast
# 验证组合配置
node "D:\Tools\DeepSeek Harness\source\apps\cli\lib\bin.js" web --dump-config | grep desktop-notifier
```

## 排障

- **怀疑某状态没通知**：开 `debugLog: true` 看 `%TEMP%\dsh-desktop-notifier.log`——每条 `turn/end` 的 reason.kind 都会留痕（`turn/end kind=... @ 工作区名`），配合「通知 / 冷却中丢弃 / 子代理跳过 / 插件加载」定位是没收到事件、被过滤、被冷却，还是插件压根没加载（日志里没有「插件加载」行）。
- 插件没加载：`dsh web --dump-config` 确认行在；启动日志看 `load plugin` 是否报错。
- **没有提示音**：确认 `sound` 未关、`C:\Windows\Media` 下候选 wav 至少一个存在（Notify 系两版 Windows 文件名不同，已有回退链）；系统通知助手「专注助手/勿扰」不影响 SoundPlayer 自播音。
- 监听器异常会被 Cordis 隔离并写入 debugLog，不影响 agent 运行。
