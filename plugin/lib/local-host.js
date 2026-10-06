// lib/local-host.js — 把 vpssh 所在的这台服务器登记成第一台机器
//
// install.sh 在这台机器上建了 vpssh-admin 账号（只接受从 127.0.0.1 用 vpssh 的钥匙登录，免密 sudo），
// 并经环境变量告诉插件：VPSSH_LOCAL_USER（账号）、VPSSH_LOCAL_PORT（本机 sshd 端口）。
// 插件启动时登记一次，之后和管别的机器一样：经 SSH、按风险分级确认。
// 只登记一次：用户自己把它删了，就不再加回来（记在数据目录的 local-host.json 里）。

import { access, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { deviceName, ensureDirs, paths, readHosts } from './config.js'
import { L } from './i18n.js'
import { saveHost } from './onboarding.js'

const exists = (file) => access(file).then(() => true, () => false)

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
  if (await exists(flag)) return { skipped: 'already-done' }

  const doc = await readHosts(env)
  const alias = localAlias(Object.keys(doc.hosts))
  const port = Number(env.VPSSH_LOCAL_PORT) || 22
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
