// 模型来源（gate/model.js）：用假的 DSH 和假的 dsh-model 走一遍启用、停用、出错、同一时间只跑一个
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const model = require("../gate/model.js");

/** 一个假的环境：HOME、DSH_HOME、/run/user/<uid>/bus、DSH_BIN（plugin add 时把假 dsh-model 放进 profile） */
function fakeEnv({ addFails = false, setupFails = false } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-model-"));
	const home = path.join(root, "home");
	const run = path.join(root, "run");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(run, { recursive: true });
	fs.writeFileSync(path.join(run, "bus"), "");
	const dshBin = path.join(root, "dsh.js");
	const pluginDir = path.join(home, ".dsh", "profiles", "web", "node_modules", "dsh-model");
	fs.writeFileSync(dshBin, `
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
console.log("dsh " + args.join(" ") + " mode=" + process.env.DSH_MODEL_MODE + " copy=" + process.env.pnpm_config_package_import_method);
if (${addFails}) process.exit(3);
const dir = ${JSON.stringify(pluginDir)};
if (args.includes("remove")) { fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }
fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
fs.writeFileSync(path.join(dir, "bin", "dsh-model.js"), 'console.log("dsh-model " + process.argv.slice(2).join(" ")); process.exit(${setupFails ? 5 : 0});');
`);
	const env = { ...process.env, HOME: home, DSH_HOME: path.join(home, ".dsh"), XDG_RUNTIME_DIR: run, DSH_BIN: dshBin, DSH_MODEL_HOME: path.join(home, ".dsh-model") };
	return { root, env, pluginDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("运行环境：一律本机模式（不会去改同机 dsh-vps 的 DSH）、插件按复制导入；国内走镜像", () => {
	const e = model.jobEnv({ DSH_MODEL_MODE: "vps" }, true);
	assert.equal(e.DSH_MODEL_MODE, "local");
	assert.equal(e.pnpm_config_package_import_method, "copy");
	assert.equal(e.npm_config_registry, "https://registry.npmmirror.com");
	assert.equal(model.jobEnv({}).npm_config_registry, undefined);
});

test("启用：装插件 → setup；停用：卸载并保留各家登录", async () => {
	const f = fakeEnv();
	try {
		assert.equal(model.status(f.env).installed, false);
		const lines = [];
		await model.enable({ env: f.env, lang: "zh", onLine: (l) => lines.push(l) });
		const out = lines.join("\n");
		assert.match(out, /dsh plugin --profile web add dsh-model@latest mode=local copy=copy/);
		assert.match(out, /dsh-model setup --skip-dsh-plugin --lang zh/);
		assert.equal(model.status(f.env).installed, true);
		assert.equal(model.status(f.env).version, "9.9.9");
		const off = [];
		await model.disable({ env: f.env, lang: "en", onLine: (l) => off.push(l) });
		assert.match(off.join("\n"), /dsh-model uninstall --yes --keep-auth --remove-plugin --lang en/);
		// 它自己没移掉插件：vpssh 用 DSH 的命令补上
		assert.match(off.join("\n"), /dsh plugin --profile web remove dsh-model/);
		assert.equal(model.status(f.env).installed, false);
	} finally {
		f.cleanup();
	}
});

test("没开 vpssh 用户的后台服务（老版本装的）：说清楚怎么办", async () => {
	const f = fakeEnv();
	try {
		await assert.rejects(model.enable({ env: { ...f.env, XDG_RUNTIME_DIR: path.join(f.root, "nope") }, lang: "zh" }), /sudo vpssh model enable/);
	} finally {
		f.cleanup();
	}
});

test("装插件或 setup 失败：报退出码", async () => {
	for (const [opts, re] of [[{ addFails: true }, /安装 dsh-model 失败/], [{ setupFails: true }, /设置失败（退出码 5）/]]) {
		const f = fakeEnv(opts);
		try {
			await assert.rejects(model.enable({ env: f.env, lang: "zh" }), re);
		} finally {
			f.cleanup();
		}
	}
});

test("网关里的任务：同一时间一个；做完重启 DSH；失败记下原因、不重启", async () => {
	const f = fakeEnv();
	try {
		let restarted = 0;
		const jobs = model.createJobRunner({ env: f.env, restartDsh: () => restarted++ });
		assert.equal(jobs.start("enable", { lang: "en" }), true);
		assert.equal(jobs.start("enable", { lang: "en" }), false);
		for (let i = 0; i < 100 && jobs.get().state === "running"; i++) await new Promise((r) => setTimeout(r, 50));
		assert.equal(jobs.get().state, "done");
		await new Promise((r) => setTimeout(r, 700));
		assert.equal(restarted, 1);
		const bad = fakeEnv({ setupFails: true });
		try {
			const j2 = model.createJobRunner({ env: bad.env, restartDsh: () => restarted++ });
			j2.start("enable", { lang: "en" });
			for (let i = 0; i < 100 && j2.get().state === "running"; i++) await new Promise((r) => setTimeout(r, 50));
			assert.equal(j2.get().state, "failed");
			assert.match(j2.get().error, /exit code 5/);
			await new Promise((r) => setTimeout(r, 700));
			assert.equal(restarted, 1);
		} finally {
			bad.cleanup();
		}
	} finally {
		f.cleanup();
	}
});
