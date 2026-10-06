// lib/vps-mode.js — 「VPS 模式」：对话头部的开关打开，这个对话就是在操作那台服务器
//
// 开关只改「命令发到哪台、AI 工具默认连哪台」还不够：模型不知道这件事，会照常用本机工具，
// 把用户的服务器问题拿到用户电脑上去查（实测：模型跑了 ps aux、which dsh、ls ~）。所以：
//
//   1. 说明：绑定状态变化后的第一步，往这个对话追加一条来源为本插件的 user 消息，
//      告诉模型绑定了哪台、什么系统、该用哪些工具（照 DSH 自带 dsh-time-context 的
//      agent/pre-step 写法）。只在变化时发，不每轮刷
//   2. 守卫：拦下 DSH 自带的本机工具（ctx.tools.guard，同步、单调拒绝）。这一条不看开关，所有对话都拦
//
// 说明按对话生效：另一个窗口没开开关，就收不到说明。

import { randomUUID } from 'node:crypto'
import { cachedBinding, readHosts, readState, sessionBinding } from './config.js'
import { sharedFilesText, takeSharedFiles, takeUnshared, terminalText } from './terminal.js'

export const PLUGIN = 'vpssh'

// 消息来源的写法。DSH 的会话格式 v4（0.1.7-alpha 起）不再收 kind:'plugin'，
// 要求「归属到生产者」：插件写成 plugin:<插件名>。v3 两种都收，而且 DSH 把老会话
// 迁移到 v4 时正是把 {kind:'plugin', plugin:'vpssh'} 改写成这个值，所以统一用它。
// 用错形状的后果不是我们这条消息丢掉，而是整轮对话失败
// （实测报错：format v4 message requires a producer-owned source kind）。
export const SOURCE_KIND = `plugin:${PLUGIN}`

/** 这条消息是不是我们发的（老会话里是 v3 的形状） */
function ours(source) {
  return source?.kind === SOURCE_KIND || (source?.kind === 'plugin' && source.plugin === PLUGIN)
}

// vpssh 装在服务器上（"管理机"）。DSH 自带的本机工具碰到的就是管理机本身：所有机器的钥匙、
// 机器清单、SSH 配置都在这里。模型只要能在本机执行命令或写文件，就能绕过风险分级确认
// （比如往 SSH 配置里写一行 ProxyCommand，下次连机器就会执行）；能读文件，就能把钥匙读出来。
// 所以 vpssh 里这些工具在所有对话里一律拦下，不看有没有绑定机器。
// 要操作管理机本身，走它在机器清单里的那一台（经 SSH，照常确认）。

/** 已知的本机工具：执行命令、读写文件、后台任务、本机终端 */
export const LOCAL_TOOLS = new Set([
  'bash', 'pwsh', 'terminal_send',
  'read', 'read_image', 'grep', 'glob', 'lsp',
  'write', 'edit', 'str_replace_editor',
  'job_output', 'job_list', 'job_kill',
])
/** 不碰本机的 DSH 工具，名字里有 write 之类的词也放行 */
const SAFE_TOOLS = new Set(['todo_write', 'ask_user_question', 'skill', 'subagent', 'plan'])
/** DSH 以后新加的本机工具：名字像执行、写入的，宁可先拦 */
const LOCAL_TOOL_PATTERN = /(^|_)(bash|pwsh|shell|python|exec|run|code|write|edit|patch|replace|job|terminal)(_|$)/

export function isLocalTool(name) {
  const n = String(name ?? '')
  if (n.startsWith('vps_') || n.startsWith('mcp__') || SAFE_TOOLS.has(n)) return false
  return LOCAL_TOOLS.has(n) || LOCAL_TOOL_PATTERN.test(n)
}

const MARK_BOUND = '[VPS 模式] 已绑定 '
const MARK_OFF = '[VPS 模式] 已关闭'

const PRIV_LABEL = { root: 'root', sudo: '免密 sudo', none: '只读（不是 root，也没有免密 sudo）' }

/** 工具守卫：所有对话都拒绝本机工具。返回字符串就是拒绝理由，返回 undefined 放行 */
export function localToolGuard(exec) {
  if (!isLocalTool(exec?.name)) return undefined
  const alias = cachedBinding(String(exec?.agent?.session?.id ?? ''))
  return (
    `vpssh 里不能直接在 vpssh 所在的服务器上执行命令或读写文件（${exec?.name} 已停用）。` +
    (alias
      ? `这个对话绑定了服务器 ${alias}：执行用 vps_exec（host 可以省略），改文件用 vps_write_file。`
      : '操作服务器用 vps_exec / vps_write_file，host 写机器别名（vps_hosts 能列出全部机器）。') +
    '要操作 vpssh 所在的这台机器，用它在机器清单里的别名，照常经确认执行。'
  )
}

/** 这个对话里最近一次说明是什么：绑定的别名、'off'，或者从来没发过（null） */
export function lastAnnouncement(session) {
  const seq = Number(session?.seq)
  if (!Number.isSafeInteger(seq) || typeof session?.eventAt !== 'function') return null
  for (let i = seq - 1; i >= 0; i -= 1) {
    const event = session.eventAt(i)
    if (event?.type !== 'user/message') continue
    const source = event.data?.source
    if (!ours(source)) continue
    const text = source.sections?.[0]?.text ?? event.data?.content?.[0]?.text ?? ''
    if (text.startsWith(MARK_OFF)) return 'off'
    if (text.startsWith(MARK_BOUND)) return text.slice(MARK_BOUND.length).split(/\s/)[0] || null
  }
  return null
}

/** 该发什么：绑定的别名、'off'，或者 null（不用发） */
export function planAnnouncement(current, last) {
  if (current) return current === last ? null : current
  return last && last !== 'off' ? 'off' : null
}

/** 绑定说明：写清是哪台、什么系统，模型按系统写命令 */
export async function boundText(alias, env = process.env) {
  const [doc, state] = await Promise.all([readHosts(env), readState(env)])
  const host = doc.hosts[alias] ?? {}
  const saved = state.hosts?.[alias] ?? {}
  const f = saved.facts ?? {}
  const where = [saved.address, host.note].filter(Boolean).join('，')
  const lines = [
    `${MARK_BOUND}${alias}`,
    '用户在对话头部打开了 VPS 开关：这个对话从现在起就是在操作这台服务器。用户说的「服务器」「VPS」「这台」「本机器」都指它，不是用户的电脑。',
    '',
    `机器：${alias}${where ? `（${where}）` : ''}`,
  ]
  if (f.os_id) {
    lines.push(
      `系统：${f.os_id} ${f.os_ver ?? ''}（${f.os_family ?? '未知'} 系）· 包管理 ${f.pkg ?? '未知'} · init ${f.init ?? '未知'}` +
        `${f.arch ? ` · 架构 ${f.arch}` : ''} · 权限 ${PRIV_LABEL[f.privilege] ?? f.privilege ?? '未知'}`,
    )
    if (f.privilege === 'none') lines.push('这台机器没有管理员权限：会改系统的操作做不了，先告诉用户。')
    const web = String(f.web_listeners ?? '').trim()
    if (web) {
      lines.push(`80/443 端口已被占用：${web.split(/\s+/).join('、')}。已经有 Web 服务或反向代理在跑——加站点、改反代先看它的配置，不要另装 nginx 之类去抢端口`)
    } else if (f.web_listeners !== undefined) {
      lines.push('80/443 端口：没有程序在监听')
    }
    const services = String(f.services ?? '').trim()
    if (services) lines.push(`在跑的服务（准确的服务名，操作服务时照抄，不要猜）：${services.split(/\s+/).join('、')}`)
    const containers = String(f.containers ?? '').trim()
    if (containers) lines.push(`在跑的容器：${containers.split(/\s+/).join('、')}`)
  } else {
    lines.push('系统：还没有体检过。动手前先用 vps_exec 跑 `cat /etc/os-release; uname -m` 确认系统，再按系统写命令。')
  }
  lines.push(
    '',
    '必须遵守：',
    '- 名字不要猜：服务名、配置文件路径、容器名先查出来（systemctl list-units、ls、docker ps）。查不到就把情况告诉用户，不要换个名字接着试',
    '- systemd 管着的服务只用 systemctl status / restart / stop；不要 pkill、kill 之后再手动启动',
    '- 查询失败时先告诉用户查到了什么、哪里没查到；不要把「查不到」变成重启、重装、改监听地址、改防火墙',
    '- 用户说「已经装好 / 配好了」时，默认现有配置是对的：先找到它、读懂它，再判断是不是真有问题',
    '- 每次要改东西之前，一句话说清为什么要改、会影响什么（比如重启会让正在用的人断开）',
    '',
    '怎么做：',
    '- 在服务器上查看或执行：vps_exec（host 可以省略，默认就是这台）',
    '- 改配置文件：vps_write_file（自动备份，校验不通过自动还原），不要用 echo > 或 sed -i',
    '- 动手改之前先查现状：端口被谁占（ss -ltnp）、服务在不在跑、配置文件在哪',
    '- 装常见软件：先 vps_recipe action=list，有现成菜谱就用',
    '- 命令按上面的系统写。不同发行版的包管理器、服务管理、防火墙都不一样；脚本里优先用 $PKG、$SUDO、pkg_install、svc_enable_start、svc_active 这些跨系统写法',
    '- bash、read、write 这类本机工具在 vpssh 里都已停用（它们碰到的是 vpssh 所在的服务器，那里有全部钥匙），调用会被拒绝',
    '- vps_exec 不是交互终端：要一步步按键的（菜单脚本、交互式安装向导、vim、top、mysql 命令行），告诉用户点对话头部「VPS」后面的 >_ 打开终端自己操作',
    '- 用户要把电脑上的文件传到服务器、或者从服务器下载文件：告诉用户点 >_ 打开面板、切到「文件」页，拖进去上传、右键下载（你没有传文件的工具）',
    '- 动手前先读 skill vps-operator，里面有必须遵守的操作规则',
  )
  return lines.join('\n')
}

export const UNBOUND_TEXT = [
  MARK_OFF,
  '用户关掉了 VPS 开关：这个对话不再绑定任何服务器。之后如果要操作服务器，需要用户重新打开开关，或者在 vps_ 工具里明确写 host。本机工具（bash、read、write 等）仍然停用。',
].join('\n')

async function userMessage(text, section = 'vps-mode') {
  const content = [{ type: 'text', text }]
  const source = { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: section, text }] }
  try {
    const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
    if (typeof createUserMessage === 'function') return createUserMessage({ content, source })
  } catch {
    // 宿主没提供这个包时按同样的形状自己拼
  }
  return Object.freeze({ content, source, role: 'user', id: randomUUID() })
}

/** 挂在 agents 服务上：每一步开始前看绑定有没有变，变了就补一条说明 */
export function registerVpsMode(ctx, deps = {}) {
  const env = deps.env ?? process.env
  const warn = deps.warn ?? (() => {})
  // 每个对话最近一次发过的说明。进程重启后为空，第一步从会话历史里找回来，不会重复发
  const announced = new Map()

  return ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind === 'reject' || payload?.signal?.aborted) return decision
    try {
      const session = payload?.agent?.session
      const sessionId = String(session?.id ?? '')
      if (!sessionId) return decision
      const extra = []
      const current = await sessionBinding(sessionId, env)
      const last = announced.has(sessionId) ? announced.get(sessionId) : lastAnnouncement(session)
      const plan = planAnnouncement(current, last)
      if (plan) {
        extra.push(await userMessage(plan === 'off' ? UNBOUND_TEXT : await boundText(plan, env), 'vps-mode'))
        announced.set(sessionId, plan)
      } else {
        announced.set(sessionId, last)
      }
      // 用户自己用 /vps-sh 敲过的命令：DSH 不把命令结果交给模型，这里在用户下次跟 AI 说话时附上
      const typed = takeUnshared(sessionId)
      if (typed.length) extra.push(await userMessage(terminalText(typed), 'vps-terminal'))
      // 文件管理器里点了「让 AI 看看这个文件」的
      const shared = takeSharedFiles(sessionId)
      if (shared.length) extra.push(await userMessage(sharedFilesText(shared), 'vps-files'))
      return extra.length ? { ...decision, messages: [...(decision.messages ?? []), ...extra] } : decision
    } catch (error) {
      warn('VPS 模式说明没发出去', error)
      return decision
    }
  }, { prepend: true })
}
