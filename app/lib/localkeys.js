// lib/localkeys.js — 这台电脑上已有的 SSH 私钥：哪些能拿来登录这台服务器（照 dsh-vpn 0.1.11 的做法）
//
// 只认密钥的服务器，多半已经信任这台电脑上的某把钥匙（比如 dsh-vps-manager 管过的服务器都认
// ~/.ssh/dsh_vps_ed25519）。按这个顺序试，越具体越靠前：
//   1. 上次登录这台服务器成功用的那把（桌面版记下的）
//   2. ~/.ssh/config（及 config.d/）里给这台服务器配的 IdentityFile（按 HostName 或同名的 Host 别名）
//   3. ~/.ssh/dsh_vps_ed25519、id_ed25519、id_ecdsa、id_rsa
//   4. 桌面版自己的本机密钥（lib/localkey.js）
// 带口令的、读不了的直接跳过，不弹窗问。私钥只在主进程里读，界面上只显示文件名。
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { utils } = require("ssh2");

const DEFAULT_KEYS = ["dsh_vps_ed25519", "id_ed25519", "id_ecdsa", "id_rsa"];

function readText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return undefined;
	}
}

/** ~/.ssh/config 和 config.d/ 里的文件，按顺序 */
function configTexts(sshDir) {
	const texts = [];
	const main = readText(path.join(sshDir, "config"));
	if (main !== undefined) texts.push(main);
	let names = [];
	try {
		names = fs.readdirSync(path.join(sshDir, "config.d")).sort();
	} catch {
		/* 没有 */
	}
	for (const name of names) {
		const t = readText(path.join(sshDir, "config.d", name));
		if (t !== undefined) texts.push(t);
	}
	return texts;
}

/** 指向 host 的 Host 块（HostName 等于它，或有个不带通配符的别名就是它）里的 IdentityFile */
function identityFilesFor(host, sshDir, home) {
	const files = [];
	for (const text of configTexts(sshDir)) {
		let patterns = [];
		let hostName;
		let identities = [];
		const flush = () => {
			const literal = patterns.filter((p) => !/[*?!]/.test(p));
			if (literal.length && (hostName === host || literal.includes(host))) files.push(...identities);
		};
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.replace(/\s+#.*$/, "").trim();
			const m = /^(\w+)\s*=?\s*(.+)$/.exec(line);
			if (!m || line.startsWith("#")) continue;
			const key = m[1].toLowerCase();
			const value = m[2].trim().replace(/^"(.*)"$/, "$1");
			if (key === "host" || key === "match") {
				flush();
				patterns = key === "host" ? value.split(/\s+/) : [];
				hostName = undefined;
				identities = [];
			} else if (key === "hostname") {
				hostName = value;
			} else if (key === "identityfile") {
				const expanded = value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value;
				identities.push(path.isAbsolute(expanded) ? expanded : path.join(sshDir, expanded));
			}
		}
		flush();
	}
	return files;
}

/** 显示用的名字：家目录下的写成 ~/… */
function labelOf(file, home) {
	return file.startsWith(home) ? `~${file.slice(home.length).replace(/\\/g, "/")}` : file;
}

/**
 * 能用来登录 host 的私钥（能读、没有口令），越具体越靠前，去重。
 * opts：preferred（上次成功的那把，路径）、appKey（桌面版本机密钥的路径）、sshDir、home
 * 返回 [{ path, label, key: Buffer }]
 */
function localKeysFor(host, opts = {}) {
	const home = opts.home ?? os.homedir();
	const sshDir = opts.sshDir ?? path.join(home, ".ssh");
	const paths = [opts.preferred, ...identityFilesFor(host, sshDir, home), ...DEFAULT_KEYS.map((n) => path.join(sshDir, n)), opts.appKey].filter(Boolean);
	const out = [];
	for (const file of [...new Set(paths)]) {
		let buf;
		try {
			buf = fs.readFileSync(file);
		} catch {
			continue;
		}
		if (!buf.includes("PRIVATE KEY")) continue;
		let parsed = utils.parseKey(buf);
		if (Array.isArray(parsed)) parsed = parsed[0];
		if (parsed instanceof Error) continue; // 有口令或格式不支持：跳过，不弹窗问
		out.push({ path: file, label: labelOf(file, home), isApp: file === opts.appKey, key: buf });
	}
	return out;
}

module.exports = { identityFilesFor, localKeysFor, labelOf, DEFAULT_KEYS };
