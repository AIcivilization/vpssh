// 这台电脑上已有的钥匙：~/.ssh/config 指定的最先，其次 dsh_vps_ed25519、id_*，最后 vpssh 本机密钥；带口令的跳过
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { utils } = require("ssh2");
const { identityFilesFor, localKeysFor } = require("../lib/localkeys.js");
const { generatePair } = require("../lib/localkey.js");

function setup() {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-home-"));
	const ssh = path.join(home, ".ssh");
	fs.mkdirSync(path.join(ssh, "config.d"), { recursive: true });
	// 带口令的那把要 ssh2 直接生成；其余用会核对的 generatePair（ssh2 偶尔生成读不回的私钥）
	const key = (file, opts) => fs.writeFileSync(path.join(ssh, file), opts ? utils.generateKeyPairSync("ed25519", opts).private : generatePair("t").private);
	key("id_ed25519");
	key("dsh_vps_ed25519");
	key("work_key");
	key("other_key");
	key("locked", { passphrase: "pw", cipher: "aes256-ctr" });
	fs.writeFileSync(path.join(ssh, "config"), [
		"Host *",
		"  IdentityFile ~/.ssh/other_key",
		"Host myvps",
		"  HostName 203.0.113.10",
		"  IdentityFile ~/.ssh/work_key",
		"  IdentityFile locked",
	].join("\n"));
	fs.writeFileSync(path.join(ssh, "config.d", "10-extra"), "Host 203.0.113.10\n  IdentityFile ~/.ssh/other_key\n");
	return { home, ssh };
}

test("~/.ssh/config（含 config.d）：按 HostName 或同名别名找 IdentityFile，通配符块不算", () => {
	const { home, ssh } = setup();
	try {
		assert.deepEqual(identityFilesFor("203.0.113.10", ssh, home), [path.join(ssh, "work_key"), path.join(ssh, "locked"), path.join(ssh, "other_key")]);
		assert.deepEqual(identityFilesFor("198.51.100.1", ssh, home), []);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("顺序：上次成功的 → config 指定的 → dsh_vps_ed25519 → id_* → vpssh 本机密钥；带口令的跳过、去重", () => {
	const { home, ssh } = setup();
	try {
		const app = path.join(home, "app", "id_ed25519");
		fs.mkdirSync(path.dirname(app), { recursive: true });
		fs.writeFileSync(app, generatePair("app").private);
		const keys = localKeysFor("203.0.113.10", { home, sshDir: ssh, appKey: app, preferred: path.join(ssh, "id_ed25519") });
		assert.deepEqual(keys.map((k) => k.label), ["~/.ssh/id_ed25519", "~/.ssh/work_key", "~/.ssh/other_key", "~/.ssh/dsh_vps_ed25519", path.join("~", "app", "id_ed25519").replace(/\\/g, "/")]);
		assert.equal(keys.at(-1).isApp, true);
		assert.ok(!keys.some((k) => k.label.includes("locked")));
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
});
