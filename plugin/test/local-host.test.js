// 本机登记 + vpssh-keyd 保管钥匙时插件只碰公钥
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paths, readHosts } from '../lib/config.js'
import { ensureLocalHost, localAlias } from '../lib/local-host.js'
import { ensureKey } from '../lib/onboarding.js'

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICFFJiMPeXuftuZmPNWbz2kbBhkCLO3uJEpOAHeBS5BP vpssh@test'

async function sandbox(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'vpssh-local-'))
  await mkdir(join(home, '.ssh'), { recursive: true })
  const keyDir = join(home, 'keys')
  await mkdir(keyDir)
  await writeFile(join(keyDir, 'vpssh_ed25519.pub'), `${PUB}\n`)
  return { HOME: home, DSH_HOME: join(home, '.dsh'), VPSSH_KEY_PUB: join(keyDir, 'vpssh_ed25519.pub'), ...extra }
}

test('钥匙在 vpssh-keyd 那里：插件只读公钥，不生成、不找私钥', async () => {
  const env = await sandbox()
  const p = paths(env)
  assert.equal(p.agentKey, true)
  assert.equal(p.defaultKey, env.VPSSH_KEY_PUB, 'ssh 的 IdentityFile 指向公钥，靠它挑 agent 里的钥匙')
  const key = await ensureKey({ env, create: true })
  assert.equal(key.pubkey, PUB)
  assert.equal(key.created, false)
  assert.equal(key.agent, true)
  await rm(env.VPSSH_KEY_PUB)
  const missing = await ensureKey({ env, create: true })
  assert.equal(missing.missing, true, 'keyd 还没生成公钥时报缺，不自己生成一把')
})

test('没有 VPSSH_KEY_PUB 时照旧用 ~/.ssh/vpssh_ed25519', async () => {
  const env = await sandbox()
  delete env.VPSSH_KEY_PUB
  const p = paths(env)
  assert.equal(p.agentKey, false)
  assert.equal(p.defaultKey, join(env.HOME, '.ssh', 'vpssh_ed25519'))
})

test('本机别名：主机名；重名加 -local', () => {
  assert.equal(localAlias([], 'web-01.local'), 'web-01')
  assert.equal(localAlias(['web-01'], 'web-01'), 'web-01-local')
})

test('本机登记：有 VPSSH_LOCAL_USER 才做，只做一次，用户删了不加回来', async () => {
  assert.deepEqual(await ensureLocalHost({ env: await sandbox(), probe: false }), { skipped: 'not-configured' })

  const env = await sandbox({ VPSSH_LOCAL_USER: 'vpssh-admin', VPSSH_LOCAL_PORT: '2222' })
  const first = await ensureLocalHost({ env, probe: false })
  assert.ok(first.added)
  const doc = await readHosts(env)
  assert.deepEqual(Object.keys(doc.hosts), [first.added])
  assert.equal(doc.current, first.added, '成为当前机器')
  const dropin = await readFile(paths(env).sshDropin, 'utf8')
  assert.match(dropin, /HostName 127\.0\.0\.1/)
  assert.match(dropin, /Port 2222/)
  assert.match(dropin, /User vpssh-admin/)
  assert.ok(dropin.includes(`IdentityFile ${env.VPSSH_KEY_PUB}`), '用 keyd 的公钥')
  assert.match(dropin, /IdentityAgent SSH_AUTH_SOCK/, '明确走 keyd，不受系统 ssh_config 影响')

  assert.deepEqual(await ensureLocalHost({ env, probe: false }), { skipped: 'already-done' })
})
