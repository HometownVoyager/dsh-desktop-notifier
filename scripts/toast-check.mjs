#!/usr/bin/env node
/**
 * toast 模板检查（win32）：把 winNotifyScript 生成的脚本交给 PowerShell 真跑，
 * 但把「吞错 catch」换成暴露失败、把 Show 换成输出 toast XML 的 audio 属性。
 * 断言：带音效变体 exit 0 且 audio silent="true"（防双重响）且含 PlaySync；
 * 无音效变体 exit 0、无 audio 属性、无 PlaySync。
 * （真实 Show 已由 smoke 覆盖，这里只验 XML 合法性与属性值。）
 */
import { execFileSync } from 'node:child_process'
import { winNotifyScript } from '../lib/index.js'

const opts = {
  title: '检查标题',
  body: '检查正文',
  appName: 'OrcaMind',
  aumid: 'DeepSeekHarness.OrcaMind.Check',
  icon: '',
}
const SOUND = 'C:\\Windows\\Media\\Windows Notify System Generic.wav'
const fail = (msg) => { console.error(`[FAIL] ${msg}`); process.exit(1) }

function run(script) {
  // 暴露 toast 路径的失败（原模板 catch{} 吞掉），并把 Show 换成打印 audio 属性。
  const instrumented = script
    .replace(`} catch { }`, `} catch { Write-Error $_; exit 3 }`)
    .replace(
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($a).Show($toast)`,
      `$audio = $doc.SelectSingleNode('//audio'); Write-Output ('SILENT=' + $(if ($audio) { $audio.GetAttribute('silent') } else { '' }))`,
    )
  const encoded = Buffer.from(instrumented, 'utf16le').toString('base64')
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded,
    ], { encoding: 'utf8' })
  } catch (error) {
    return `__EXIT__${error.status}\n${error.stdout || ''}\n${error.stderr || ''}`
  }
}

const withSoundScript = winNotifyScript({ ...opts, sound: SOUND })
const withSound = run(withSoundScript)
if (withSound.startsWith('__EXIT__3')) fail(`带音效变体 toast 路径抛错：\n${withSound}`)
if (!withSound.includes('SILENT=true')) fail(`带音效变体未静音 toast（应 audio silent="true"），输出：\n${withSound}`)
if (!withSoundScript.includes('PlaySync()')) fail('带音效变体缺少 SoundPlayer PlaySync 播放行')

const withoutSoundScript = winNotifyScript({ ...opts, sound: '' })
const withoutSound = run(withoutSoundScript)
if (withoutSound.startsWith('__EXIT__3')) fail(`无音效变体 toast 路径抛错：\n${withoutSound}`)
if (/(^|\n)SILENT=.+(\n|$)/.test(withoutSound)) fail(`无音效变体却带 audio 属性：\n${withoutSound}`)
if (withoutSoundScript.includes('PlaySync()')) fail('无音效变体却包含 PlaySync 播放行')

console.log('[OK] toast XML 合法：带音效变体 audio silent="true" 且 PlaySync 就位；无音效变体两者皆无。')
