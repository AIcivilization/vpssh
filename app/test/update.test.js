// 桌面版的新版本提醒（lib/update.js）：比版本、挑这台电脑的安装包、查不到时不出错
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compareVersions, pickAsset, checkLatest } = require("../lib/update.js");

test("比版本：按数字比，预发布版比正式版旧", () => {
	assert.ok(compareVersions("0.2.10", "0.2.9") > 0);
	assert.ok(compareVersions("0.3.0", "0.2.99") > 0);
	assert.equal(compareVersions("0.2.9", "0.2.9"), 0);
	assert.ok(compareVersions("0.3.0-rc.1", "0.3.0") < 0);
	assert.ok(compareVersions("0.2.9", "0.3.0") < 0);
});

const assets = ["vpssh-0.3.0-mac-arm64.dmg", "vpssh-0.3.0-mac-x64.dmg", "vpssh-0.3.0-win-x64.exe", "vpssh-0.3.0-android.apk", "install.sh"].map((name) => ({ name, browser_download_url: `https://dl/${name}` }));

test("挑安装包：Apple 芯片、Intel、Windows 各拿各的", () => {
	assert.equal(pickAsset(assets, "darwin", "arm64"), "https://dl/vpssh-0.3.0-mac-arm64.dmg");
	assert.equal(pickAsset(assets, "darwin", "x64"), "https://dl/vpssh-0.3.0-mac-x64.dmg");
	assert.equal(pickAsset(assets, "win32", "x64"), "https://dl/vpssh-0.3.0-win-x64.exe");
	assert.equal(pickAsset(assets, "linux", "x64"), null);
});

const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });

test("有新版：给安装包地址；安装包还没传上来时给发布页", async () => {
	const r = await checkLatest({ fetchFn: reply(200, { tag_name: "v0.3.0", assets, html_url: "https://page" }), current: "0.2.9", platform: "darwin", arch: "arm64" });
	assert.deepEqual(r, { current: "0.2.9", latest: "0.3.0", available: true, url: "https://dl/vpssh-0.3.0-mac-arm64.dmg" });
	const early = await checkLatest({ fetchFn: reply(200, { tag_name: "v0.3.0", assets: [], html_url: "https://page" }), current: "0.2.9", platform: "win32", arch: "x64" });
	assert.equal(early.url, "https://page");
});

test("已是最新、查不到、断网：不报错，只是没有新版", async () => {
	assert.equal((await checkLatest({ fetchFn: reply(200, { tag_name: "v0.2.9", assets }), current: "0.2.9" })).available, false);
	assert.ok((await checkLatest({ fetchFn: reply(403, {}), current: "0.2.9" })).error);
	assert.ok((await checkLatest({ fetchFn: async () => { throw new Error("offline"); }, current: "0.2.9" })).error);
});
