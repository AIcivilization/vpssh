// 生成应用图标 build/icon.png（1024×1024，electron-builder 由它生成 Mac 的 .icns 和 Windows 的 .ico）
// 图案：build/whale.png（鲸鱼原图）；没有就用网关里内嵌的 180×180 小图（放大会糊，只作占位）。
// 画法：白色圆角方块（Mac 图标规范：1024 画布里 824 的方块），鲸鱼居中。
// 运行：npx electron scripts/make-icon.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const root = path.join(__dirname, "..");
function source() {
	const own = path.join(root, "build", "whale.png");
	if (fs.existsSync(own)) return { data: fs.readFileSync(own), from: own };
	const gate = fs.readFileSync(path.join(root, "..", "server", "gate", "server.js"), "utf8");
	const b64 = gate.match(/APPLE_TOUCH_ICON_B64\s*=\s*"([^"]+)"/)[1];
	return { data: Buffer.from(b64, "base64"), from: "server/gate/server.js（180×180 占位）" };
}

app.whenReady().then(async () => {
	const { data, from } = source();
	const img = `data:image/png;base64,${data.toString("base64")}`;
	const html = `<!doctype html><html><body style="margin:0;width:1024px;height:1024px;background:transparent">
<div style="position:absolute;left:100px;top:100px;width:824px;height:824px;border-radius:185px;background:#fff;box-shadow:0 10px 24px rgba(0,0,0,.18);overflow:hidden;display:flex;align-items:center;justify-content:center">
<img src="${img}" style="width:720px;height:720px;object-fit:contain;mix-blend-mode:multiply"></div></body></html>`;
	const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
	win.webContents.setZoomFactor(1);
	await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	await new Promise((r) => setTimeout(r, 500));
	const shot = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
	const png = shot.resize({ width: 1024, height: 1024 }).toPNG();
	fs.writeFileSync(path.join(root, "build", "icon.png"), png);
	console.log(`build/icon.png ← ${from}`);
	app.quit();
});
