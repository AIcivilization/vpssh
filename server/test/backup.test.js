// 备份与恢复（gate/backup.js）：加密解密、密码不对、核对备份里的每一条（不让恢复写到数据目录以外）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const backup = require("../gate/backup.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-backup-test-"));
const paths = backup.dataPaths("/opt/vpssh", "/home/vpssh/.dsh");

test("加密后能用同一个密码解开，内容一字不差", async () => {
	const dir = tmp();
	const plain = path.join(dir, "a.bin");
	const data = Buffer.concat([Buffer.from("hello vpssh\n"), require("node:crypto").randomBytes(200_000)]);
	fs.writeFileSync(plain, data);
	await backup.encryptFile(plain, path.join(dir, "a.enc"), "correct horse 电池");
	const enc = fs.readFileSync(path.join(dir, "a.enc"));
	assert.equal(enc.subarray(0, 8).toString(), "VPSSHBK1");
	assert.equal(enc.includes(Buffer.from("hello vpssh")), false);
	await backup.decryptFile(path.join(dir, "a.enc"), path.join(dir, "b.bin"), "correct horse 电池");
	assert.deepEqual(fs.readFileSync(path.join(dir, "b.bin")), data);
});

test("密码不对、文件被改过：wrong_password，不留半截文件", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "a"), "secret data");
	await backup.encryptFile(path.join(dir, "a"), path.join(dir, "a.enc"), "pw-one-123456");
	await assert.rejects(backup.decryptFile(path.join(dir, "a.enc"), path.join(dir, "out"), "pw-two-123456"), { code: "wrong_password" });
	assert.equal(fs.existsSync(path.join(dir, "out")), false);
	const enc = fs.readFileSync(path.join(dir, "a.enc"));
	enc[enc.length - 20] ^= 1;
	fs.writeFileSync(path.join(dir, "bad.enc"), enc);
	await assert.rejects(backup.decryptFile(path.join(dir, "bad.enc"), path.join(dir, "out"), "pw-one-123456"), { code: "wrong_password" });
});

test("不是 vpssh 备份的文件：not_backup", async () => {
	const dir = tmp();
	fs.writeFileSync(path.join(dir, "x"), "just some file that is long enough to have a header and a tag");
	await assert.rejects(backup.decryptFile(path.join(dir, "x"), path.join(dir, "out"), "pw"), { code: "not_backup" });
});

/** 用系统的 tar 打一个包（-C dir 下的相对路径），返回读出来的条目 */
async function tarOf(build, members) {
	const dir = tmp();
	const src = path.join(dir, "src");
	fs.mkdirSync(src);
	build(src);
	const file = path.join(dir, "t.tar.gz");
	const r = spawnSync("tar", ["-czf", file, "-C", src, ...members], { env: { ...process.env, COPYFILE_DISABLE: "1" } }); // macOS 的 tar 不夹带 ._ 文件
	assert.equal(r.status, 0, String(r.stderr));
	return backup.listTar(file);
}

function writeTree(src, files) {
	for (const [rel, body] of Object.entries(files)) {
		fs.mkdirSync(path.join(src, path.dirname(rel)), { recursive: true });
		fs.writeFileSync(path.join(src, rel), body);
	}
}

test("正常的备份：认出有哪几块数据（含插件目录里的相对软链接、很长的文件名）", async () => {
	const long = "home/vpssh/.dsh/profiles/web/node_modules/.pnpm/" + "x".repeat(120) + "/index.js";
	const entries = await tarOf((src) => {
		writeTree(src, {
			"vpssh-backup.json": "{}",
			"home/vpssh/.dsh/vpssh/hosts.yml": "hosts: {}",
			[long]: "1",
			"opt/vpssh/state/admin.json": "{}",
			"var/lib/vpssh-keys/vpssh_ed25519.pub": "ssh-ed25519 AAAA x",
		});
		fs.symlinkSync(".pnpm/" + "x".repeat(120), path.join(src, "home/vpssh/.dsh/profiles/web/node_modules/ws"));
	}, ["vpssh-backup.json", "home/vpssh/.dsh", "opt/vpssh/state", "var/lib/vpssh-keys"]);
	assert.ok(entries.some((e) => e.name.replace(/\/$/, "") === long), "long name read back");
	const parts = backup.checkEntries(entries, paths);
	assert.deepEqual([...parts].sort(), ["dsh", "keys", "state"]);
});

test("数据目录以外的东西：拒绝", async () => {
	const entries = await tarOf((src) => writeTree(src, { "vpssh-backup.json": "{}", "home/vpssh/.dsh/a": "1", "etc/cron.d/evil": "* * * * * root sh" }), ["vpssh-backup.json", "home/vpssh/.dsh", "etc/cron.d/evil"]);
	assert.throws(() => backup.checkEntries(entries, paths), { code: "bad_entry" });
});

test("指到外面的软链接：拒绝（绝对路径、../ 跳出去都不行）", async () => {
	for (const target of ["/etc", "../../../../etc"]) {
		const entries = await tarOf((src) => {
			writeTree(src, { "vpssh-backup.json": "{}", "home/vpssh/.dsh/a": "1" });
			fs.symlinkSync(target, path.join(src, "home/vpssh/.dsh/link"));
		}, ["vpssh-backup.json", "home/vpssh/.dsh"]);
		assert.throws(() => backup.checkEntries(entries, paths), { code: "bad_entry" }, target);
	}
});

test("没有 vpssh-backup.json：不是 vpssh 备份", async () => {
	const entries = await tarOf((src) => writeTree(src, { "home/vpssh/.dsh/a": "1" }), ["home/vpssh/.dsh"]);
	assert.throws(() => backup.checkEntries(entries, paths), { code: "not_backup" });
});

test("条目名带 ..：拒绝", () => {
	assert.throws(() => backup.checkEntries([{ name: "vpssh-backup.json", type: "0" }, { name: "home/vpssh/.dsh/../../../etc/passwd", type: "0", link: "" }], paths), { code: "bad_entry" });
});

test("恢复时留着这台机器自己的：地址、端口、隧道、进行中的请求；账号和会话密钥用备份里的", () => {
	for (const n of ["config.json", "gate.env", "setup.token", "setup.lock", "upgrade.status.json", "restore.upload", "backup.status.json", "vpn.env", "wg0.conf"]) assert.equal(backup.keepLocalState(n), true, n);
	for (const n of ["admin.json", "session.key"]) assert.equal(backup.keepLocalState(n), false, n);
});
