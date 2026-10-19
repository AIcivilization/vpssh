// gate/backup.js — 网页上的「备份与恢复」：由 root 执行（vpssh backup-run / restore-run / restore <文件>）
//
// 备份的是 vpssh 的数据：对话和设置（DSH_HOME）、模型来源（.dsh-model）、SSH 配置、登录网关的状态、
// 管机器用的钥匙（vpssh-keyd 保管的私钥）。钥匙在里面，所以下载的备份文件一律加密：
// 用备份时的管理员密码（scrypt 派生 + AES-256-GCM），没有密码打不开；服务器上 vpssh 用户（DSH、AI 跑在它下面）
// 也只拿得到密文——keyd「私钥只有 vpssh-keys 能读」的隔离不因为备份而失效。
//
// 恢复 = 换掉上面这些数据，这台机器自己的东西不动（地址、端口、证书、隧道：config.json、gate.env、vpn*）。
// 先把现在的数据打包留底，再停服务、换数据、起服务、自检；自检不过就换回去。
//
// 网页只写请求文件（state/backup.request、state/restore.request），systemd path 单元以 root 跑这里，
// 和网页升级、卸载同一条路（见 bin/vpssh install-units）。
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const MAGIC = Buffer.from("VPSSHBK1");
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const EXT = ".vpssh-backup";

//#region 加密

function deriveKey(password, salt) {
	return crypto.scryptSync(String(password).normalize("NFC"), salt, 32, SCRYPT);
}

/** 加密：文件头 VPSSHBK1 + salt + iv，正文 AES-256-GCM，末尾 16 字节校验 */
async function encryptFile(inPath, outPath, password) {
	const salt = crypto.randomBytes(SALT_LEN);
	const iv = crypto.randomBytes(IV_LEN);
	const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
	const out = fs.createWriteStream(outPath, { mode: 0o600 });
	out.write(Buffer.concat([MAGIC, salt, iv]));
	await new Promise((resolve, reject) => {
		const input = fs.createReadStream(inPath);
		input.on("error", reject);
		out.on("error", reject);
		input.pipe(cipher).pipe(out, { end: false });
		cipher.on("end", () => {
			out.end(cipher.getAuthTag(), resolve);
		});
	});
}

class BackupError extends Error {
	constructor(code, message) {
		super(message || code);
		this.code = code;
	}
}

/** 解密；密码不对、文件被改过、不是 vpssh 备份都抛 BackupError（code 给界面用） */
async function decryptFile(inPath, outPath, password) {
	const size = fs.statSync(inPath).size;
	if (size < HEADER_LEN + TAG_LEN) throw new BackupError("not_backup", "not a vpssh backup");
	const fd = fs.openSync(inPath, "r");
	const head = Buffer.alloc(HEADER_LEN);
	const tag = Buffer.alloc(TAG_LEN);
	try {
		fs.readSync(fd, head, 0, HEADER_LEN, 0);
		fs.readSync(fd, tag, 0, TAG_LEN, size - TAG_LEN);
	} finally {
		fs.closeSync(fd);
	}
	if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError("not_backup", "not a vpssh backup");
	const salt = head.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
	const iv = head.subarray(MAGIC.length + SALT_LEN);
	const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
	decipher.setAuthTag(tag);
	const out = fs.createWriteStream(outPath, { mode: 0o600 });
	try {
		await new Promise((resolve, reject) => {
			const input = fs.createReadStream(inPath, { start: HEADER_LEN, end: size - TAG_LEN - 1 });
			input.on("error", reject);
			decipher.on("error", reject);
			out.on("error", reject);
			out.on("finish", resolve);
			input.pipe(decipher).pipe(out);
		});
	} catch (err) {
		fs.rmSync(outPath, { force: true });
		// GCM 校验不过：密码不对，或者文件坏了 / 被改过（分不出来，也不该分得出来）
		if (/auth|unable to authenticate/i.test(String(err && err.message))) throw new BackupError("wrong_password", "wrong password or damaged file");
		throw err;
	}
}

//#endregion

//#region 备份里能有什么

/** 备份里允许出现的位置（相对 /）。恢复前逐条核对，别的一律拒绝 */
function dataPaths(root, dshHome) {
	return {
		dsh: (dshHome || "/home/vpssh/.dsh").replace(/^\/+/, ""),
		model: "home/vpssh/.dsh-model",
		ssh: "home/vpssh/.ssh",
		state: path.join(root, "state").replace(/^\/+/, ""),
		keys: "var/lib/vpssh-keys",
	};
}

/** 这台机器自己的东西：恢复时保留现在的（地址、端口、隧道、进行中的请求和状态） */
function keepLocalState(name) {
	return /^(config\.json|gate\.env|setup\.token|setup\.lock|upgrade\.|backup\.|restore\.|uninstall\.)/.test(name) || /^(vpn|wg)/i.test(name);
}

/** 读 tar.gz 的每一条（名字、类型、链接目标），不解开 */
async function listTar(file) {
	const entries = [];
	let buf = Buffer.alloc(0);
	let skip = 0; // 当前条目剩下要跳过的正文
	let longName = null;
	let longLink = null;
	let paxPath = null;
	let paxLink = null;
	let pending = null; // 读 L/K/x 条目的正文
	const str = (b) => b.toString("utf8").replace(/\0.*$/s, "");
	const oct = (b) => parseInt(str(b).trim() || "0", 8);
	const handle = (chunk) => {
		buf = Buffer.concat([buf, chunk]);
		for (;;) {
			if (skip > 0) {
				const n = Math.min(skip, buf.length);
				if (pending) pending.data.push(buf.subarray(0, n));
				buf = buf.subarray(n);
				skip -= n;
				if (skip > 0) return;
				if (pending) {
					const body = Buffer.concat(pending.data).subarray(0, pending.size);
					if (pending.type === "L") longName = str(body);
					else if (pending.type === "K") longLink = str(body);
					else {
						for (const rec of body.toString("utf8").split("\n")) {
							const m = /^\d+ ([^=]+)=(.*)$/s.exec(rec);
							if (m && m[1] === "path") paxPath = m[2];
							if (m && m[1] === "linkpath") paxLink = m[2];
						}
					}
					pending = null;
				}
				continue;
			}
			if (buf.length < 512) return;
			const h = buf.subarray(0, 512);
			buf = buf.subarray(512);
			if (h.every((b) => b === 0)) continue;
			const type = String.fromCharCode(h[156] || 48);
			const size = oct(h.subarray(124, 136));
			const padded = Math.ceil(size / 512) * 512;
			if (type === "L" || type === "K" || type === "x") {
				pending = { type, size, data: [] };
				skip = padded;
				continue;
			}
			if (type === "g") {
				skip = padded;
				continue;
			}
			const prefix = str(h.subarray(345, 500));
			let name = paxPath || longName || (prefix ? `${prefix}/${str(h.subarray(0, 100))}` : str(h.subarray(0, 100)));
			const link = paxLink || longLink || str(h.subarray(157, 257));
			entries.push({ name, type, link });
			longName = longLink = paxPath = paxLink = null;
			skip = type === "5" || type === "2" || type === "1" ? 0 : padded;
		}
	};
	await new Promise((resolve, reject) => {
		const gunzip = zlib.createGunzip();
		gunzip.on("data", handle);
		gunzip.on("end", resolve);
		gunzip.on("error", () => reject(new BackupError("not_backup", "not a gzip tar")));
		const input = fs.createReadStream(file);
		input.on("error", reject);
		input.pipe(gunzip);
	});
	return entries;
}

/**
 * 核对备份里的每一条：只能在 dataPaths 之内；只能是文件、目录、指向同一块数据之内的链接。
 * 返回备份里有哪几块数据（dsh / model / ssh / state / keys）
 */
function checkEntries(entries, paths) {
	const roots = Object.entries(paths);
	const inside = (p) => roots.find(([, r]) => p === r || p.startsWith(r + "/"));
	const parts = new Set();
	let manifest = false;
	for (const e of entries) {
		const name = e.name.replace(/^\.\//, "").replace(/\/+$/, "");
		if (name === "vpssh-backup.json" && (e.type === "0" || e.type === "\0")) {
			manifest = true;
			continue;
		}
		if (!name || name.startsWith("/") || name.split("/").includes("..")) throw new BackupError("bad_entry", `unsafe path: ${e.name}`);
		const hit = inside(name);
		if (!hit) {
			// 上层目录本身（home、home/vpssh、opt、var/lib…）可以有，不带东西
			if (e.type === "5" && roots.some(([, r]) => r.startsWith(name + "/"))) continue;
			throw new BackupError("bad_entry", `not vpssh data: ${e.name}`);
		}
		parts.add(hit[0]);
		if (e.type === "0" || e.type === "\0" || e.type === "5" || e.type === "7") continue;
		if (e.type === "2") {
			// 软链接（DSH 插件的 node_modules 里有）：只能是相对路径，指向同一块数据之内
			if (!e.link || e.link.startsWith("/")) throw new BackupError("bad_entry", `unsafe link: ${e.name}`);
			const target = path.posix.normalize(path.posix.join(path.posix.dirname(name), e.link));
			if (!(target === hit[1] || target.startsWith(hit[1] + "/"))) throw new BackupError("bad_entry", `unsafe link: ${e.name}`);
			continue;
		}
		if (e.type === "1") {
			const target = e.link.replace(/^\.\//, "");
			if (!inside(target) || target.split("/").includes("..")) throw new BackupError("bad_entry", `unsafe link: ${e.name}`);
			continue;
		}
		throw new BackupError("bad_entry", `unsupported entry type ${JSON.stringify(e.type)}: ${e.name}`);
	}
	if (!manifest) throw new BackupError("not_backup", "vpssh-backup.json missing");
	if (!parts.has("dsh") && !parts.has("state")) throw new BackupError("not_backup", "no vpssh data in the backup");
	return parts;
}

//#endregion

//#region 打包

function readEnvFile(file) {
	const out = {};
	try {
		for (const line of fs.readFileSync(file, "utf8").split("\n")) {
			const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
			if (m) out[m[1]] = m[2];
		}
	} catch {
		/* 没有 */
	}
	return out;
}

function vpsshVersion(root) {
	try {
		return JSON.parse(fs.readFileSync(path.join(root, "state", "config.json"), "utf8")).vpsshVersion || "";
	} catch {
		return "";
	}
}

/** 把数据打成 tar.gz（不加密）。tar 返回 1 = 打包时有文件在变（DSH 在跑），归档仍完整 */
function packData(root, dshHome, outFile, extra = {}) {
	const paths = dataPaths(root, dshHome);
	const present = Object.values(paths).filter((p) => fs.existsSync("/" + p));
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-pack-"));
	try {
		fs.writeFileSync(path.join(tmp, "vpssh-backup.json"), JSON.stringify({ format: 1, vpsshVersion: vpsshVersion(root), host: os.hostname(), createdAt: new Date().toISOString(), ...extra }, null, 2) + "\n");
		// 缓存、临时文件不进备份：重建得出来，还占地方
		const excludes = ["--exclude=home/vpssh/.dsh/vpssh/spill/*", "--exclude=*.request", "--exclude=*.upload"];
		const r = spawnSync("tar", ["-czf", outFile, ...excludes, "-C", tmp, "vpssh-backup.json", "-C", "/", ...present], { stdio: ["ignore", "ignore", "pipe"] });
		if (r.status !== 0 && r.status !== 1) throw new Error(`tar failed (${r.status}): ${String(r.stderr).slice(-300)}`);
		fs.chmodSync(outFile, 0o600);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

//#endregion

//#region 请求与状态（网页轮询）

function writeStatus(stateDir, name, body, owner) {
	const file = path.join(stateDir, `${name}.status.json`);
	fs.writeFileSync(file, JSON.stringify({ ...body, at: Date.now() }) + "\n", { mode: 0o600 });
	if (owner) fs.chownSync(file, owner.uid, owner.gid);
}

/** 读请求文件并立即删掉（里面有密码；path 单元看文件在不在，留着会再触发） */
function takeRequest(stateDir, name) {
	const file = path.join(stateDir, `${name}.request`);
	let body = null;
	try {
		body = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		/* 没有 / 坏了 */
	}
	fs.rmSync(file, { force: true });
	return body;
}

function ownerOf(dir) {
	const st = fs.statSync(dir);
	return { uid: st.uid, gid: st.gid };
}

/** 网页「立即备份」：打包 → 加密 → 放进 backups/download/，交给 vpssh 用户（gate 要能读出来给浏览器下载） */
async function runBackup({ root, dshHome, password, log = () => {} }) {
	const stateDir = path.join(root, "state");
	const owner = ownerOf(stateDir);
	const dlDir = path.join(root, "backups", "download");
	fs.mkdirSync(dlDir, { recursive: true, mode: 0o700 });
	fs.chownSync(dlDir, owner.uid, owner.gid);
	writeStatus(stateDir, "backup", { state: "running" }, owner);
	const work = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-backup-"));
	try {
		if (!password) throw new BackupError("no_password");
		const plain = path.join(work, "data.tar.gz");
		packData(root, dshHome, plain);
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
		const name = `vpssh-${os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "server"}-${stamp}${EXT}`;
		const tmpOut = path.join(dlDir, `.${name}.part`);
		await encryptFile(plain, tmpOut, password);
		for (const old of fs.readdirSync(dlDir)) if (old.endsWith(EXT)) fs.rmSync(path.join(dlDir, old), { force: true });
		const out = path.join(dlDir, name);
		fs.renameSync(tmpOut, out);
		fs.chownSync(out, owner.uid, owner.gid);
		const size = fs.statSync(out).size;
		writeStatus(stateDir, "backup", { state: "success", file: name, size }, owner);
		log(`backup written: ${out} (${size} bytes)`);
		return { file: out, size };
	} catch (err) {
		writeStatus(stateDir, "backup", { state: "failed", error: err.code || "failed", detail: String(err.message).slice(0, 300) }, owner);
		throw err;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

//#endregion

//#region 恢复

function sh(cmd, args, opts = {}) {
	return spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });
}

/** 挪目录；/root 和 /home、/var 可能不在同一块盘上（rename 会 EXDEV），那就复制再删 */
function move(from, to) {
	try {
		fs.renameSync(from, to);
	} catch (err) {
		if (err.code !== "EXDEV") throw err;
		const r = sh("cp", ["-a", from, to]);
		if (r.status !== 0) throw new Error(`cp failed: ${r.stderr.slice(-300)}`);
		fs.rmSync(from, { recursive: true, force: true });
	}
}

function selfcheckOnce(port) {
	return new Promise((resolve) => {
		const req = http.get({ host: "127.0.0.1", port, path: "/gate/selfcheck", timeout: 15_000 }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve(/"pass":\s*true/.test(body)));
		});
		req.on("timeout", () => req.destroy());
		req.on("error", () => resolve(false));
	});
}

async function waitSelfcheck(port, tries = 40) {
	for (let i = 0; i < tries; i++) {
		if (await selfcheckOnce(port)) return true;
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

/** 本机账号的 authorized_keys：换上备份里的钥匙（只从本机能用，和 install.sh 的 add_local_key 一样），去掉被换下的那把 */
function swapLocalKey(localUser, oldPub, newPub) {
	if (!localUser || !newPub) return;
	const home = sh("getent", ["passwd", localUser]).stdout.split(":")[5];
	if (!home) return;
	const file = path.join(home, ".ssh", "authorized_keys");
	const body = (pub) => (pub || "").trim().split(/\s+/)[1] || "";
	let lines = [];
	try {
		lines = fs.readFileSync(file, "utf8").split("\n");
	} catch {
		/* 没有 */
	}
	const oldBody = body(oldPub);
	const newBody = body(newPub);
	if (oldBody && oldBody !== newBody) lines = lines.filter((l) => !l.includes(oldBody));
	if (!lines.some((l) => l.includes(newBody))) {
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		lines.push(`from="127.0.0.1,::1",no-agent-forwarding,no-X11-forwarding ${newPub.trim()}`);
	}
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
	sh("chown", [`${localUser}:`, path.dirname(file), file]);
}

/** 备份来自别的服务器时，known_hosts 里记的「本机」是那台的指纹：去掉，下次连本机重新记 */
function forgetLocalHostKeys(sshDir) {
	const file = path.join(sshDir, "known_hosts");
	if (!fs.existsSync(file)) return;
	for (const h of ["127.0.0.1", "::1", "localhost"]) {
		sh("ssh-keygen", ["-R", h, "-f", file]);
		for (const port of portsIn(file)) sh("ssh-keygen", ["-R", `[${h}]:${port}`, "-f", file]);
	}
	fs.rmSync(file + ".old", { force: true });
}

function portsIn(file) {
	// 哈希过的 known_hosts 看不出端口：常见的几个都试一遍，外加 sshd 当前的端口
	const ports = new Set(["22", "2222"]);
	const t = sh("sshd", ["-T"]).stdout || "";
	for (const m of t.matchAll(/^port (\d+)$/gm)) ports.add(m[1]);
	return ports;
}

/**
 * 恢复。file：加密的备份；password：备份时的管理员密码。
 * 顺序：解密 → 核对 → 现在的数据留底 → 解到临时目录 → 停服务 → 换数据 → 起服务 → 自检（不过就换回去）
 */
async function runRestore({ root, dshHome, file, password, gatePort, log = () => {} }) {
	const stateDir = path.join(root, "state");
	const owner = ownerOf(stateDir);
	const status = (body) => writeStatus(stateDir, "restore", body, owner);
	status({ state: "running", step: "decrypt" });
	const work = fs.mkdtempSync(path.join("/root", ".vpssh-restore-"));
	fs.chmodSync(work, 0o700);
	const paths = dataPaths(root, dshHome);
	const env = readEnvFile(path.join(stateDir, "gate.env"));
	const moved = []; // [现在的位置, 挪到哪] — 失败时挪回去
	let stopped = false;
	try {
		const plain = path.join(work, "data.tar.gz");
		await decryptFile(file, plain, password);
		const parts = checkEntries(await listTar(plain), paths);
		log(`backup ok: ${[...parts].join(", ")}`);

		status({ state: "running", step: "safety-backup" });
		const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
		const safety = path.join(root, "backups", `vpssh-before-restore-${stamp}.tar.gz`);
		packData(root, dshHome, safety, { reason: "before-restore" });
		log(`current data saved to ${safety}`);

		const stage = path.join(work, "stage");
		fs.mkdirSync(stage);
		const x = sh("tar", ["-xzpf", plain, "-C", stage]);
		if (x.status !== 0) throw new Error(`tar extract failed: ${x.stderr.slice(-300)}`);

		status({ state: "running", step: "swap" });
		const oldPub = (() => {
			try {
				return fs.readFileSync(path.join("/", paths.keys, "vpssh_ed25519.pub"), "utf8");
			} catch {
				return "";
			}
		})();
		sh("systemctl", ["stop", "vpssh"]);
		sh("systemctl", ["stop", "vpssh-keyd"]);
		stopped = true;

		const old = path.join(work, "old");
		for (const [part, rel] of Object.entries(paths)) {
			if (!parts.has(part)) continue;
			const live = path.join("/", rel);
			const staged = path.join(stage, rel);
			const keep = path.join(old, rel);
			fs.mkdirSync(path.dirname(keep), { recursive: true });
			if (part === "state") {
				// 网关状态：备份里的账号、会话密钥换上；这台机器自己的（地址、端口、隧道、进行中的请求）留着
				const c = sh("cp", ["-a", live, keep]);
				if (c.status !== 0) throw new Error(`cp failed: ${c.stderr.slice(-300)}`);
				moved.push([live, keep, "copy"]);
				for (const name of fs.readdirSync(staged)) {
					if (keepLocalState(name)) continue;
					fs.rmSync(path.join(live, name), { recursive: true, force: true });
					sh("cp", ["-a", path.join(staged, name), path.join(live, name)]);
				}
				continue;
			}
			if (fs.existsSync(live)) {
				move(live, keep);
				moved.push([live, keep, "move"]);
			} else {
				moved.push([live, null, "new"]);
			}
			fs.mkdirSync(path.dirname(live), { recursive: true });
			move(staged, live);
		}

		// 先清 known_hosts（ssh-keygen 以 root 重写文件），再统一设属主
		if (parts.has("ssh")) forgetLocalHostKeys(path.join("/", paths.ssh));
		// 属主：tar 按名字还原；两台机器的 uid 可能不同，统一再设一遍
		const own = (p, who) => fs.existsSync(p) && sh("chown", ["-R", who, p]);
		own(path.join("/", paths.dsh), "vpssh:vpssh");
		own(path.join("/", paths.model), "vpssh:vpssh");
		own(path.join("/", paths.ssh), "vpssh:vpssh");
		own(stateDir, "vpssh:vpssh");
		own(path.join("/", paths.keys), "vpssh-keys:vpssh");
		if (parts.has("keys")) {
			const newPub = fs.readFileSync(path.join("/", paths.keys, "vpssh_ed25519.pub"), "utf8");
			swapLocalKey(env.VPSSH_LOCAL_USER, oldPub, newPub);
		}

		status({ state: "running", step: "start" });
		sh("systemctl", ["start", "vpssh-keyd"]);
		sh("systemctl", ["start", "vpssh"]);
		if (!(await waitSelfcheck(gatePort))) throw new BackupError("selfcheck", "vpssh did not pass its self-check after the restore");
		stopped = false;
		const uid = sh("id", ["-u", "vpssh"]).stdout.trim();
		if (uid) {
			// 模型来源的后台服务换上恢复的数据
			sh("runuser", ["-u", "vpssh", "--", "env", `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, "systemctl", "--user", "try-restart", "dsh-model-engine.service", "dsh-model-bridge.service"]);
		}
		status({ state: "success", safety: path.basename(safety) });
		log("restore finished");
	} catch (err) {
		if (moved.length) {
			log(`restore failed (${err.message}); putting the previous data back`);
			sh("systemctl", ["stop", "vpssh"]);
			sh("systemctl", ["stop", "vpssh-keyd"]);
			for (const [live, keep, how] of moved.reverse()) {
				fs.rmSync(live, { recursive: true, force: true });
				if (how !== "new") sh("cp", ["-a", keep, live]);
			}
			const own = (p, who) => fs.existsSync(p) && sh("chown", ["-R", who, p]);
			own(path.join("/", paths.dsh), "vpssh:vpssh");
			own(path.join("/", paths.ssh), "vpssh:vpssh");
			own(stateDir, "vpssh:vpssh");
			own(path.join("/", paths.keys), "vpssh-keys:vpssh");
			stopped = true;
		}
		if (stopped) {
			sh("systemctl", ["start", "vpssh-keyd"]);
			sh("systemctl", ["start", "vpssh"]);
		}
		status({ state: "failed", error: err.code || "failed", detail: String(err.message).slice(0, 300), restored: moved.length > 0 });
		throw err;
	} finally {
		fs.rmSync(work, { recursive: true, force: true });
	}
}

//#endregion

//#region 命令行（vpssh backup-run / restore-run / restore <文件>，都以 root 跑）

async function cli(argv) {
	const [cmd, arg] = argv;
	const root = process.env.VPSSH_ROOT || "/opt/vpssh";
	const stateDir = path.join(root, "state");
	const env = readEnvFile(path.join(stateDir, "gate.env"));
	const dshHome = env.DSH_HOME || "/home/vpssh/.dsh";
	const gatePort = Number(env.GATE_PORT) || 3190;
	const log = (m) => process.stdout.write(`[vpssh] ${m}\n`);
	const readPassword = () => {
		// 命令行恢复：密码从标准输入读（bin/vpssh 用 read -s 读好再传进来）
		try {
			return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
		} catch {
			return "";
		}
	};
	if (cmd === "backup-run") {
		const req = takeRequest(stateDir, "backup");
		if (!req) return;
		await runBackup({ root, dshHome, password: req.password, log });
	} else if (cmd === "restore-run") {
		const req = takeRequest(stateDir, "restore");
		if (!req) return;
		const upload = path.join(stateDir, "restore.upload");
		try {
			await runRestore({ root, dshHome, file: upload, password: req.password, gatePort, log });
		} finally {
			fs.rmSync(upload, { force: true });
		}
	} else if (cmd === "restore") {
		if (!arg || !fs.existsSync(arg)) throw new Error("usage: vpssh restore <backup file>");
		await runRestore({ root, dshHome, file: arg, password: readPassword(), gatePort, log });
	} else {
		throw new Error("usage: backup.js backup-run | restore-run | restore <file>");
	}
}

if (require.main === module) {
	cli(process.argv.slice(2)).catch((err) => {
		const zh = /^zh/i.test(process.env.LANG || "");
		const msg = {
			wrong_password: zh ? "密码不对（或者备份文件坏了）" : "Wrong password (or the backup file is damaged)",
			not_backup: zh ? "这不是 vpssh 的备份文件" : "This is not a vpssh backup file",
			bad_entry: zh ? "备份里有不该有的东西，没有恢复" : "The backup contains something it should not; nothing was restored",
			selfcheck: zh ? "恢复后 vpssh 没通过自检，已换回原来的数据" : "vpssh failed its self-check after the restore; the previous data is back",
		}[err.code];
		process.stderr.write(`[vpssh] ${msg ? `${msg} (${err.message})` : err.message}\n`);
		process.exit(1);
	});
}

module.exports = { encryptFile, decryptFile, listTar, checkEntries, dataPaths, keepLocalState, packData, BackupError, EXT };

//#endregion
