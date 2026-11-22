#!/usr/bin/env node
/**
 * 冒烟测试：不起 DSH，用假 ctx 直接驱动 apply()。
 * 真实 spawn PowerShell 弹品牌 toast，覆盖全部任务状态：
 * 完成 / 截断 / 失败 / 中止 / 被阻止 / 中断 / 等待确认 / 等待回答，
 * 并验证子代理过滤与分状态音效。弹窗 + 出声即通过。
 */
import { apply } from '../lib/index.js'

const handlers = {}
const ctx = {
  effect: (fn) => fn(),
  on: (ev, h) => { handlers[ev] = h },
  logger: {
    info: (...a) => console.log('[info]', ...a),
    warn: (...a) => console.log('[warn]', ...a),
  },
}

apply(ctx, {
  onComplete: true,
  onMaxTokens: true,
  onError: true,
  onAborted: true,
  onBlocked: true,
  onInterrupted: true,
  onApproval: true,
  onQuestion: true,
  notifySubagents: false,
  minGapMs: 0,
  titlePrefix: 'DSH 冒烟',
  toastAppName: 'OrcaMind',
  toastAppId: 'DeepSeekHarness.OrcaMind.Smoke',
  toastIconPath: 'D:\\Tools\\DeepSeek Harness\\desktop\\build\\icon.png',
  sound: true,
  debugLog: true,
})

const top = { id: 'session-test', header: { cwd: 'D:\\Tools\\DeepSeek Harness', delegationDepth: 0 } }
const sub = { id: 'session-sub', header: { cwd: 'D:\\somewhere', delegationDepth: 1 } }

// 1. 顶层完成 → 「任务完成」
handlers['session/event'](top, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
// 2. 输出截断 → 「任务完成（输出被截断）」
handlers['session/event'](top, { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
// 3. 失败（fetch failed 形态）→ 「任务失败」带摘要
handlers['session/event'](top, { type: 'turn/end', data: { turn: 2, reason: { kind: 'error', error: { message: 'fetch failed', code: 'UNKNOWN' } } } })
// 4. 中止（用户手动停止）→ 「任务中止 · 手动停止」
handlers['session/event'](top, { type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
// 5. 被阻止 → 「任务被阻止」
handlers['session/event'](top, { type: 'turn/end', data: { turn: 4, reason: { kind: 'blocked' } } })
// 6. 崩溃恢复封闭 → 「任务中断」
handlers['session/event'](top, { type: 'turn/end', data: { turn: 5, reason: { kind: 'interrupted' } } })
// 7. fork 种子标记 → 不通知
handlers['session/event'](top, { type: 'turn/end', data: { turn: 6, reason: { kind: 'forked' } } })
// 8. 审批等待 → 「等待确认」（不受冷却限制）
handlers['session/event'](top, { type: 'approval/asked', data: { id: 'a1', toolName: 'bash', reason: '冒烟测试审批' } })
// 9. 子代理完成 → 应被过滤（notifySubagents=false）
handlers['session/event'](sub, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
// 10. 用户提问（waterfall 旁听）→ 「等待回答」并原样转发 next()
const question = { questions: [{ id: 'q1', question: '冒烟测试问题：选哪个方案？' }, { id: 'q2', question: '第二个问题' }], agent: { session: top } }
let passthrough = false
handlers['user-questions/request'](question, async () => { passthrough = true; return 'allowed-once' })

setTimeout(() => {
  if (!passthrough) {
    console.error('[FAIL] user-questions/request 未转发 next()')
    process.exit(1)
  }
  console.log('冒烟结束：桌面应先后弹 8 条 OrcaMind 品牌 toast')
  console.log('（完成 / 截断 / 任务失败·fetch failed / 任务中止·手动停止 / 任务被阻止 / 任务中断 / 等待确认 / 等待回答），')
  console.log('子代理完成与 forked 种子两条被过滤；waterfall 旁听已原样转发 next()。')
  console.log(`审计日志：%TEMP%\\dsh-desktop-notifier.log`)
}, 300)
