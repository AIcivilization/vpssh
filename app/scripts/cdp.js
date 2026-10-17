// 开发测试用：经 Electron 的调试端口驱动桌面版窗口（npx electron . --remote-debugging-port=<端口>）
//
//   node scripts/cdp.js <端口> url                 当前地址
//   node scripts/cdp.js <端口> accept              页面上正弹着的对话框点确定
//   node scripts/cdp.js <端口> eval '<js>'          在当前页面执行，打印结果（confirm 等对话框自动点确定）
//   node scripts/cdp.js <端口> nav <地址>           跳转
//   node scripts/cdp.js <端口> shot <文件>          截图
//   node scripts/cdp.js <端口> shotat 1440x900 <文件>  按这个视口大小截图（2 倍清晰度）
"use strict";

const fs = require("node:fs");
const [port, cmd, arg, arg2] = process.argv.slice(2);

(async () => {
	const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
	const page = targets.find((t) => t.type === "page");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	let id = 0;
	const pending = new Map();
	const send = (method, params = {}) =>
		new Promise((resolve) => {
			const i = ++id;
			pending.set(i, resolve);
			ws.send(JSON.stringify({ id: i, method, params }));
		});
	ws.onmessage = (m) => {
		const d = JSON.parse(m.data);
		if (d.id && pending.has(d.id)) {
			pending.get(d.id)(d);
			pending.delete(d.id);
		}
		if (d.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
	};
	await new Promise((r) => (ws.onopen = r));
	await send("Page.enable");
	const wait = (ms) => new Promise((r) => setTimeout(r, ms));
	if (cmd === "accept") {
		// 页面上正弹着 confirm / alert：点确定
		const r = await send("Page.handleJavaScriptDialog", { accept: true });
		console.log(r.error ? "no dialog" : "accepted");
	} else if (cmd === "url") {
		console.log(page.url);
	} else if (cmd === "eval") {
		const r = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true, userGesture: true });
		console.log(JSON.stringify(r.result.result?.value ?? r.result.exceptionDetails?.exception?.description ?? r.result));
	} else if (cmd === "nav") {
		await send("Page.navigate", { url: arg });
		await wait(1500);
		console.log("navigated");
	} else if (cmd === "shot" || cmd === "shotat") {
		const file = cmd === "shot" ? arg : arg2;
		if (cmd === "shotat") {
			const [w, h] = arg.split("x").map(Number);
			await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: false });
			await wait(1200);
		}
		const r = await send("Page.captureScreenshot", { format: "png" });
		fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
		if (cmd === "shotat") await send("Emulation.clearDeviceMetricsOverride");
		console.log("saved", file);
	} else {
		console.error("usage: node scripts/cdp.js <port> url|eval|nav|shot|shotat ...");
		process.exitCode = 2;
	}
	ws.close();
	process.exit();
})().catch((e) => {
	console.error(e);
	process.exit(1);
});
