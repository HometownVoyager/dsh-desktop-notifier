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
import type { Context } from 'cordis';
import z from 'schemastery';
export declare const name = "@dsh-external/dsh-desktop-notifier";
export interface Config {
    /** 弹「任务完成」通知（turn/end reason=completed）。 */
    onComplete: boolean;
    /** 弹「输出被截断」通知（turn/end reason=max-tokens）。 */
    onMaxTokens: boolean;
    /** 弹「任务失败」通知（turn/end reason=error），正文带失败摘要。 */
    onError: boolean;
    /** 弹「任务中止」通知（turn/end reason=aborted），正文带中止原因。 */
    onAborted: boolean;
    /** 弹「任务被阻止」通知（turn/end reason=blocked，本轮未开始）。 */
    onBlocked: boolean;
    /** 弹「任务中断」通知（turn/end reason=interrupted，崩溃孤儿轮被恢复封闭）。 */
    onInterrupted: boolean;
    /** 弹「等待确认」通知（approval/asked 审计事件）。 */
    onApproval: boolean;
    /** 弹「等待回答」通知（user-questions/request waterfall 旁听）。 */
    onQuestion: boolean;
    /** 子代理会话是否也通知（默认只跟顶层会话）。 */
    notifySubagents: boolean;
    /** 轮次类通知的最小间隔（毫秒）；确认与回答请求不受冷却限制。 */
    minGapMs: number;
    /** 气泡标题前缀。 */
    titlePrefix: string;
    /** toast 归属名（Windows 通知中心里显示的应用名）；留空走无品牌气泡。 */
    toastAppName: string;
    /** toast 的 AppUserModelID（配合 toastAppName 注册，须含字母数字与点）；留空跳过 toast 直接气泡。 */
    toastAppId: string;
    /** toast 图标（.png/.ico 绝对路径）；留空用系统默认图标。 */
    toastIconPath: string;
    /** 按状态播系统提示音（win32，SoundPlayer 播 C:\Windows\Media 自带 wav）。 */
    sound: boolean;
    /** 把每次决策追加到 %TEMP%\dsh-desktop-notifier.log（排障用）。 */
    debugLog: boolean;
}
export declare const Config: z<Config>;
/**
 * Windows 通知脚本：首选 WinRT toast（AUMID 品牌化），失败退回 NotifyIcon 气泡。
 * 全部可变文本经 base64 内嵌，PowerShell 侧无引号转义；XML 文本用
 * SecurityElement.Escape 转义。toast XML 显式静音（audio silent），音效由
 * SoundPlayer 播 config 指定的系统 wav——双保险避免系统默认音与自播音叠响。
 * 导出仅供 toast-check 脚本验证模板。
 */
export declare function winNotifyScript(o: {
    title: string;
    body: string;
    appName: string;
    aumid: string;
    icon: string;
    /** 可选音效 wav 绝对路径（C:\Windows\Media 下）；空串不播。 */
    sound: string;
}): string;
export declare function apply(ctx: Context, config: Config): void;
