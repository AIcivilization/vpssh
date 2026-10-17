// 本机密钥：生成一次、之后读同一把；加到服务器上的命令
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { utils } = require("ssh2");
const lk = require("../lib/localkey.js");

test("生成 ed25519、只生成一次、私钥 0600；命令把公钥追加进 authorized_keys", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-key-"));
	try {
		assert.equal(lk.readLocalKey(dir).publicKey, null);
		const a = lk.generateLocalKey(dir);
		assert.match(a.publicKey, /^ssh-ed25519 \S+ vpssh@/);
		assert.equal(lk.generateLocalKey(dir).publicKey, a.publicKey);
		assert.ok(!(utils.parseKey(fs.readFileSync(a.path)) instanceof Error));
		if (process.platform !== "win32") assert.equal(fs.statSync(a.path).mode & 0o777, 0o600);
		const cmd = lk.authorizeCommand(a.publicKey);
		assert.match(cmd, /^mkdir -p ~\/\.ssh && chmod 700 ~\/\.ssh && echo 'ssh-ed25519 .+' >> ~\/\.ssh\/authorized_keys && chmod 600/);
		assert.doesNotMatch(lk.authorizeCommand("ssh-ed25519 AAA x'; rm -rf /"), /'; rm/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
