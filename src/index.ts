/**
 * @dsh-external/dsh-desktop-notifier —— 桌面通知插件。
 *
 * 对标 ZCode 的任务通知：任务的每一种用户可感状态都弹桌面通知。
 * DSH 侧对应物全是现成事件，无需任何源码补丁：
 *
 * - 轮次收尾：`session/event` 里 type=turn/end 的日志事件，`data.reason.kind`
 *   全集（packages/core/session/src/types.ts 的 TurnEndReasonMap）：
 *     completed  完成              → 「任务完成」
 *     max-tokens 输出被截断        → 「任务完成（输出被截断）」
 *     error      失败（含 fetch failed 等网络错误，reason.error 是结构化
 *                LlmFailure）     → 「任务失败」正文带 message/code 摘要
 *     aborted    中止（cause: user/parent/hook/disposed/legacy）
 *                                  → 「任务中止」正文带中止原因
 *     blocked    进入前被钩子/策略拦截 → 「任务被阻止」
 *     interrupted 崩溃孤儿轮在恢复时被封闭 → 「任务中断」
 *     forked     仅 fork 种子的记账标记，不是用户可感状态，刻意不通知。
 * - 需要确认：`session/event` 里 type=approval/asked 的审计事件（审批服务
 *   每次把问题交给应答链前追加，payload 带 toolName / reason）。
 *   刻意不走 `approval/request` waterfall——那是应答者的决策位，观察者
 *   插件混进去要么短路审批链、要么白占一个 slot。
 * - 需要回答：`user-questions/request` waterfall 旁听（ask_user_question
 *   工具把问题交给应答链的唯一通路，没有对应审计事件）。监听器只做
 *   通知后原样 `next()` 转发，任何异常都吞掉，不改变应答链的判定。
 *
 * 提示音（win32）：PowerShell SoundPlayer 播 C:\Windows\Media 的系统自带 wav，
 * 按状态区分——完成/截断走 Notify 系，失败/中断走 Error 系，中止/阻止走
 * Exclamation，等待确认走 Notify Email，等待回答走 Notify Messaging。toast
 * XML 里显式 `<audio silent="true"/>` 静音，避免系统默认音与自播音双重响；
 * 音效文件按候选链取第一个存在的，全部缺失时无声。气泡兜底路径同样播自选音。
 *
 * 通知通道（win32）：spawn powershell.exe，脚本经 -EncodedCommand 传入
 * （UTF-16LE base64，所有可变文本都走 base64 解码，零引号转义问题）。
 * 首选 WinRT toast：先把 AUMID 注册进 HKCU\SOFTWARE\Classes\AppUserModelId
 * （DisplayName + IconUri 幂等写入），归属名与图标即配置的 toastAppName /
 * toastIconPath，不再是「Windows PowerShell + 默认图标」；toast 由系统通知
 * 宿主接管，进程即显即退。WinRT 不可用/失败时退回 NotifyIcon 气泡兜底。
 * darwin 走 osascript，linux 走 notify-send，其余平台空操作。
 *
 * 噪音控制：
 * - 子代理会话（header 带 parentSession / origin=subagent / delegationDepth>0）
 *   默认不通知，notifySubagents 打开后才跟。
 * - 轮次类通知（完成/截断/失败/中止/阻止/中断）共享 minGapMs 冷却；
 *   确认与回答请求是阻塞动作，不受冷却限制、每次必弹。
 * - 一切异常就地吞掉 + 可选审计日志：通知插件绝不影响 agent 运行
 *   （Cordis 本身也按监听器隔离失败，这里是双保险）。
 */
import type { Context } from 'cordis'
import z from 'schemastery'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const name = '@dsh-external/dsh-desktop-notifier'

const LOG = join(tmpdir(), 'dsh-desktop-notifier.log')
const BODY_MAX = 160

/** 缺省图标：工作区 OrcaMind 壳的图标（lib/ 上跳三级到工作区根）。挪动目录或缺文件时退化为空。 */
const DEFAULT_ICON = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const candidate = join(here, '..', '..', '..', 'desktop', 'build', 'icon.png')
    return existsSync(candidate) ? candidate : ''
  } catch {
    return ''
  }
})()

export interface Config {
  /** 弹「任务完成」通知（turn/end reason=completed）。 */
  onComplete: boolean
  /** 弹「输出被截断」通知（turn/end reason=max-tokens）。 */
  onMaxTokens: boolean
  /** 弹「任务失败」通知（turn/end reason=error），正文带失败摘要。 */
  onError: boolean
  /** 弹「任务中止」通知（turn/end reason=aborted），正文带中止原因。 */
  onAborted: boolean
  /** 弹「任务被阻止」通知（turn/end reason=blocked，本轮未开始）。 */
  onBlocked: boolean
  /** 弹「任务中断」通知（turn/end reason=interrupted，崩溃孤儿轮被恢复封闭）。 */
  onInterrupted: boolean
  /** 弹「等待确认」通知（approval/asked 审计事件）。 */
  onApproval: boolean
  /** 弹「等待回答」通知（user-questions/request waterfall 旁听）。 */
  onQuestion: boolean
  /** 子代理会话是否也通知（默认只跟顶层会话）。 */
  notifySubagents: boolean
  /** 轮次类通知的最小间隔（毫秒）；确认与回答请求不受冷却限制。 */
  minGapMs: number
  /** 气泡标题前缀。 */
  titlePrefix: string
  /** toast 归属名（Windows 通知中心里显示的应用名）；留空走无品牌气泡。 */
  toastAppName: string
  /** toast 的 AppUserModelID（配合 toastAppName 注册，须含字母数字与点）；留空跳过 toast 直接气泡。 */
  toastAppId: string
  /** toast 图标（.png/.ico 绝对路径）；留空用系统默认图标。 */
  toastIconPath: string
  /** 按状态播系统提示音（win32，SoundPlayer 播 C:\Windows\Media 自带 wav）。 */
  sound: boolean
  /** 把每次决策追加到 %TEMP%\dsh-desktop-notifier.log（排障用）。 */
  debugLog: boolean
}

export const Config: z<Config> = z.object({
  onComplete: z.boolean().default(true),
  onMaxTokens: z.boolean().default(true),
  onError: z.boolean().default(true),
  onAborted: z.boolean().default(true),
  onBlocked: z.boolean().default(true),
  onInterrupted: z.boolean().default(true),
  onApproval: z.boolean().default(true),
  onQuestion: z.boolean().default(true),
  notifySubagents: z.boolean().default(false),
  minGapMs: z.number().default(3000),
  titlePrefix: z.string().default('DSH'),
  toastAppName: z.string().default('OrcaMind'),
  toastAppId: z.string().default('DeepSeekHarness.OrcaMind'),
  toastIconPath: z.string().default(DEFAULT_ICON),
  sound: z.boolean().default(true),
  debugLog: z.boolean().default(false),
})

/** 结构化类型：只取用到的字段，避免依赖 dsh-session / dsh-user-questions 类型包。 */
interface TurnEndReasonLike {
  kind?: string
  error?: { message?: string; code?: string }
  /** aborted 的取消原因：AgentCancelCause（user/parent/hook/disposed）或 legacy。 */
  reason?: { kind?: string; reason?: string }
}
interface SessionEventLike {
  type: string
  data: {
    /** turn/end 是结构化结束原因；approval/asked 是 string 说明。 */
    reason?: TurnEndReasonLike | string
    toolName?: string
  }
}
interface SessionHeaderLike {
  cwd?: string
  parentSession?: string
  origin?: string
  delegationDepth?: number
}
interface SessionLike {
  id?: string
  header?: SessionHeaderLike
}
/** user-questions/request 的请求面：questions 列表 + 可选 agent（经其拿到会话）。 */
interface QuestionRequestLike {
  questions?: Array<{ question?: string }>
  agent?: { session?: SessionLike }
}

function truncate(text: string, max = BODY_MAX): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
}

/** aborted 的 reason（AgentCancelCause）转一句人话。 */
function abortCauseText(reason: TurnEndReasonLike | undefined): string {
  const cause = typeof reason?.reason === 'object' && reason.reason !== null
    ? reason.reason
    : undefined
  switch (cause?.kind) {
    case 'user': return '手动停止'
    case 'parent': return '父会话中止'
    case 'disposed': return '会话已释放'
    case 'legacy': return '历史导入的中止'
    case 'hook':
      return cause.reason ? `钩子中止 · ${truncate(String(cause.reason), 80)}` : '钩子中止'
    default: return '已中止'
  }
}

/** error 的 LlmFailure 摘要：message 优先，退化到 code。 */
function errorText(reason: TurnEndReasonLike | undefined): string {
  const error = reason?.error
  return error?.message || error?.code || '未知错误'
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

/** 系统音效目录与按状态分的候选链：取第一个存在的文件，全部缺失则无声。 */
const MEDIA_DIR = 'C:\\Windows\\Media'
type SoundKind = 'completion' | 'failure' | 'caution' | 'attention' | 'question'
const SOUND_FILES: Record<SoundKind, string[]> = {
  completion: ['Windows Notify System Generic.wav', 'Windows Notify.wav'],
  failure: ['Windows Error.wav', 'Windows Critical Stop.wav'],
  caution: ['Windows Exclamation.wav'],
  attention: ['Windows Notify Email.wav', 'Windows Notify.wav'],
  question: ['Windows Notify Messaging.wav', 'Windows Notify.wav'],
}

/** turn/end 的 kind → 音效类；未列出的 kind（forked 等）不会产生通知。 */
function turnSoundKind(kind: string | undefined): SoundKind | undefined {
  switch (kind) {
    case 'completed':
    case 'max-tokens':
      return 'completion'
    case 'error':
    case 'interrupted':
      return 'failure'
    case 'aborted':
    case 'blocked':
      return 'caution'
    default:
      return undefined
  }
}

/**
 * Windows 通知脚本：首选 WinRT toast（AUMID 品牌化），失败退回 NotifyIcon 气泡。
 * 全部可变文本经 base64 内嵌，PowerShell 侧无引号转义；XML 文本用
 * SecurityElement.Escape 转义。toast XML 显式静音（audio silent），音效由
 * SoundPlayer 播 config 指定的系统 wav——双保险避免系统默认音与自播音叠响。
 * 导出仅供 toast-check 脚本验证模板。
 */
export function winNotifyScript(o: {
  title: string
  body: string
  appName: string
  aumid: string
  icon: string
  /** 可选音效 wav 绝对路径（C:\Windows\Media 下）；空串不播。 */
  sound: string
}): string {
  const lines = [
    `$ErrorActionPreference = 'Stop'`,
    `$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.title)}'))`,
    `$b = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.body)}'))`,
  ]
  if (o.sound !== '') {
    lines.push(`$w = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.sound)}'))`)
  }
  if (o.aumid !== '' && o.appName !== '') {
    lines.push(
      `$n = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.appName)}'))`,
      `$a = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.aumid)}'))`,
    )
    if (o.icon !== '') {
      lines.push(`$i = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(o.icon)}'))`)
    }
    lines.push(
      `try {`,
      `  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]`,
      `  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]`,
      `  $k = 'HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\' + $a`,
      `  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }`,
      `  Set-ItemProperty -Path $k -Name DisplayName -Value $n -Type String`,
    )
    if (o.icon !== '') {
      lines.push(`  Set-ItemProperty -Path $k -Name IconUri -Value $i -Type String`)
    }
    lines.push(
      `  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument`,
      `  $doc.LoadXml('<toast duration="short">' + '<visual><binding template="ToastGeneric"><text>' + [Security.SecurityElement]::Escape($t) + '</text><text>' + [Security.SecurityElement]::Escape($b) + '</text></binding></visual><audio silent="true"/></toast>')`,
      `  $toast = New-Object Windows.UI.Notifications.ToastNotification($doc)`,
      `  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($a).Show($toast)`,
    )
    if (o.sound !== '') {
      lines.push(
        `  $p = New-Object System.Media.SoundPlayer $w`,
        `  $p.PlaySync()`,
      )
    }
    lines.push(
      `  exit 0`,
      `} catch { }`,
    )
  }
  // 气泡兜底：WinRT 不可用 / AUMID 未配置 / toast 抛错时走这里。
  lines.push(
    `Add-Type -AssemblyName System.Windows.Forms`,
    `Add-Type -AssemblyName System.Drawing`,
    `$ni = New-Object System.Windows.Forms.NotifyIcon`,
    `$ni.Icon = [System.Drawing.SystemIcons]::Information`,
    `$ni.Visible = $true`,
    `$ni.ShowBalloonTip(8000, $t, $b, [System.Windows.Forms.ToolTipIcon]::Info)`,
  )
  if (o.sound !== '') {
    lines.push(
      `try { $p2 = New-Object System.Media.SoundPlayer $w; $p2.PlaySync() } catch { }`,
    )
  }
  lines.push(
    `Start-Sleep -Seconds 10`,
    `$ni.Dispose()`,
  )
  return lines.join('\n')
}

export function apply(ctx: Context, config: Config): void {
  const children = new Set<ChildProcess>()
  let lastTurnNotify = 0

  // 卸载时杀掉还在挂着的通知进程（气泡兜底路径 Start-Sleep 最长 10s）。
  ctx.effect(() => () => {
    for (const child of children) {
      try { child.kill() } catch { /* 退出路径尽力而为 */ }
    }
    children.clear()
  })

  const audit = (line: string): void => {
    if (!config.debugLog) return
    const entry = `${new Date().toISOString()} ${line}\n`
    try {
      if (statSync(LOG).size > 256 * 1024) writeFileSync(LOG, entry, 'utf8')
      else appendFileSync(LOG, entry, 'utf8')
    } catch {
      try { writeFileSync(LOG, entry, 'utf8') } catch { /* 宿主不可写时静默 */ }
    }
  }

  const notify = (title: string, body: string, sound = ''): void => {
    try {
      let child: ChildProcess
      if (process.platform === 'win32') {
        const script = winNotifyScript({
          title,
          body,
          appName: config.toastAppName,
          aumid: config.toastAppId,
          icon: config.toastIconPath,
          sound,
        })
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        child = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
        ], { stdio: 'ignore', windowsHide: true })
      } else if (process.platform === 'darwin') {
        child = spawn('osascript', ['-e', `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' })
      } else if (process.platform === 'linux') {
        child = spawn('notify-send', [title, body], { stdio: 'ignore' })
      } else {
        audit(`平台 ${process.platform} 无通知通道，丢弃：${title}`)
        return
      }
      child.on('error', () => { /* spawn 失败只影响通知本身，不打断宿主 */ })
      children.add(child)
      child.on('exit', () => children.delete(child))
      child.unref()
    } catch (error) {
      audit(`通知发送异常：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 会话的展示位置（工作区目录名，退化到会话 id）与子代理判定。 */
  const describeSession = (session: SessionLike | undefined): { where: string; isSubagent: boolean } => {
    const header = session?.header ?? {}
    const where = header.cwd
      ? header.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || (session?.id ?? '')
      : (session?.id ?? '')
    const isSubagent =
      header.parentSession !== undefined ||
      header.origin === 'subagent' ||
      (header.delegationDepth ?? 0) > 0
    return { where, isSubagent }
  }

  /** 深链已移除（协议唤起便携壳自解压太慢，2026-10-06 应用户要求砍掉）；只解析音效文件。 */
  const soundFor = (kind: SoundKind): string => {
    if (!config.sound || process.platform !== 'win32') return ''
    for (const name of SOUND_FILES[kind]) {
      const path = join(MEDIA_DIR, name)
      if (existsSync(path)) return path
    }
    return ''
  }

  audit(`插件加载 sound=${config.sound} subagents=${config.notifySubagents} minGapMs=${config.minGapMs}`)

  ctx.on('session/event' as never, ((session: SessionLike, event: SessionEventLike) => {
    try {
      const { where, isSubagent } = describeSession(session)
      if (isSubagent && !config.notifySubagents) {
        audit(`子代理会话 ${session?.id ?? '?'} 事件 ${event?.type} 跳过`)
        return
      }

      let title: string | null = null
      let body = where
      let soundKind: SoundKind | undefined

      if (event?.type === 'turn/end') {
        const reason = event.data?.reason
        const kind = typeof reason === 'object' && reason !== null ? reason.kind : undefined
        audit(`turn/end kind=${String(kind)} @ ${where}`)
        soundKind = turnSoundKind(kind)
        if (kind === 'completed' && config.onComplete) {
          title = '任务完成'
        } else if (kind === 'max-tokens' && config.onMaxTokens) {
          title = '任务完成（输出被截断）'
        } else if (kind === 'error' && config.onError) {
          title = '任务失败'
          body = where + ' · ' + truncate(errorText(typeof reason === 'object' ? reason : undefined))
        } else if (kind === 'aborted' && config.onAborted) {
          title = '任务中止'
          body = where + ' · ' + abortCauseText(typeof reason === 'object' ? reason : undefined)
        } else if (kind === 'blocked' && config.onBlocked) {
          title = '任务被阻止'
          body = where + ' · 本轮未开始（被钩子或策略拦截）'
        } else if (kind === 'interrupted' && config.onInterrupted) {
          title = '任务中断'
          body = where + ' · 上次运行异常退出，恢复时封闭'
        }
        // kind === 'forked'：fork 种子的记账标记，不是用户可感状态，不通知。
      } else if (event?.type === 'approval/asked' && config.onApproval) {
        const askReason = typeof event.data?.reason === 'string' ? event.data.reason : undefined
        title = '等待确认'
        soundKind = 'attention'
        body = (event.data?.toolName ?? '未知工具') + (askReason ? ' · ' + truncate(askReason) : '')
      }
      if (title === null) return

      const isBlocking = event.type === 'approval/asked'
      const now = Date.now()
      if (!isBlocking && now - lastTurnNotify < config.minGapMs) {
        audit(`冷却中丢弃：${title} @ ${where}`)
        return
      }
      if (!isBlocking) lastTurnNotify = now
      audit(`通知：${title} @ ${where}`)
      notify(`${config.titlePrefix} · ${title}`, body, soundKind ? soundFor(soundKind) : '')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      audit(`处理 session/event 异常（已吞掉）：${message}`)
      ctx.logger?.warn?.('[desktop-notifier] 处理 session/event 异常：%s', message)
    }
  }) as never)

  // 需要回答：ask_user_question 的请求链没有审计事件，只能旁听 waterfall。
  // 只通知并原样转发 next()；通知路径的异常吞掉，绝不应答、绝不短路。
  ctx.on('user-questions/request' as never, ((req: QuestionRequestLike, next: () => Promise<unknown>) => {
    try {
      if (config.onQuestion) {
        const session = req?.agent?.session
        const { where, isSubagent } = describeSession(session)
        if (!isSubagent || config.notifySubagents) {
          const questions = Array.isArray(req?.questions) ? req.questions : []
          const first = typeof questions[0]?.question === 'string' ? questions[0].question! : ''
          const count = questions.length > 1 ? `（共 ${questions.length} 问）` : ''
          const body = where + (first || count ? ' · ' + truncate(first || 'agent 请求回答') + count : '')
          audit(`通知：等待回答 @ ${where}`)
          notify(`${config.titlePrefix} · 等待回答`, body, soundFor('question'))
        } else {
          audit(`子代理会话 ${session?.id ?? '?'} 提问跳过`)
        }
      }
    } catch (error) {
      audit(`处理 user-questions/request 通知异常（已吞掉）：${error instanceof Error ? error.message : String(error)}`)
    }
    return next()
  }) as never)
}
