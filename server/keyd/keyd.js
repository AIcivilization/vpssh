#!/usr/bin/env node
"use strict";
/**
 * vpssh-keyd：替 vpssh 保管 SSH 私钥的小程序。
 *
 * 为什么要它：vpssh 装在服务器上，DSH 进程（vpssh 用户）跑着 AI。私钥要是放在 vpssh 用户能读的地方，
 * DSH 只要出一次问题，钥匙就能被整个拷走，之后离线也能登录所有被管的机器。
 * keyd 以单独的 vpssh-keys 用户运行，私钥只有它能读；vpssh 这边的 ssh 经 SSH_AUTH_SOCK 请它签名登录，
 * 拿不到私钥本身（就是 ssh-agent 的做法）。
 *
 * 不用 OpenSSH 自带的 ssh-agent：它只接受同一个用户的连接，跨用户用不了。
 * 这里实现 ssh-agent 协议里用得到的最小一部分：列出钥匙（11 → 12）、签名（13 → 14），其余一律回失败（5）。
 * 钥匙只有一把 ed25519。
 *
 * 谁能连：socket 在 /run/vpssh-keys/ 下，目录 0750、socket 0660，属组 vpssh（见 units/vpssh-keyd.service）。
 *
 * 零依赖：只用 node 内置模块。
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const os = require("node:os");

const KEY_DIR = process.env.VPSSH_KEY_DIR || "/var/lib/vpssh-keys";
const KEY_FILE = path.join(KEY_DIR, "vpssh_ed25519");
const SOCKET = process.env.VPSSH_AGENT_SOCK || "/run/vpssh-keys/agent.sock";
const MAX_MESSAGE = 256 * 1024;

const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

function log(message) {
	process.stdout.write(`[keyd ${new Date().toISOString()}] ${message}\n`);
}

/** SSH 线格式里的 string：uint32 长度 + 内容 */
function sshString(buf) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(buf.length);
	return Buffer.concat([len, buf]);
}

function readString(buf, offset) {
	if (offset + 4 > buf.length) throw new Error("truncated");
	const len = buf.readUInt32BE(offset);
	const start = offset + 4;
	if (start + len > buf.length) throw new Error("truncated");
	return { value: buf.subarray(start, start + len), next: start + len };
}

function message(type, payload = Buffer.alloc(0)) {
	const body = Buffer.concat([Buffer.from([type]), payload]);
	const len = Buffer.alloc(4);
	len.writeUInt32BE(body.length);
	return Buffer.concat([len, body]);
}

/** 读入（第一次运行时生成）钥匙。返回 { privateKey, blob, publicLine } */
function loadOrCreateKey(comment) {
	fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o755 });
	let privateKey;
	if (fs.existsSync(KEY_FILE)) {
		privateKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
		if (privateKey.asymmetricKeyType !== "ed25519") throw new Error(`${KEY_FILE} 不是 ed25519 钥匙`);
	} else {
		const pair = crypto.generateKeyPairSync("ed25519");
		privateKey = pair.privateKey;
		const pem = privateKey.export({ format: "pem", type: "pkcs8" });
		fs.writeFileSync(KEY_FILE, pem, { mode: 0o600, flag: "wx" });
		log(`generated a new key: ${KEY_FILE}`);
	}
	const raw = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
	const blob = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(raw)]);
	const publicLine = `ssh-ed25519 ${blob.toString("base64")} ${comment}\n`;
	// 公钥给 vpssh 读：添加机器时要把它放进服务器的 authorized_keys，ssh 也靠它挑钥匙（IdentityFile 指向 .pub）
	const pubFile = `${KEY_FILE}.pub`;
	if (!fs.existsSync(pubFile) || fs.readFileSync(pubFile, "utf8") !== publicLine) {
		fs.writeFileSync(pubFile, publicLine, { mode: 0o644 });
	}
	return { privateKey, blob, publicLine };
}

function handle(key, type, payload) {
	if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
		const count = Buffer.alloc(4);
		count.writeUInt32BE(1);
		return message(SSH_AGENT_IDENTITIES_ANSWER, Buffer.concat([count, sshString(key.blob), sshString(Buffer.from("vpssh"))]));
	}
	if (type === SSH_AGENTC_SIGN_REQUEST) {
		const blob = readString(payload, 0);
		const data = readString(payload, blob.next);
		if (!blob.value.equals(key.blob)) return message(SSH_AGENT_FAILURE);
		const signature = crypto.sign(null, data.value, key.privateKey);
		const sig = Buffer.concat([sshString(Buffer.from("ssh-ed25519")), sshString(signature)]);
		return message(SSH_AGENT_SIGN_RESPONSE, sshString(sig));
	}
	return message(SSH_AGENT_FAILURE);
}

function serve(key) {
	const server = net.createServer((socket) => {
		let pending = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 4) {
				const len = pending.readUInt32BE(0);
				if (len < 1 || len > MAX_MESSAGE) {
					socket.destroy();
					return;
				}
				if (pending.length < 4 + len) break;
				const type = pending[4];
				const payload = pending.subarray(5, 4 + len);
				pending = pending.subarray(4 + len);
				let reply;
				try {
					reply = handle(key, type, payload);
					if (type === SSH_AGENTC_SIGN_REQUEST) log(reply[4] === SSH_AGENT_SIGN_RESPONSE ? "signed a login" : "refused to sign for an unknown key");
				} catch (err) {
					log(`bad request: ${err.message}`);
					reply = message(SSH_AGENT_FAILURE);
				}
				socket.write(reply);
			}
		});
		socket.on("error", () => {});
	});
	try {
		fs.unlinkSync(SOCKET);
	} catch {
		/* 没有旧的 */
	}
	server.listen(SOCKET, () => {
		fs.chmodSync(SOCKET, 0o660);
		log(`listening on ${SOCKET}`);
	});
	const stop = () => server.close(() => process.exit(0));
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	return server;
}

if (require.main === module) {
	const key = loadOrCreateKey(`vpssh@${os.hostname()}`);
	serve(key);
}

module.exports = { loadOrCreateKey, handle, serve, sshString, readString, message, KEY_FILE, SOCKET };
