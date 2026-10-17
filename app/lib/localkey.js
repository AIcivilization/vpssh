// lib/localkey.js — 本机密钥：vpssh 桌面版专用的一把 SSH 密钥（ed25519，无口令）
//
// 放在应用数据目录的 ssh/ 下，不碰用户的 ~/.ssh。界面上一键生成，把公钥加到服务器上（云厂商控制台的
// 网页终端里执行一行命令，或在控制台「SSH 密钥」里导入），以后就能免密码登录。私钥不离开这台电脑。
// 生成用 ssh2 自带的实现：不依赖系统的 ssh-keygen（Windows 上不一定有）。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { utils } = require("ssh2");

function keyPath(dir) {
	return path.join(dir, "ssh", "id_ed25519");
}

/** { publicKey, path }；还没生成 publicKey 为 null */
function readLocalKey(dir) {
	const file = keyPath(dir);
	try {
		const publicKey = fs.readFileSync(`${file}.pub`, "utf8").trim();
		if (publicKey && fs.existsSync(file)) return { publicKey, path: file };
	} catch {
		/* 还没有 */
	}
	return { publicKey: null, path: file };
}

/** 生成（已有就直接返回） */
function generateLocalKey(dir) {
	const existing = readLocalKey(dir);
	if (existing.publicKey) return existing;
	const file = keyPath(dir);
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const host = os.hostname().replace(/[^A-Za-z0-9_.-]/g, "") || "desktop";
	const pair = utils.generateKeyPairSync("ed25519", { comment: `vpssh@${host}` });
	fs.writeFileSync(file, pair.private, { mode: 0o600 });
	fs.writeFileSync(`${file}.pub`, `${pair.public.trim()}\n`, { mode: 0o644 });
	return readLocalKey(dir);
}

/** 把公钥加到服务器上的一行命令（公钥只有 base64 和注释，去掉单引号后放进单引号里是安全的） */
function authorizeCommand(publicKey) {
	const safe = String(publicKey).replace(/'/g, "").trim();
	return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${safe}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

module.exports = { keyPath, readLocalKey, generateLocalKey, authorizeCommand };
