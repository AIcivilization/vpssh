"use strict";
// 模型来源：把 dsh-model（多家模型汇成一个 OpenAI 兼容地址，自动进 DSH 的模型列表）接进 vpssh。
//
// dsh-model 原样从 npm 装（不复制、不修改它的代码），装法与它自己的「从 dsh 管理页一键安装」相同：
//   1. 用 DSH 自己的 `dsh plugin add` 把 dsh-model 装进 DSH 的 web profile（插件即完整程序）；
//   2. 运行插件里的 `dsh-model setup --skip-dsh-plugin`：下载并校验引擎，起两个后台服务（用户级
//      systemd，vpssh 用户；install.sh 已为它开了 linger），把模型写进 DSH；
//   3. 重启 DSH 加载它的管理页（「设置 → dsh-model」）。之后来源登录、选模型、更新都在那一页里做。
//
// 要点：dsh-model 在 Linux 上一看到 /opt/dsh-vps 就按 dsh-vps 的方式运行、改 dsh-vps 的 DSH。
// vpssh 和 dsh-vps 装在同一台机器上很常见，所以 vpssh 一律显式告诉它：本机模式、DSH 在哪、版本多少
// （gate.env 里的 DSH_MODEL_MODE=local / DSH_HOME / DSH_MODEL_DSH_BIN / DSH_MODEL_DSH_VERSION，
// DSH 子进程和这里起的命令都继承）。
//
// 网关和 `vpssh model` 命令共用这个文件：网关里在后台跑任务、页面轮询进度；命令行里直接打印。

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PLUGIN = "dsh-model";

function paths(env = process.env) {
	const dshHome = env.DSH_HOME || path.join(env.HOME || "/home/vpssh", ".dsh");
	const pluginDir = path.join(dshHome, "profiles", "web", "node_modules", PLUGIN);
	return { dshHome, pluginDir, bin: path.join(pluginDir, "bin", "dsh-model.js"), home: env.DSH_MODEL_HOME || path.join(env.HOME || "/home/vpssh", ".dsh-model") };
}

/** 跑 dsh-model 和 dsh plugin 时的环境：本机模式 + 插件安装要的 pnpm 设置（vpssh 自己的插件归 root，只能复制） */
function jobEnv(env = process.env, mirror = false) {
	const out = {
		...env,
		DSH_MODEL_MODE: "local",
		pnpm_config_minimum_release_age: "0",
		pnpm_config_package_import_method: "copy",
	};
	if (mirror) out.npm_config_registry = "https://registry.npmmirror.com";
	return out;
}

function installedVersion(env = process.env) {
	try {
		return JSON.parse(fs.readFileSync(path.join(paths(env).pluginDir, "package.json"), "utf8")).version || "";
	} catch {
		return "";
	}
}

/** 用户级服务能不能用：linger 开着、用户的 systemd 起来了（/run/user/<uid>/bus 在） */
function userBusReady(env = process.env) {
	const dir = env.XDG_RUNTIME_DIR;
	return Boolean(dir && fs.existsSync(path.join(dir, "bus")));
}

function serviceActive(name, env = process.env) {
	if (!userBusReady(env)) return false;
	const r = spawnSync("systemctl", ["--user", "is-active", name], { env, encoding: "utf8", timeout: 5000 });
	return r.status === 0 && String(r.stdout).trim() === "active";
}

function status(env = process.env) {
	const version = installedVersion(env);
	return {
		installed: Boolean(version),
		version,
		setUp: fs.existsSync(path.join(paths(env).home, "state.json")),
		engine: serviceActive("dsh-model-engine", env),
		daemon: serviceActive("dsh-model-bridge", env),
		userServices: userBusReady(env),
	};
}

/** 一步：跑一条命令，输出一行行交给 onLine；返回退出码 */
function step(cmd, args, { env, onLine, cwd }) {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
		let buf = "";
		const take = (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\n")) >= 0) {
				onLine(buf.slice(0, i).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, ""));
				buf = buf.slice(i + 1);
			}
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("error", (e) => {
			onLine(String(e.message || e));
			resolve(127);
		});
		child.on("close", (code) => {
			if (buf) onLine(buf);
			resolve(code ?? 1);
		});
	});
}

/**
 * 启用：装 dsh-model 插件 → setup。成功返回 true（调用方随后重启 DSH）。
 * lang：zh | en；mirror：服务器在国内（npm 走 npmmirror）
 */
async function enable({ env = process.env, lang = "en", mirror = false, onLine = () => {} } = {}) {
	const M = (zh, en) => (lang === "zh" ? zh : en);
	if (!env.DSH_BIN) throw new Error(M("找不到 DSH（gate.env 里没有 DSH_BIN）", "DSH not found (no DSH_BIN in gate.env)"));
	if (!userBusReady(env)) {
		throw new Error(M(
			"这台服务器还没开启 vpssh 的后台服务权限：在服务器上执行 sudo vpssh model enable（或先 sudo vpssh upgrade）",
			"Background services are not enabled for vpssh on this server yet: run sudo vpssh model enable there (or sudo vpssh upgrade first)",
		));
	}
	const e = jobEnv(env, mirror);
	const p = paths(env);
	onLine(M("① 安装 dsh-model（从 npm）", "① Installing dsh-model (from npm)"));
	let code = await step(process.execPath, [env.DSH_BIN, "plugin", "--profile", "web", "add", `${PLUGIN}@latest`], { env: e, onLine, cwd: env.HOME });
	if (code !== 0 || !installedVersion(env)) throw new Error(M(`安装 dsh-model 失败（退出码 ${code}）`, `Installing dsh-model failed (exit code ${code})`));
	onLine(M(`② 设置 dsh-model ${installedVersion(env)}：下载引擎、起后台服务、接进 DSH`, `② Setting up dsh-model ${installedVersion(env)}: engine, background services, DSH`));
	code = await step(process.execPath, [p.bin, "setup", "--skip-dsh-plugin", "--lang", lang], { env: e, onLine, cwd: env.HOME });
	if (code !== 0) throw new Error(M(`dsh-model 设置失败（退出码 ${code}）`, `Setting up dsh-model failed (exit code ${code})`));
	return true;
}

/**
 * 停用：dsh-model 自己的卸载（停服务、把 DSH 的配置原样还原、移除插件）。
 * --keep-auth：各家的登录凭据先备份到 ~/dsh-model-auth-backup-<时间>（再启用不会自动用上，要重新登录）
 */
async function disable({ env = process.env, lang = "en", onLine = () => {} } = {}) {
	const M = (zh, en) => (lang === "zh" ? zh : en);
	const p = paths(env);
	if (!fs.existsSync(p.bin)) {
		onLine(M("dsh-model 没有装，不用停用", "dsh-model is not installed; nothing to do"));
		return true;
	}
	onLine(M("卸载 dsh-model：停后台服务、还原 DSH 的模型配置、移除插件", "Removing dsh-model: stop services, restore DSH's model config, remove the plugin"));
	const code = await step(process.execPath, [p.bin, "uninstall", "--yes", "--keep-auth", "--remove-plugin", "--lang", lang], { env: jobEnv(env), onLine, cwd: env.HOME });
	if (code !== 0) throw new Error(M(`dsh-model 卸载失败（退出码 ${code}）`, `Removing dsh-model failed (exit code ${code})`));
	// 不加 --remove-plugin 时它不移 DSH 里的插件（实测 0.21.4）；移不掉的情况也兜底：还在就用 DSH 的命令移除
	if (installedVersion(env) && env.DSH_BIN) {
		onLine(M("从 DSH 移除 dsh-model 插件", "Removing the dsh-model plugin from DSH"));
		const rm = await step(process.execPath, [env.DSH_BIN, "plugin", "--profile", "web", "remove", PLUGIN], { env: jobEnv(env), onLine, cwd: env.HOME });
		if (rm !== 0 || installedVersion(env)) throw new Error(M(`从 DSH 移除 dsh-model 插件失败（退出码 ${rm}）`, `Removing the dsh-model plugin from DSH failed (exit code ${rm})`));
	}
	return true;
}

/** 网关里的后台任务：同一时间一个；最近 400 行日志给页面看 */
function createJobRunner({ env = process.env, restartDsh = () => {}, log = () => {} } = {}) {
	let job = null;
	return {
		get() {
			return job ? { action: job.action, state: job.state, lines: job.lines.slice(-400), error: job.error, startedAt: job.startedAt } : null;
		},
		start(action, { lang = "en", mirror = false } = {}) {
			if (job && job.state === "running") return false;
			job = { action, state: "running", lines: [], error: "", startedAt: Date.now() };
			const current = job;
			const onLine = (line) => {
				current.lines.push(line);
				if (current.lines.length > 2000) current.lines.splice(0, current.lines.length - 2000);
			};
			const run = action === "enable" ? enable({ env, lang, mirror, onLine }) : disable({ env, lang, onLine });
			run
				.then(() => {
					current.state = "done";
					onLine(lang === "zh" ? "③ 重启界面服务（DSH），加载 dsh-model 的管理页…" : "③ Restarting DSH to load dsh-model's settings page…");
					log(`model ${action} done; restarting dsh`);
					setTimeout(() => restartDsh(`model ${action}`), 500);
				})
				.catch((err) => {
					current.state = "failed";
					current.error = String(err.message || err);
					onLine(current.error);
					log(`model ${action} failed: ${current.error}`);
				});
			return true;
		},
	};
}

module.exports = { paths, jobEnv, status, enable, disable, createJobRunner, installedVersion, userBusReady };

// 命令行：node model.js status|enable|disable [--lang zh|en] [--mirror]（由 `sudo vpssh model` 以 vpssh 用户调用）
if (require.main === module) {
	const [action] = process.argv.slice(2);
	const lang = process.argv.includes("--lang") ? process.argv[process.argv.indexOf("--lang") + 1] : /^zh/i.test(process.env.LANG || "") ? "zh" : "en";
	const mirror = process.argv.includes("--mirror");
	const onLine = (l) => process.stdout.write(`${l}\n`);
	if (action === "status") {
		process.stdout.write(`${JSON.stringify(status())}\n`);
	} else if (action === "enable" || action === "disable") {
		(action === "enable" ? enable({ lang, mirror, onLine }) : disable({ lang, onLine })).then(
			() => process.exit(0),
			(err) => {
				process.stderr.write(`${err.message || err}\n`);
				process.exit(1);
			},
		);
	} else {
		process.stderr.write("usage: node model.js status|enable|disable [--lang zh|en] [--mirror]\n");
		process.exit(2);
	}
}
