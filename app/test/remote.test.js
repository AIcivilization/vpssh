// 表单校验、交给服务器的脚本、安装日志解析
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validate, startScript, attachScript, parseLog, parseInfo, INSTALL_URL } = require("../lib/remote.js");

test("校验：默认 root、22；域名、端口、用户名不对就说清楚", () => {
	const v = validate({ host: " 203.0.113.10 ", password: "x", domain: "VPS.Example.com", mirror: true }).value;
	assert.deepEqual([v.action, v.host, v.port, v.user, v.domain, v.mirror], ["install", "203.0.113.10", 22, "root", "vps.example.com", true]);
	assert.ok(validate({ host: "a b" }).error);
	assert.ok(validate({ host: "h", port: 70000 }).error);
	assert.ok(validate({ host: "h", user: "a;b" }).error);
	assert.ok(validate({ host: "h", domain: "x" }).error);
	assert.equal(validate({ action: "uninstall", host: "h", domain: "a.b", deleteData: true }).value.domain, "");
});

test("安装脚本：下载最新发布版、后台运行、记下进程号、跟着日志；参数加引号", () => {
	const s = startScript({ action: "install", domain: "a.example.com", mirror: true }, "zh");
	assert.ok(s.includes(INSTALL_URL));
	assert.match(s, /nohup setsid sh -c/);
	assert.match(s, /echo "\$P" >"\$L\.pid"/);
	assert.match(s, /tail -n \+1 -f --pid="\$P"/);
	assert.match(s, /LANG=zh_CN\.UTF-8/);
	assert.match(s, /'\\''--domain'\\'' '\\''a\.example\.com'\\'' '\\''--mirror'\\'' '\\''cn'\\''/);
	const u = startScript({ action: "uninstall", deleteData: true }, "en");
	assert.match(u, /vpssh uninstall --yes --delete-data/);
	assert.match(u, /vpssh-uninstall\.log/);
	assert.match(attachScript("install"), /kill -0 "\$P"/);
});

test("日志：进度、设置链接、退出码", () => {
	const log = "\x1b[1;32m[install]\x1b[0m 步骤 3/11：DeepSeek Harness\r\n[install] Step 7/11: gateway\n 打开      : https://1.2.3.4:8443/setup?token=ab_C-1\nVPSSH_EXIT=0\n";
	const p = parseLog(log);
	assert.deepEqual([p.step, p.total, p.setupUrl, p.exitCode], [7, 11, "https://1.2.3.4:8443/setup?token=ab_C-1", 0]);
	assert.equal(parseLog("VPSSH_ERR=no_fetch\n").error, "no_fetch");
	assert.equal(parseLog("still going").exitCode, null);
});

test("装完的信息：访问地址和根证书", () => {
	const pem = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
	const info = parseInfo(`VPSSH_INFO_BEGIN\nHOST=1.2.3.4:8443\nCERT_BEGIN\n${pem}\nCERT_END\nVPSSH_INFO_END\n`);
	assert.deepEqual(info, { host: "1.2.3.4:8443", rootPem: pem, ips: [] });
	assert.deepEqual(parseInfo("HOST=vps.example.com\n"), { host: "vps.example.com", rootPem: "", ips: [] });
	assert.deepEqual(parseInfo("HOST=1.2.3.4\nIPS=10.0.0.5 172.17.0.1 fd00::1 \n").ips, ["10.0.0.5", "172.17.0.1"]);
});

test("勾了「同时启用模型来源」：安装脚本带 --model", () => {
	const { installArgs } = require("../lib/remote.js");
	const v = validate({ host: "h", model: true }).value;
	assert.deepEqual(installArgs(v), ["--model"]);
	assert.equal(validate({ action: "uninstall", host: "h", model: true }).value.model, false);
});

test("登录方式：密码 / 私钥（粘贴或文件）/ 本机密钥；老的调用照旧", () => {
	assert.equal(validate({ host: "h", password: "p" }).value.auth, "password");
	assert.equal(validate({ host: "h", keyPath: "/k" }).value.auth, "key");
	assert.equal(validate({ host: "h" }).value.auth, "local");
	assert.match(validate({ host: "h", auth: "password" }).error[0], /本机密钥/);
	assert.ok(validate({ host: "h", auth: "key" }).error);
	assert.match(validate({ host: "h", auth: "key", privateKey: "hello" }).error[0], /PuTTYgen/);
	const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\r\nAAAA\r\n-----END OPENSSH PRIVATE KEY-----\r\n\r\n";
	const v = validate({ host: "h", auth: "key", privateKey: pem, passphrase: "x" }).value;
	assert.equal(v.privateKey, "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n");
	assert.equal(v.passphrase, "x");
	// 选了别的方式，私钥不往下传
	assert.equal(validate({ host: "h", auth: "local", privateKey: pem }).value.privateKey, "");
});
