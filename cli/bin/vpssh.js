#!/usr/bin/env node
// vpssh 本地命令：在自己电脑上把 vpssh 装到 VPS 上（以及升级、卸载）
//
//   npx vpssh install root@1.2.3.4 [--domain vps.example.com] [--mirror cn]
//
// 做的事就是替你 SSH 上去，执行服务器上的一键安装命令，装完自动打开浏览器进初始设置。
// 登录用你电脑上的 ssh（密码、钥匙、known_hosts 都由 ssh 自己处理，这里不经手）。
// 零依赖：Node 18+ 和系统自带的 ssh（macOS、Linux、Windows 10+ 都有）。
"use strict";

const { spawn, spawnSync } = require("node:child_process");

const REPO = "AIcivilization/vpssh";
// VPSSH_INSTALL_URL：开发测试时换成别的地址
const INSTALL_URL = process.env.VPSSH_INSTALL_URL || `https://github.com/${REPO}/releases/latest/download/install.sh`;
const VERSION = require("../package.json").version;

/** 中文环境（LANG / LC_ALL，或系统区域设置）用中文，否则英文 */
function isZh(env = process.env) {
	const lang = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	if (lang && !/^(C|POSIX)(\.|$)/.test(lang)) return /^zh/i.test(lang);
	try {
		return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale);
	} catch {
		return false;
	}
}
const ZH = isZh();
const M = (zh, en) => (ZH ? zh : en);

function usage() {
	return M(
		`vpssh ${VERSION} · 在自己电脑上把 vpssh 装到 VPS 上

用法：
  npx vpssh install <用户@服务器> [选项]     安装（装完自动打开浏览器进初始设置）
  npx vpssh upgrade <用户@服务器>            升到最新发布版
  npx vpssh uninstall <用户@服务器> [--delete-data]
  npx vpssh setup-url <用户@服务器>          重新取初始设置链接

服务器要求：Ubuntu 22.04+ 或 Debian 12+；用 root，或能 sudo 的账号。

SSH 选项：
  -p <端口>          SSH 端口（默认 22）
  -i <私钥文件>      SSH 私钥
  也可以直接写 ~/.ssh/config 里的主机名

安装选项（原样交给服务器上的安装脚本）：
  --domain <域名>    访问域名（先把 A 记录解析到服务器）
  --mirror cn        服务器在国内：从国内镜像下载
  --ip <IP>          不用域名时用这个 IP 访问
  --port <端口>      浏览器访问的端口
  --ref <版本>       装指定版本（标签或分支，默认最新发布版）
  --no-open          装完不自动打开浏览器

例子：
  npx vpssh install root@203.0.113.10
  npx vpssh install ubuntu@203.0.113.10 -i ~/.ssh/id_ed25519 --domain vps.example.com
`,
		`vpssh ${VERSION} · Install vpssh on a VPS from your own computer

Usage:
  npx vpssh install <user@server> [options]   Install (then opens the browser for first-time setup)
  npx vpssh upgrade <user@server>             Upgrade to the latest release
  npx vpssh uninstall <user@server> [--delete-data]
  npx vpssh setup-url <user@server>           Get the first-time setup link again

The server needs Ubuntu 22.04+ or Debian 12+, and root or an account that can sudo.

SSH options:
  -p <port>          SSH port (default 22)
  -i <key file>      SSH private key
  A host name from ~/.ssh/config works too

Install options (passed to the installer on the server):
  --domain <domain>  Address to use (point its A record at the server first)
  --mirror cn        Server in mainland China: download from mirrors there
  --ip <IP>          Without a domain, use this IP
  --port <port>      Port the browser uses
  --ref <version>    Install this tag or branch (default: the latest release)
  --no-open          Do not open the browser afterwards

Examples:
  npx vpssh install root@203.0.113.10
  npx vpssh install ubuntu@203.0.113.10 -i ~/.ssh/id_ed25519 --domain vps.example.com
`,
	);
}

class UsageError extends Error {}

/** 解析命令行。返回 { command, target, ssh: [...ssh 参数], install: [...安装脚本参数], ref, open, deleteData } */
function parseArgs(argv) {
	const out = { command: "", target: "", ssh: [], install: [], ref: "", open: true, deleteData: false };
	const args = [...argv];
	const need = (flag) => {
		const v = args.shift();
		if (v === undefined || v === "") throw new UsageError(M(`${flag} 需要一个值`, `${flag} needs a value`));
		return v;
	};
	while (args.length) {
		const a = args.shift();
		switch (a) {
			case "-h":
			case "--help":
				return { command: "help" };
			case "-v":
			case "--version":
				return { command: "version" };
			case "-p":
				out.ssh.push("-p", need(a));
				break;
			case "-i":
				out.ssh.push("-i", need(a));
				break;
			case "--domain":
			case "--mirror":
			case "--ip":
			case "--port":
				out.install.push(a, need(a));
				break;
			case "--ref":
				out.ref = need(a);
				break;
			case "--no-open":
				out.open = false;
				break;
			case "--delete-data":
				out.deleteData = true;
				break;
			default:
				if (a.startsWith("-")) throw new UsageError(M(`不认识的选项：${a}（npx vpssh --help 看用法）`, `Unknown option: ${a} (see npx vpssh --help)`));
				if (!out.command) out.command = a;
				else if (!out.target) out.target = a;
				else throw new UsageError(M(`多出来的参数：${a}`, `Unexpected argument: ${a}`));
		}
	}
	if (!out.command) return { command: "help" };
	if (!["install", "upgrade", "uninstall", "setup-url"].includes(out.command))
		throw new UsageError(M(`不认识的命令：${out.command}（npx vpssh --help 看用法）`, `Unknown command: ${out.command} (see npx vpssh --help)`));
	if (!out.target) throw new UsageError(M("要写上服务器，比如 root@203.0.113.10", "Name the server, e.g. root@203.0.113.10"));
	if (out.target.startsWith("-") || /\s/.test(out.target)) throw new UsageError(M(`服务器写法不对：${out.target}`, `Not a server address: ${out.target}`));
	if (out.ref && !/^[A-Za-z0-9._/-]+$/.test(out.ref)) throw new UsageError(M(`版本写法不对：${out.ref}`, `Not a version: ${out.ref}`));
	return out;
}

/** 单引号包起来，交给远端 shell */
function shq(s) {
	return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 登录的是不是 root（看 user@ 部分；~/.ssh/config 的别名看不出来，远端再判断一次） */
function remoteCommand(opts, { zh = ZH } = {}) {
	const lang = zh ? "zh_CN.UTF-8" : "C.UTF-8";
	// 远端用 sh 跑：root 直接执行，不是 root 就 sudo（-t 分配了终端，sudo 要密码会在这里问）
	const asRoot = `if [ "$(id -u)" = 0 ]; then S=; else S=sudo; fi`;
	if (opts.command === "install") {
		const env = [`LANG=${lang}`];
		if (opts.ref) env.push(`VPSSH_REF=${shq(opts.ref)}`);
		const args = opts.install.map(shq).join(" ");
		return [
			asRoot,
			`t=$(mktemp) || exit 1`,
			`if command -v curl >/dev/null 2>&1; then curl -fsSL ${shq(INSTALL_URL)} -o "$t"; else wget -qO "$t" ${shq(INSTALL_URL)}; fi || { echo ${shq(M("下载安装脚本失败：", "Could not download the installer: ") + INSTALL_URL)} >&2; rm -f "$t"; exit 1; }`,
			`$S env ${env.join(" ")} bash "$t"${args ? " " + args : ""}; r=$?; rm -f "$t"; exit $r`,
		].join("; ");
	}
	const sub = { upgrade: "upgrade", uninstall: opts.deleteData ? "uninstall --delete-data" : "uninstall", "setup-url": "setup-url" }[opts.command];
	return [
		asRoot,
		`command -v vpssh >/dev/null 2>&1 || { echo ${shq(M("这台服务器上没有装 vpssh", "vpssh is not installed on this server"))} >&2; exit 1; }`,
		`$S env LANG=${lang} vpssh ${sub}`,
	].join("; ");
}

/** 从安装输出里取要打开的地址：带令牌的初始设置链接优先，否则「打开 / Open」那一行 */
function findOpenUrl(text) {
	const plain = String(text).replace(/\x1b\[[0-9;]*m/g, "");
	const setup = plain.match(/https:\/\/[^\s]+\/setup\?token=[A-Za-z0-9_-]+/g);
	if (setup) return setup[setup.length - 1];
	const open = plain.match(/(?:打开|Open)\s*:\s*(https:\/\/\S+)/g);
	if (open) return open[open.length - 1].replace(/^.*?(https:\/\/)/, "$1");
	return "";
}

function openBrowser(url) {
	const [cmd, args] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}

function hasSsh() {
	const r = spawnSync("ssh", ["-V"], { stdio: "ignore" });
	return !r.error;
}

function run(opts) {
	if (!hasSsh()) {
		console.error(M("找不到 ssh 命令。macOS、Linux 自带；Windows 在「设置 → 可选功能」里装 OpenSSH 客户端。", "No ssh command found. macOS and Linux have it; on Windows add the OpenSSH Client under Settings → Optional features."));
		return Promise.resolve(1);
	}
	const sshArgs = ["-t", ...opts.ssh, "-o", "ServerAliveInterval=30", opts.target, `sh -c ${shq(remoteCommand(opts))}`]; // 远端登录 shell 可能是 zsh、fish：统一交给 sh
	if (opts.command === "install") console.log(M(`连接 ${opts.target}，开始安装 vpssh（需要几分钟）…`, `Connecting to ${opts.target} to install vpssh (takes a few minutes)…`));
	return new Promise((resolve) => {
		// 输出原样显示，同时留一份找打开地址；stdin 交给 ssh（密码、sudo、确认都在这里答）
		const child = spawn("ssh", sshArgs, { stdio: ["inherit", "pipe", "inherit"] });
		let tail = "";
		child.stdout.on("data", (chunk) => {
			process.stdout.write(chunk);
			tail = (tail + chunk.toString("utf8")).slice(-16384);
		});
		child.on("error", (err) => {
			console.error(err.message);
			resolve(1);
		});
		child.on("close", (code) => {
			const url = findOpenUrl(tail);
			if (opts.command === "install" || opts.command === "setup-url") {
				if (code === 0 && url && opts.open) {
					console.log(M(`\n正在用浏览器打开：${url}`, `\nOpening in your browser: ${url}`));
					openBrowser(url);
				} else if (code === 3) {
					console.log(M("\n已装好，但服务还在启动。过一会儿打开上面的地址；还不行就：npx vpssh setup-url " + opts.target, "\nInstalled, but still starting. Open the address above in a moment; if it still fails: npx vpssh setup-url " + opts.target));
				} else if (code === 255) {
					console.error(M("\nSSH 没连上：检查地址、端口（-p）、账号和密码或私钥（-i）。", "\nSSH could not connect: check the address, port (-p), user, and password or key (-i)."));
				}
			}
			resolve(code ?? 1);
		});
	});
}

async function main(argv) {
	let opts;
	try {
		opts = parseArgs(argv);
	} catch (err) {
		if (err instanceof UsageError) {
			console.error(err.message);
			return 2;
		}
		throw err;
	}
	if (opts.command === "help") {
		process.stdout.write(usage());
		return 0;
	}
	if (opts.command === "version") {
		console.log(VERSION);
		return 0;
	}
	return run(opts);
}

module.exports = { parseArgs, remoteCommand, findOpenUrl, shq, isZh, INSTALL_URL };

if (require.main === module) {
	main(process.argv.slice(2)).then((code) => process.exit(code));
}
