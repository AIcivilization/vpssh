// lib/remote.js — 经 SSH 把 vpssh 装到（或卸出）一台 VPS
//
// 桌面版的「安装到 VPS」表单填好后调用。要点：
//   - 密码只在这次任务的内存里：用来 SSH 登录、必要时交给 sudo；不写盘、不进日志。任务结束就丢
//   - 不填密码就用本机的 SSH 密钥（选的私钥文件，或 ~/.ssh 里常见的几把，或 ssh-agent）
//   - 安装在服务器上后台运行（nohup setsid），日志写 /var/log/vpssh-install.log，这边只是 tail 它。
//     SSH 中途断开，安装照样跑完；这边自动重连接着看
//   - 装完再经 SSH 读两样东西：访问地址（gate.env）和 Caddy 自签证书的根证书（用 IP 访问时，
//     桌面版只信任这一张根证书，不弹「不安全」）
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = "AIcivilization/vpssh";
const INSTALL_URL = process.env.VPSSH_INSTALL_URL || `https://github.com/${REPO}/releases/latest/download/install.sh`;
const LOGS = { install: "/var/log/vpssh-install.log", uninstall: "/var/log/vpssh-uninstall.log" };
const CADDY_ROOT = "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt";

const HOST_RE = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|[0-9A-Fa-f:.]+)$/;
const DOMAIN_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const USER_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;

/** 校验并规整表单。返回 { value } 或 { error: [中文, English] } */
function validate(body) {
	const b = body && typeof body === "object" ? body : {};
	const action = b.action === "uninstall" ? "uninstall" : "install";
	const host = String(b.host ?? "").trim().replace(/^\[|\]$/g, "");
	const port = Number(b.port ?? 22);
	const user = String(b.user ?? "root").trim() || "root";
	const password = typeof b.password === "string" ? b.password : "";
	const keyPath = typeof b.keyPath === "string" ? b.keyPath.trim() : "";
	const domain = action === "install" ? String(b.domain ?? "").trim().toLowerCase() : "";
	const mirror = action === "install" && b.mirror === true;
	const deleteData = action === "uninstall" && b.deleteData === true;
	if (!host || host.length > 253 || !HOST_RE.test(host)) return { error: ["服务器地址格式不对（填公网 IP 或能解析到它的域名）", "Not a server address (use the public IP, or a name that resolves to it)"] };
	if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: ["SSH 端口应为 1–65535", "The SSH port must be 1–65535"] };
	if (!USER_RE.test(user)) return { error: ["用户名格式不对", "Not a valid user name"] };
	if (password.length > 1024) return { error: ["密码太长", "Password too long"] };
	if (domain && (domain.length > 253 || !DOMAIN_RE.test(domain))) return { error: ["访问域名格式不对（例如 vps.example.com）", "Not a valid domain (e.g. vps.example.com)"] };
	return { value: { action, host, port, user, password, keyPath, domain, mirror, deleteData } };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** 交给安装脚本的参数 */
function installArgs({ domain, mirror }) {
	// VPSSH_DEV_INSTALL_ARGS：只给开发测试用（比如测试机用 --ip 127.0.0.1），界面上没有
	const dev = (process.env.VPSSH_DEV_INSTALL_ARGS || "").split(/\s+/).filter(Boolean);
	return [...(domain ? ["--domain", domain] : []), ...(mirror ? ["--mirror", "cn"] : []), ...dev];
}

/**
 * 服务器上（已经是 root）执行的脚本，经 stdin 交给 sh -s。
 * 后台独立运行，日志末尾写 VPSSH_EXIT=<退出码>；这边 tail 到进程结束。
 */
function startScript(opts, lang = "en") {
	const log = LOGS[opts.action];
	const env = `LANG=${lang === "zh" ? "zh_CN.UTF-8" : "C.UTF-8"}`;
	let job;
	if (opts.action === "uninstall") {
		job = `command -v vpssh >/dev/null 2>&1 || { echo "VPSSH_ERR=not_installed"; exit 0; }; env ${env} vpssh uninstall --yes${opts.deleteData ? " --delete-data" : ""}`;
	} else {
		const args = installArgs(opts).map(shq).join(" ");
		job = `T=$(mktemp) && $F ${shq(INSTALL_URL)} >"$T" && env ${env} bash "$T"${args ? " " + args : ""}; R=$?; rm -f "$T"; exit $R`;
	}
	// 任务放在子 shell ( ) 里：里面的 exit 只退出子 shell，后面才写得上 VPSSH_EXIT（用 { } 会整个退出，实测）
	return [
		"set -u",
		'if command -v curl >/dev/null 2>&1; then F="curl -fsSL"; elif command -v wget >/dev/null 2>&1; then F="wget -qO-"; else echo "VPSSH_ERR=no_fetch"; exit 4; fi',
		`L=${log}`,
		'rm -f "$L"',
		`nohup setsid sh -c ${shq(`F="$1"; ( ${job} ); echo "VPSSH_EXIT=$?"`)} vpssh "$F" >>"$L" 2>&1 </dev/null &`,
		"P=$!",
		'echo "$P" >"$L.pid"',
		'for i in 1 2 3 4 5 6 7 8 9 10; do [ -f "$L" ] && break; sleep 1; done',
		'echo "VPSSH_STARTED"',
		'tail -n +1 -f --pid="$P" "$L" 2>/dev/null',
	].join("\n") + "\n";
}

/** 断线后重新接上：从头读日志，进程还在就继续跟 */
function attachScript(action) {
	const log = LOGS[action];
	return [
		`L=${log}`,
		'[ -f "$L" ] || { echo "VPSSH_ERR=no_log"; exit 0; }',
		'P=$(cat "$L.pid" 2>/dev/null)',
		'if [ -n "$P" ] && kill -0 "$P" 2>/dev/null; then tail -n +1 -f --pid="$P" "$L"; else cat "$L"; fi',
	].join("\n") + "\n";
}

/** 装完读：访问地址、是否有一次性令牌、Caddy 根证书 */
const INFO_SCRIPT = [
	"echo VPSSH_INFO_BEGIN",
	"sed -n 's/^DSH_TRUSTED_HOST=//p' /opt/vpssh/state/gate.env 2>/dev/null | head -1 | sed 's/^/HOST=/'",
	`if [ -f ${CADDY_ROOT} ]; then echo CERT_BEGIN; cat ${CADDY_ROOT}; echo CERT_END; fi`,
	"echo VPSSH_INFO_END",
].join("\n") + "\n";

function parseInfo(text) {
	const s = String(text);
	const host = (s.match(/^HOST=(\S+)$/m) || [])[1] || "";
	const cert = (s.match(/CERT_BEGIN\n([\s\S]*?-----END CERTIFICATE-----)\s*\nCERT_END/) || [])[1] || "";
	return { host, rootPem: cert.trim() };
}

const strip = (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");

/** 从安装日志取：进度（步骤 N/M）、带令牌的设置链接、「打开」地址、退出码 */
function parseLog(text) {
	const s = strip(text);
	let step = 0, total = 0;
	for (const m of s.matchAll(/(?:步骤|Step) (\d+)\/(\d+)/g)) { step = Number(m[1]); total = Number(m[2]); }
	const setup = s.match(/https:\/\/\S+\/setup\?token=[A-Za-z0-9_-]+/g);
	const open = s.match(/(?:打开|Open)\s*:\s*(https:\/\/\S+)/);
	const exit = s.match(/^VPSSH_EXIT=(\d+)/m);
	const err = s.match(/^VPSSH_ERR=(\w+)/m);
	return {
		step, total,
		setupUrl: setup ? setup[setup.length - 1] : "",
		openUrl: open ? open[1] : "",
		exitCode: exit ? Number(exit[1]) : null,
		error: err ? err[1] : "",
	};
}

/** 默认私钥：选了就用选的；否则 ~/.ssh 里常见的几把，按顺序都试 */
function defaultKeys(keyPath) {
	if (keyPath) return [keyPath.replace(/^~(?=$|[\\/])/, os.homedir())];
	const dir = path.join(os.homedir(), ".ssh");
	return ["id_ed25519", "id_ecdsa", "id_rsa"].map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
}

module.exports = { validate, installArgs, startScript, attachScript, INFO_SCRIPT, parseInfo, parseLog, strip, shq, defaultKeys, INSTALL_URL, LOGS, CADDY_ROOT };
