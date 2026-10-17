// lib/recipe-store.js — 「存成菜谱」（设计 10.5）
//
// 用户扩充菜谱库的主要方式：AI 把刚做成的一件事改写成幂等菜谱，用户确认后落盘。
// 落盘前做三件事：id 加 my- 前缀（不许冒充内置）、格式校验、疑似凭据扫描。

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import YAML from 'yaml'
import { ensureDirs, trustHash } from './config.js'
import { loadRecipes, validateRecipe } from './recipes.js'
import { buildSummary, gate } from './safety.js'
import { L } from './i18n.js'

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, () => L('私钥', 'private key')],
  [/\b(password|passwd|pwd)\s*[:=]\s*\S+/i, () => L('密码', 'password')],
  [/\b(api[_-]?key|secret|token)\s*[:=]\s*\S{8,}/i, () => L('密钥或 Token', 'secret or token')],
  [/\bAKIA[0-9A-Z]{16}\b/, () => 'AWS Access Key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, () => 'GitHub Token'],
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/, () => L('疑似密钥的长随机串', 'long random string that looks like a secret')],
]

export function scanForSecrets(text) {
  const hits = []
  for (const [re, what] of SECRET_PATTERNS) {
    const m = re.exec(String(text ?? ''))
    if (m) hits.push({ what: what(), sample: m[0].slice(0, 24) })
  }
  return hits
}

export async function saveUserRecipe({ ctx, recipe: draft, agent, callId, signal, env = process.env, source = 'ai' }) {
  if (!draft || typeof draft !== 'object') {
    return { ok: false, status: 'invalid', hint: L('要提供菜谱内容', 'The recipe content is required') }
  }
  const rawId = String(draft.id ?? '').trim()
  const id = rawId.startsWith('my-') ? rawId : `my-${rawId || 'recipe'}`

  let recipe
  try {
    recipe = validateRecipe({ ...draft, id }, { source: 'mine', file: '' })
  } catch (error) {
    return { ok: false, status: 'invalid', hint: L(`菜谱格式不合格：${error.message}`, `The recipe format is invalid: ${error.message}`) }
  }
  if (recipe.kind !== 'query' && (!recipe.detect || !recipe.verify)) {
    return { ok: false, status: 'invalid', hint: L('安装 / 配置类菜谱必须写 detect（判断装没装）和 verify（证明能用）', 'Install and configure recipes must have detect (is it installed?) and verify (does it work?)') }
  }

  const { byId } = await loadRecipes({ env })
  const existing = byId.get(id)
  if (existing && existing.source === 'builtin') {
    return { ok: false, status: 'invalid', hint: L(`${id} 与内置菜谱重名，换一个 id`, `${id} has the same id as a built-in recipe; choose another id`) }
  }

  const secrets = scanForSecrets([recipe.run, recipe.detect, recipe.verify].join('\n'))
  if (secrets.length) {
    return {
      ok: false,
      status: 'invalid',
      hint: L(`菜谱里有疑似凭据（${secrets.map((s) => s.what).join('、')}），改成参数传入或在服务器上生成后再保存`, `The recipe seems to contain credentials (${secrets.map((s) => s.what).join(', ')}). Pass them as parameters or generate them on the server, then save again`),
      secrets,
    }
  }

  const summary = buildSummary({
    label: L('[本机]', '[this computer]'),
    tier: 'change',
    action: L(`保存菜谱「${recipe.name}」到「我的」`, `save recipe "${recipe.name}" to "mine"`),
    detail: L(`${recipe.kind} · ${existing ? '覆盖同名自定义菜谱' : '新增'}`, `${recipe.kind} · ${existing ? 'overwrites the custom recipe with the same id' : 'new'}`),
    hash: recipe.hash,
  })
  const decision = await gate({
    ctx,
    tier: 'change',
    confirmLevel: 'careful', // 落盘到菜谱目录一律问一次
    summary,
    agent,
    tool: 'vps_recipe',
    callId,
    signal,
    audit: { source, action: 'recipe_save', recipeId: id, script: recipe.run },
    env,
  })
  if (!decision.allowed) {
    return { ok: false, status: 'denied', hint: decision.hint ?? L('未获确认', 'Not confirmed'), summary }
  }

  const p = await ensureDirs(env)
  const file = join(p.recipesDir, `${id}.yml`)
  const body = YAML.stringify({
    schema: 1,
    recipes: [
      {
        id,
        kind: recipe.kind,
        name: recipe.name,
        desc: recipe.desc,
        tags: recipe.tags.length ? recipe.tags : undefined,
        shell: recipe.shell,
        risk: recipe.risk,
        timeout: recipe.timeout,
        requires: recipe.requires,
        params: recipe.params.length ? recipe.params : undefined,
        detect: recipe.detect || undefined,
        plan: recipe.plan || undefined,
        run: recipe.run,
        verify: recipe.verify || undefined,
      },
    ],
  })
  const header = [
    '# 由 vpssh 保存的自定义菜谱',
    `# 来源：${source}　保存时间：${new Date().toISOString()}`,
    '# 自定义菜谱：没经过多系统实测，改坏了自己负责',
    '',
  ].join('\n')
  await writeFile(file, header + body, { mode: 0o600 })
  await trustHash(recipe.hash, { id, source: 'mine' }, env).catch(() => {})

  return {
    ok: true,
    id,
    file,
    tier: recipe.tier,
    hint: L(`已保存到「我的」菜谱：${id}（/vps-recipes 里来源标「我的」）。要改就再存一遍同名的，要删就删掉 ${file}`, `Saved to "mine": ${id} (marked "mine" in /vps-recipes). To change it, save again with the same id; to delete it, delete ${file}`),
  }
}

// ——— 一键命令（常用操作页上用户自己填的：名称、命令、说明、GitHub 链接）———
// 用户在界面上亲手填的，不经 AI，所以不弹确认就保存；但第一次运行（或改过之后）照样要确认一次（菜谱哈希没被信任过），
// 之后按命令本身的档位走：只读的直接跑，会改东西的要确认。命令里有疑似密码、密钥就不让存

const CMD_PREFIX = 'my-cmd-'

/** 名字里的英文数字做 id，没有就随机 */
function commandId(name) {
  const slug = String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `${CMD_PREFIX}${slug || Math.random().toString(36).slice(2, 8)}`
}

export async function saveCustomCommand({ id, name, run, desc = '', url = '', env = process.env }) {
  const title = String(name ?? '').trim()
  const script = String(run ?? '').replace(/\r\n?/g, '\n').trim()
  if (!title) return { ok: false, hint: L('要填命令名称', 'Enter a name') }
  if (title.length > 60) return { ok: false, hint: L('名称太长（最多 60 个字）', 'Name too long (60 characters at most)') }
  if (!script) return { ok: false, hint: L('要填命令', 'Enter the command') }
  if (script.length > 20_000) return { ok: false, hint: L('命令太长', 'Command too long') }
  const link = String(url ?? '').trim()
  if (link && !/^https:\/\/\S+$/.test(link)) return { ok: false, hint: L('链接要以 https:// 开头', 'The link must start with https://') }
  const secrets = scanForSecrets(script)
  if (secrets.length) {
    return { ok: false, hint: L(`命令里有疑似密码或密钥（${secrets.map((s) => s.what).join('、')}）。别把它们写进命令：放在服务器上的文件或环境变量里，命令里去读`, `The command seems to contain a password or key (${secrets.map((s) => s.what).join(', ')}). Keep them out of the command: put them in a file or environment variable on the server and read them from there`) }
  }
  const { byId } = await loadRecipes({ env })
  let finalId = id && String(id).startsWith(CMD_PREFIX) ? String(id) : commandId(title)
  if (!id) {
    // 新建：和已有的（内置或别的命令）撞名就加个尾巴
    let n = 2
    const base = finalId
    while (byId.has(finalId)) finalId = `${base}-${n++}`
  } else if (byId.get(finalId) && byId.get(finalId).source !== 'mine') {
    return { ok: false, hint: L('只能改自己加的命令', 'Only your own commands can be edited') }
  }
  const recipe = validateRecipe({ id: finalId, kind: 'command', name: title, desc: String(desc ?? '').trim(), url: link, shell: 'bash', risk: 'read', timeout: 600, run: script }, { source: 'mine', file: '' })
  const p = await ensureDirs(env)
  const body = YAML.stringify({
    schema: 1,
    recipes: [{ id: recipe.id, kind: 'command', name: recipe.name, desc: recipe.desc || undefined, url: recipe.url || undefined, shell: 'bash', risk: 'read', timeout: 600, run: recipe.run }],
  })
  const header = ['# 由 vpssh 保存的一键命令（常用操作页）', `# 保存时间：${new Date().toISOString()}`, ''].join('\n')
  await writeFile(join(p.recipesDir, `${recipe.id}.yml`), header + body, { mode: 0o600 })
  return { ok: true, id: recipe.id, tier: recipe.tier }
}

export async function deleteCustomCommand({ id, env = process.env }) {
  if (!String(id ?? '').startsWith(CMD_PREFIX)) return { ok: false, hint: L('只能删自己加的命令', 'Only your own commands can be deleted') }
  const p = await ensureDirs(env)
  await rm(join(p.recipesDir, `${id}.yml`), { force: true })
  return { ok: true }
}

/** 编辑时要的原样内容 */
export async function readCustomCommand({ id, env = process.env }) {
  const { byId } = await loadRecipes({ env })
  const r = byId.get(id)
  if (!r || r.kind !== 'command' || r.source !== 'mine') return { ok: false, hint: L('没有这条命令', 'No such command') }
  return { ok: true, command: { id: r.id, name: r.name, desc: r.desc, url: r.url, run: r.run } }
}
