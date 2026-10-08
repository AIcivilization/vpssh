// 安装任务：断线后自动重连接着看；装完读访问地址；登录被拒不重试
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runJob } = require("../lib/jobs.js");
const { SshError } = require("../lib/ssh.js");

const fakeConn = () => ({ end() {} });

test("断线：重连后从日志接着看，拿到退出码和地址", async () => {
	let connects = 0;
	const calls = [];
	const events = [];
	const r = await runJob({ action: "install", host: "h", port: 22, user: "root", password: "pw", domain: "" }, {
		emit: (e) => events.push(e),
		deps: {
			sleep: async () => {},
			connect: async (_o, { knownFingerprint }) => { connects++; calls.push(knownFingerprint); return { conn: fakeConn(), fingerprint: "SHA256:abc" }; },
			runAsRoot: async (_c, script, { onData }) => {
				if (script.includes("nohup")) { onData?.("步骤 2/11\n"); throw new Error("socket closed"); }
				if (script.includes(".pid")) { onData?.("步骤 2/11\n步骤 11/11\n 打开      : https://1.2.3.4/setup?token=T1\nVPSSH_EXIT=0\n"); return { code: 0, out: "" }; }
				return { code: 0, out: "HOST=1.2.3.4\nCERT_BEGIN\n-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----\nCERT_END\n" };
			},
		},
	});
	assert.equal(connects, 2);
	assert.deepEqual(calls, ["", "SHA256:abc"]); // 重连时核对第一次记下的主机指纹
	assert.equal(r.exitCode, 0);
	assert.equal(r.setupUrl, "https://1.2.3.4/setup?token=T1");
	assert.equal(r.host, "1.2.3.4");
	assert.match(r.rootPem, /BEGIN CERTIFICATE/);
	assert.ok(events.some((e) => e.type === "phase" && e.phase === "reconnecting"));
});

test("登录被拒：直接报错，不重试", async () => {
	await assert.rejects(runJob({ action: "install", host: "h", port: 22, user: "root", password: "x" }, {
		deps: { connect: async () => { throw new SshError("auth", "登录被拒绝", "Login refused"); } },
	}), (e) => e.code === "auth");
});

test("卸载：不读证书", async () => {
	let scripts = 0;
	const r = await runJob({ action: "uninstall", host: "h", port: 22, user: "root", password: "" }, {
		deps: {
			sleep: async () => {},
			connect: async () => ({ conn: fakeConn(), fingerprint: "f" }),
			runAsRoot: async (_c, _s, { onData }) => { scripts++; onData?.("VPSSH_EXIT=0\n"); return { code: 0, out: "" }; },
		},
	});
	assert.equal(scripts, 1);
	assert.equal(r.exitCode, 0);
});
