// lib/ssh.js — SSH 登录与执行（ssh2，纯 JS，Mac / Windows 一样）
//
// 登录方式（界面上三选一）：
//   password：密码 + 键盘交互（填同一个密码）
//   key     ：粘贴的私钥或选的私钥文件（有口令填口令）
//   local   ：桌面版专用的本机密钥（lib/localkey.js）+ ~/.ssh 里常见的几把 + ssh-agent
// 主机指纹：第一次连上记下来（和 ssh 的 known_hosts 一个意思），以后对不上就拒绝连接。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { Client, utils } = require("ssh2");
const { defaultKeys } = require("./remote.js");
const { localKeysFor } = require("./localkeys.js");

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

/** 能用的私钥（加了口令的私钥：有口令就试，没有就跳过）。extra：额外先试的私钥文件（本机密钥） */
function loadKeys(keyPath, password, extra = []) {
	const out = [];
	for (const file of [...extra.filter((f) => f && fs.existsSync(f)), ...defaultKeys(keyPath)]) {
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
function connect({ host, port, user, password, keyPath, auth, privateKey, passphrase, localKeyFile, preferredKey }, { knownFingerprint = "", timeoutMs = 20000 } = {}) {
	const mode = auth || (keyPath ? "key" : password ? "password" : "local");
	const methods = [];
	if (mode === "key" && privateKey) {
		let parsed = utils.parseKey(Buffer.from(privateKey), passphrase || undefined);
		if (Array.isArray(parsed)) parsed = parsed[0];
		if (parsed instanceof Error) {
			const encrypted = /encrypted|passphrase/i.test(parsed.message);
			return Promise.reject(encrypted
				? new SshError("key_parse", passphrase ? "私钥口令不对" : "这把私钥设了口令：把口令填在「私钥口令」里", passphrase ? "Wrong key passphrase" : "This key has a passphrase: enter it under Key passphrase")
				: new SshError("key_parse", "私钥读不出来：确认粘贴的是完整的私钥文件内容；PuTTY 的 .ppk 要先用 PuTTYgen 导出为 OpenSSH 格式", "Cannot read that key: paste the whole private key file; convert a PuTTY .ppk to OpenSSH format with PuTTYgen first"));
		}
		methods.push({ type: "publickey", username: user, key: Buffer.from(privateKey), passphrase: passphrase || undefined, label: "pasted" });
	} else if (mode === "key") {
		for (const k of loadKeys(keyPath, passphrase || password)) methods.push({ type: "publickey", username: user, key: k.key, passphrase: k.passphrase, label: keyPath });
	} else if (mode === "local") {
		// 这台电脑上已有的钥匙，越具体越靠前（见 localkeys.js），最后是 ssh-agent
		for (const k of localKeysFor(host, { preferred: preferredKey, appKey: localKeyFile })) {
			methods.push({ type: "publickey", username: user, key: k.key, label: k.label, path: k.path, isApp: k.isApp });
		}
		const agent = agentSocket();
		if (agent) methods.push({ type: "agent", username: user, agent, label: "ssh-agent" });
	}
	if (mode === "password" && password) {
		methods.push({ type: "password", username: user, password });
		methods.push({
			type: "keyboard-interactive",
			username: user,
			prompt: (_name, _instr, _lang, prompts, finish) => finish(prompts.map(() => password)),
		});
	}
	if (!methods.length) {
		return Promise.reject(mode === "local"
			? new SshError("no_key", "这台电脑上还没有可用的密钥：先点「生成本机密钥」，把公钥加到服务器上", "No key on this computer yet: click Generate a key, then add its public key to the server")
			: new SshError("no_auth", "填上密码，或者选一个私钥", "Enter the password, or choose a private key"));
	}
	return new Promise((resolve, reject) => {
		const conn = new Client();
		let seen = "";
		let mismatch = false;
		let allowed = null; // 服务器说它接受哪些登录方式（第一次失败后才知道）
		let current = null; // 正在试的那一种（登录成功后告诉调用方用的是哪把钥匙）
		conn.on("ready", () => resolve({ conn, fingerprint: seen, keyLabel: current?.label || "", keyPath: current?.path || "", keyIsApp: Boolean(current?.isApp) }));
		conn.on("error", (err) => {
			if (mismatch) {
				reject(new SshError("host_key", `服务器的身份指纹变了（以前 ${knownFingerprint}，现在 ${seen}）。如果服务器重装过系统，这是正常的：在服务器列表里删掉它再重新添加；否则可能有人冒充这台服务器，不要继续`, `The server's fingerprint changed (was ${knownFingerprint}, now ${seen}). Normal if the server was reinstalled: remove it from the list and add it again; otherwise someone may be impersonating it, so stop here`));
			} else if (err.level === "client-authentication") {
				const noPassword = allowed && !allowed.includes("password") && !allowed.includes("keyboard-interactive");
				if (mode === "password" && noPassword) {
					reject(new SshError("key_only", "这台服务器关掉了密码登录，只认密钥：登录方式改用「私钥」或「本机密钥」", "This server has password login turned off and only accepts keys: switch to Private key or This computer's key"));
				} else if (mode === "local") {
					const tried = methods.map((m) => (m.isApp ? "vpssh 本机密钥" : m.label)).join("、");
					const triedEn = methods.map((m) => (m.isApp ? "vpssh key" : m.label)).join(", ");
					reject(new SshError("auth", `服务器不认这台电脑上的钥匙（试了：${tried}）。把 vpssh 本机密钥的公钥加到服务器上（见下面的说明），或者检查用户名`, `The server accepted none of this computer's keys (tried: ${triedEn}). Add the vpssh key's public key to the server (see the steps below), or check the user name`));
				} else if (mode === "key") {
					reject(new SshError("auth", "服务器不认这把私钥：确认它对应的公钥在服务器上，以及用户名对不对（有的云厂商默认用户是 ubuntu、debian、admin）", "The server does not accept this key: check that its public key is on the server and the user name is right (some providers use ubuntu, debian or admin)"));
				} else {
					reject(new SshError("auth", "登录被拒绝：用户名或密码不对", "Login refused: wrong user name or password"));
				}
			} else if (/before handshake|ECONNRESET/i.test(`${err.message} ${err.code || ""}`)) {
				reject(new SshError("handshake", "连上了，但还没开始登录就被服务器断开。常见原因：IP 或 SSH 端口不对（连到了别的服务）；服务器的 fail2ban 等把你的 IP 封了（密码输错几次后常见，等一会儿或换网络再试）；本机的代理 / VPN 拦了 SSH", "Connected, but the server dropped the connection before login started. Usually: wrong IP or SSH port (another service answered); fail2ban or similar banned your IP (common after a few wrong passwords; wait or try another network); a proxy or VPN on this computer is blocking SSH"));
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
			authHandler: (methodsLeft, _partial, next) => {
				if (Array.isArray(methodsLeft)) allowed = methodsLeft;
				current = queue.shift() || null;
				if (!current) return next(false);
				const { label: _l, path: _p, isApp: _a, ...method } = current;
				next(method);
			},
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
	if (!password) throw new SshError("need_root", "这个账号不是 root，也不能免密 sudo：改用 root 登录；或者用密码登录这个账号（密码会用来 sudo）", "This account is not root and cannot sudo without a password: log in as root, or log in to this account with its password (used for sudo)");
	const check = await exec(conn, "sudo -S -p '' -v", { stdin: password + "\n" });
	if (check.code !== 0) throw new SshError("sudo", "这个账号不能 sudo（或密码不对）。用 root 登录试试", "This account cannot sudo (or the password is wrong). Try logging in as root");
	return exec(conn, "sudo -S -p '' sh -s", { stdin: password + "\n" + script, onData });
}

module.exports = { connect, exec, runAsRoot, fingerprint, SshError };
