// vpssh 命令：全新安装时 config.json 还没有（install.sh 第 9 步才写），命令照样要能跑
// （实测：第 7 步调 vpssh ownshost on 时读不到 config.json，整个命令在第一行就退出了）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI = path.join(__dirname, "..", "bin", "vpssh");

test("还没有 config.json 时 vpssh 不会在开头就退出", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-root-"));
	const r = spawnSync("bash", [CLI, "--help"], { env: { ...process.env, VPSSH_ROOT: root, LANG: "en_US.UTF-8", GATE_PORT: "" }, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /vpssh commands/);
	assert.doesNotMatch(r.stderr, /意外退出|unexpected/i);
});
