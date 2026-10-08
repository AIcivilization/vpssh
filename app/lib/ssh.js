// lib/ssh.js — SSH 登录与执行（ssh2，纯 JS，Mac / Windows 一样）
//
// 登录方式按顺序都试：选的私钥 / ~/.ssh 里常见的私钥 → ssh-agent → 密码 → 键盘交互（填密码）。
// 主机指纹：第一次连上记下来（和 ssh 的 known_hosts 一个意思），以后对不上就拒绝连接。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { Client, utils } = require("ssh2");
const { defaultKeys } = require("./remote.js");

class SshError extends Error {
	constructor(code, zh, en) {
		super(en);
		this.code = code;
		this.zh = zh;
		this.en = en;
	}
}

const fingerprint = (key) => "SHA256:" + crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

function agentSocket() {
	if (process.platform === "win32") return "\\\\.\\pipe\\openssh-ssh-agent";
	return process.env.SSH_AUTH_SOCK || "";
}

/** 能用的私钥（加了口令的私钥：有填密码就当口令试，没有就跳过） */
function loadKeys(keyPath, password) {
	const out = [];
	for (const file of defaultKeys(keyPath)) {
		let buf;
		try {
			buf = fs.readFileSync(file);
		} catch {
			if (keyPath) throw new SshError("key_read", `读不到私钥文件：${file}`, `Cannot read the key file: ${file}`);
			continue;
		}
		let parsed = utils.parseKey(buf);
		let passphrase;
		if (parsed instanceof Error && password) {
			parsed = utils.parseKey(buf, password);
			passphrase = password;
		}
		if (parsed instanceof Error) {
			if (keyPath) throw new SshError("key_parse", "私钥读不出来（加了口令的话，把口令填在密码框里）", "Cannot use that key (if it has a passphrase, enter it in the password box)");
			continue;
		}
		out.push({ key: buf, passphrase });
	}
	return out;
}

/**
 * 连上服务器。knownFingerprint：之前记下的主机指纹（没有就是第一次连，记下新的）。
 * 返回 { conn, fingerprint }
 */
function connect({ host, port, user, password, keyPath }, { knownFingerprint = "", timeoutMs = 20000 } = {}) {
	const keys = loadKeys(keyPath, password);
	const methods = keys.map((k) => ({ type: "publickey", username: user, key: k.key, passphrase: k.passphrase }));
	const agent = agentSocket();
	if (agent && !keyPath) methods.push({ type: "agent", username: user, agent });
	if (password) {
		methods.push({ type: "password", username: user, password });
		methods.push({
			type: "keyboard-interactive",
			username: user,
			prompt: (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => password)),
		});
	}
	if (!methods.length) {
		return Promise.reject(new SshError("no_auth", "填上密码，或者选一个私钥文件", "Enter the password, or choose a key file"));
	}
	return new Promise((resolve, reject) => {
		const conn = new Client();
		let seen = "";
		let mismatch = false;
		conn.on("ready", () => resolve({ conn, fingerprint: seen }));
		conn.on("error", (err) => {
			if (mismatch) {
				reject(new SshError("host_key", `服务器的身份指纹变了（以前 ${knownFingerprint}，现在 ${seen}）。如果服务器重装过系统，这是正常的：在服务器列表里删掉它再重新添加；否则可能有人冒充这台服务器，不要继续`, `The server's fingerprint changed (was ${knownFingerprint}, now ${seen}). Normal if the server was reinstalled: remove it from the list and add it again; otherwise someone may be impersonating it, so stop here`));
			} else if (err.level === "client-authentication") {
				reject(new SshError("auth", "登录被拒绝：用户名、密码或私钥不对", "Login refused: wrong user name, password or key"));
			} else if (err.level === "client-timeout" || /timed out/i.test(err.message)) {
				reject(new SshError("timeout", "连接超时：检查 IP、SSH 端口，以及云厂商安全组是否放行了 SSH 端口", "Connection timed out: check the IP and SSH port, and that the provider's security group allows the SSH port"));
			} else if (err.code === "ECONNREFUSED") {
				reject(new SshError("refused", "连接被拒绝：SSH 端口不对，或服务器上 SSH 没开", "Connection refused: wrong SSH port, or SSH is not running on the server"));
			} else if (err.code === "ENOTFOUND" || err.code === "EAI_AGAIN") {
				reject(new SshError("dns", "找不到这个服务器地址", "Cannot find that server address"));
			} else {
				reject(new SshError("ssh", `SSH 连接失败：${err.message}`, `SSH connection failed: ${err.message}`));
			}
		});
		const queue = [...methods];
		conn.connect({
			host,
			port,
			username: user,
			readyTimeout: timeoutMs,
			keepaliveInterval: 15000,
			keepaliveCountMax: 4,
			authHandler: (_methodsLeft, _partial, next) => next(queue.shift() || false),
			hostVerifier: (key) => {
				seen = fingerprint(key);
				if (knownFingerprint && knownFingerprint !== seen) {
					mismatch = true;
					return false;
				}
				return true;
			},
		});
	});
}

/** 执行一条命令；stdin 文本写进去后关上。onData 收 stdout+stderr 的文本。返回 { code, out } */
function exec(conn, command, { stdin = "", onData } = {}) {
	return new Promise((resolve, reject) => {
		conn.exec(command, (err, stream) => {
			if (err) return reject(err);
			let out = "";
			const take = (d) => {
				const s = d.toString("utf8");
				out += s;
				if (out.length > 4_000_000) out = out.slice(-2_000_000);
				onData?.(s);
			};
			stream.on("data", take);
			stream.stderr.on("data", take);
			stream.on("close", (code) => resolve({ code: code ?? null, out }));
			stream.on("error", reject);
			stream.end(stdin);
		});
	});
}

/**
 * 以 root 执行一段脚本（经 stdin 交给 sh -s）：
 * 本来就是 root 直接跑；免密 sudo 用 sudo -n；否则先用密码验证 sudo，再经 sudo -S 跑
 * （密码在 stdin 的第一行，sudo 读走这一行，剩下的才是脚本）。
 */
async function runAsRoot(conn, script, { password = "", onData } = {}) {
	const probe = await exec(conn, "id -u; sudo -n true >/dev/null 2>&1 && echo VPSSH_NOPASS");
	if (/^0\s*$/m.test(probe.out.split("\n")[0] + "\n")) return exec(conn, "sh -s", { stdin: script, onData });
	if (probe.out.includes("VPSSH_NOPASS")) return exec(conn, "sudo -n sh -s", { stdin: script, onData });
	if (!password) throw new SshError("need_root", "这个账号不是 root：要么用 root 登录，要么填上它的密码（用来 sudo）", "This account is not root: log in as root, or enter its password (used for sudo)");
	const check = await exec(conn, "sudo -S -p '' -v", { stdin: password + "\n" });
	if (check.code !== 0) throw new SshError("sudo", "这个账号不能 sudo（或密码不对）。用 root 登录试试", "This account cannot sudo (or the password is wrong). Try logging in as root");
	return exec(conn, "sudo -S -p '' sh -s", { stdin: password + "\n" + script, onData });
}

module.exports = { connect, exec, runAsRoot, fingerprint, SshError };
