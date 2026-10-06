// vpssh-keyd：用真的 OpenSSH 工具测（ssh-add 列钥匙、ssh-keygen -Y 经 agent 签名再验签）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KEYD = path.join(__dirname, "..", "keyd", "keyd.js");
const hasOpenSsh = spawnSync("ssh-add", ["-h"]).error === undefined;

async function startKeyd() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-keyd-"));
	const sock = path.join(dir, "a.sock");
	const child = spawn(process.execPath, [KEYD], { env: { ...process.env, VPSSH_KEY_DIR: dir, VPSSH_AGENT_SOCK: sock }, stdio: "ignore" });
	for (let i = 0; i < 50 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 50));
	return { dir, sock, stop: () => child.kill() };
}

test("第一次启动生成钥匙：私钥 0600，公钥 0644，socket 0660", async () => {
	const k = await startKeyd();
	try {
		const mode = (f) => fs.statSync(path.join(k.dir, f)).mode & 0o777;
		assert.equal(mode("vpssh_ed25519"), 0o600);
		assert.equal(mode("vpssh_ed25519.pub"), 0o644);
		assert.equal(fs.statSync(k.sock).mode & 0o777, 0o660);
		assert.match(fs.readFileSync(path.join(k.dir, "vpssh_ed25519.pub"), "utf8"), /^ssh-ed25519 AAAA\S+ vpssh@/);
	} finally {
		k.stop();
	}
});

test("重启后用同一把钥匙", async () => {
	const k1 = await startKeyd();
	const pub1 = fs.readFileSync(path.join(k1.dir, "vpssh_ed25519.pub"), "utf8");
	k1.stop();
	await new Promise((r) => setTimeout(r, 100));
	const child = spawn(process.execPath, [KEYD], { env: { ...process.env, VPSSH_KEY_DIR: k1.dir, VPSSH_AGENT_SOCK: k1.sock }, stdio: "ignore" });
	await new Promise((r) => setTimeout(r, 300));
	child.kill();
	assert.equal(fs.readFileSync(path.join(k1.dir, "vpssh_ed25519.pub"), "utf8"), pub1);
});

test("OpenSSH 能列出钥匙、经它签名，签名验得过", { skip: !hasOpenSsh && "没有 OpenSSH" }, async () => {
	const k = await startKeyd();
	try {
		const env = { ...process.env, SSH_AUTH_SOCK: k.sock };
		const pub = path.join(k.dir, "vpssh_ed25519.pub");
		const list = spawnSync("ssh-add", ["-L"], { env, encoding: "utf8" });
		assert.equal(list.status, 0, list.stderr);
		assert.equal(list.stdout.split(" ")[1], fs.readFileSync(pub, "utf8").split(" ")[1]);
		const msg = path.join(k.dir, "msg");
		fs.writeFileSync(msg, "hello");
		const sign = spawnSync("ssh-keygen", ["-Y", "sign", "-f", pub, "-n", "file", msg], { env, encoding: "utf8" });
		assert.equal(sign.status, 0, sign.stderr);
		const allowed = path.join(k.dir, "allowed");
		fs.writeFileSync(allowed, `me ${fs.readFileSync(pub, "utf8")}`);
		const verify = spawnSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "me", "-n", "file", "-s", `${msg}.sig`], { input: "hello", encoding: "utf8" });
		assert.equal(verify.status, 0, verify.stderr);
	} finally {
		k.stop();
	}
});

test("别的钥匙请它签名：拒绝", () => {
	// keyd 在加载时读 VPSSH_KEY_DIR，要先设好
	process.env.VPSSH_KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-keyd-"));
	const keyd = require(KEYD);
	const key = keyd.loadOrCreateKey("t");
	const other = Buffer.concat([keyd.sshString(Buffer.from("ssh-ed25519")), keyd.sshString(Buffer.alloc(32, 7))]);
	const payload = Buffer.concat([keyd.sshString(other), keyd.sshString(Buffer.from("data")), Buffer.alloc(4)]);
	assert.equal(keyd.handle(key, 13, payload)[4], 5);
	assert.equal(keyd.handle(key, 99, Buffer.alloc(0))[4], 5, "不认识的请求一律失败");
});
