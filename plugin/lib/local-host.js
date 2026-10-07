// lib/local-host.js — 把 vpssh 所在的这台服务器登记成第一台机器
//
// install.sh 让 vpssh 的钥匙能从 127.0.0.1 登录这台机器：默认 root（和平时 SSH 上来一样）；
// sshd 禁了 root 登录时用专用账号 vpssh-admin（免密 sudo）。经 gate.env 告诉插件：
// VPSSH_LOCAL_USER（账号）、VPSSH_LOCAL_PORT（本机 sshd 端口）。
// 插件启动时登记一次，之后和管别的机器一样：经 SSH、按风险分级确认。
// 只登记一次：用户自己把它删了，就不再加回来（记在数据目录的 local-host.json 里）。
// 登录账号变了（0.1.5 以前用专用账号 vpssh-admin，之后默认用 root）：已登记的那台跟着改，名字、备注、分组不变。

import { access, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { deviceName, ensureDirs, paths, readDropin, readHosts } from './config.js'
import { L } from './i18n.js'
import { saveHost } from './onboarding.js'

const exists = (file) => access(file).then(() => true, () => false)

/** 插件写的 SSH 配置里，这台机器用哪个账号登录 */
export function dropinUser(text, alias) {
  let inBlock = false
  for (const line of String(text).split('\n')) {
    const host = /^Host\s+(\S+)/.exec(line)
    if (host) inBlock = host[1] === alias
    const user = inBlock ? /^\s+User\s+(\S+)/.exec(line) : null
    if (user) return user[1]
  }
  return ''
}

/** 给这台机器起别名：主机名；和已有的重名就加 -local */
export function localAlias(taken, name = hostname()) {
  const base = deviceName(name) || 'vpssh'
  return taken.includes(base) ? `${base}-local` : base
}

export async function ensureLocalHost({ env = process.env, runner, probe = true } = {}) {
  const user = String(env.VPSSH_LOCAL_USER ?? '').trim()
  if (!user) return { skipped: 'not-configured' }
  await ensureDirs(env)
  const flag = join(paths(env).base, 'local-host.json')
  const port = Number(env.VPSSH_LOCAL_PORT) || 22
  if (await exists(flag)) {
    const done = JSON.parse(await readFile(flag, 'utf8').catch(() => '{}'))
    const doc = await readHosts(env)
    const host = done.alias ? doc.hosts[done.alias] : null
    if (!host) return { skipped: 'already-done' } // 用户删了：不加回来
    if (dropinUser(await readDropin(env), done.alias) === user) return { skipped: 'already-done' }
    const result = await saveHost({ alias: done.alias, hostname: '127.0.0.1', port, user, note: host.note ?? '', group: host.group ?? '', confirm: host.confirm, env, runner, probe })
    return { updated: done.alias, user, probe: result.probe }
  }

  const doc = await readHosts(env)
  const alias = localAlias(Object.keys(doc.hosts))
  const result = await saveHost({
    alias,
    hostname: '127.0.0.1',
    port,
    user,
    note: L('vpssh 所在的服务器', 'The server vpssh runs on'),
    env,
    runner,
    probe,
  })
  await writeFile(flag, JSON.stringify({ alias, addedAt: new Date().toISOString() }) + '\n', { mode: 0o600 })
  return { added: alias, probe: result.probe }
}
