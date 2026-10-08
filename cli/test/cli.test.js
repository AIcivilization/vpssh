// 本地命令：参数解析、交给远端的命令、从安装输出里取打开地址
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseArgs, remoteCommand, findOpenUrl, shq, INSTALL_URL } = require("../bin/vpssh.js");

test("解析：SSH 选项给 ssh，安装选项原样给安装脚本", () => {
	const o = parseArgs(["install", "root@1.2.3.4", "-p", "2222", "-i", "~/k", "--domain", "vps.example.com", "--mirror", "cn", "--no-open"]);
	assert.equal(o.command, "install");
	assert.equal(o.target, "root@1.2.3.4");
	assert.deepEqual(o.ssh, ["-p", "2222", "-i", "~/k"]);
	assert.deepEqual(o.install, ["--domain", "vps.example.com", "--mirror", "cn"]);
	assert.equal(o.open, false);
	assert.equal(parseArgs([]).command, "help");
	assert.throws(() => parseArgs(["install"]), /root@/);
	assert.throws(() => parseArgs(["install", "h", "--bogus"]), /--bogus/);
	assert.throws(() => parseArgs(["frobnicate", "h"]), /frobnicate/);
	assert.throws(() => parseArgs(["install", "h", "--ref", "x;rm"]), /x;rm/);
});

test("安装：下载最新发布版的安装脚本，不是 root 就 sudo，参数加引号", () => {
	const cmd = remoteCommand(parseArgs(["install", "u@h", "--domain", "a.example.com", "--ref", "v0.1.11"]), { zh: true });
	assert.ok(cmd.includes(shq(INSTALL_URL)));
	assert.match(INSTALL_URL, /releases\/latest\/download\/install\.sh$/);
	assert.match(cmd, /S=sudo/);
	assert.match(cmd, /\$S env LANG=zh_CN\.UTF-8 VPSSH_REF='v0\.1\.11' bash "\$t" '--domain' 'a\.example\.com'; r=\$\?/);
	assert.equal(shq("it's"), `'it'\\''s'`);
});

test("升级、卸载、取链接：调服务器上的 vpssh", () => {
	assert.match(remoteCommand(parseArgs(["upgrade", "h"]), { zh: false }), /\$S env LANG=C\.UTF-8 vpssh upgrade$/);
	assert.match(remoteCommand(parseArgs(["uninstall", "h", "--delete-data"])), /vpssh uninstall --delete-data$/);
	assert.match(remoteCommand(parseArgs(["setup-url", "h"])), /vpssh setup-url$/);
});

test("打开地址：带令牌的设置链接优先，去掉颜色", () => {
	const out = "\x1b[1;32m[install]\x1b[0m ok\n 打开      : https://1.2.3.4:8443/setup?token=abc_DEF-1\n";
	assert.equal(findOpenUrl(out), "https://1.2.3.4:8443/setup?token=abc_DEF-1");
	assert.equal(findOpenUrl(" Open      : https://vps.example.com\n"), "https://vps.example.com");
	assert.equal(findOpenUrl("nothing here"), "");
});
