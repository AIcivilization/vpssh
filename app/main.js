// main.js — vpssh 桌面版
//
// 一个独立窗口走完全程：服务器列表 / 安装表单（本地页面 ui/）→ 安装进度 → 服务器上 vpssh 的
// 初始设置 → 登录 → 产品界面。菜单「服务器」随时回到列表、切换服务器。
// 安装经 SSH（lib/jobs.js）；用 IP 访问时只信任装机时读到的 Caddy 根证书（lib/certs.js）。
"use strict";

const path = require("node:path");
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require("electron");
const { Store } = require("./lib/store.js");
const { validate } = require("./lib/remote.js");
const { runJob, readServerInfo } = require("./lib/jobs.js");
const { verifyWithRoot, chainFromElectron } = require("./lib/certs.js");

const PARTITION = "persist:vpssh";
const UI_FILE = path.join(__dirname, "ui", "index.html");

// VPSSH_USER_DATA：开发测试（截图、自检）用一个单独的数据目录，不碰这台电脑上真正的服务器列表和登录状态
if (process.env.VPSSH_USER_DATA) app.setPath("userData", process.env.VPSSH_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let store = null;
let lang = "en";
let jobRunning = false;
let currentServerId = "";
const L = (zh, en) => (lang === "zh" ? zh : en);

const isLocalPage = (url) => typeof url === "string" && url.startsWith("file://");
const originOf = (url) => {
	try {
		return new URL(url).origin;
	} catch {
		return "";
	}
};

// ———————————————————— 窗口与页面 ————————————————————

function showHome(view = "", extra = {}) {
	currentServerId = "";
	win.setTitle("vpssh");
	return win.loadFile(UI_FILE, { query: { lang, view, ...extra } });
}

function openServer(server, { url } = {}) {
	currentServerId = server.id;
	store.data.lastId = server.id;
	store.save();
	win.setTitle(`vpssh — ${server.name}`);
	buildMenu();
	// 初始设置还没做完：一直用带一次性令牌的链接打开（第一次没打开成功、重试、关了再开都还能进向导）
	return win.loadURL(url || server.setupUrl || server.url);
}

function createWindow() {
	const saved = store.data.window || {};
	win = new BrowserWindow({
		width: saved.width || 1280,
		height: saved.height || 820,
		x: saved.x,
		y: saved.y,
		minWidth: 380,
		minHeight: 500,
		title: "vpssh",
		backgroundColor: "#0f1115",
		show: false,
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			partition: PARTITION,
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: false,
		},
	});
	win.once("ready-to-show", () => win.show());
	// 窗口标题由桌面版管（vpssh — 服务器名），不跟网页标题变
	win.on("page-title-updated", (e) => e.preventDefault());
	win.on("close", () => {
		store.data.window = win.getBounds();
		store.save();
	});

	const wc = win.webContents;
	// 页面里的跳转：本地页面之间、服务器网页之内（含向导里换了域名跳到新地址）都留在窗口里；别的交给系统浏览器
	wc.on("will-navigate", (event, url) => {
		if (isLocalPage(url)) return;
		const from = wc.getURL();
		if (/^https:/.test(url) && (!isLocalPage(from) || store.byOrigin(originOf(url)))) return;
		event.preventDefault();
		if (/^https?:/.test(url)) shell.openExternal(url);
	});
	// 向导里设了域名：服务器的访问地址跟着换成新的
	wc.on("did-navigate", (_e, url) => {
		const server = currentServerId && store.get(currentServerId);
		if (!server || isLocalPage(url) || !/^https:/.test(url)) return;
		const origin = originOf(url);
		// 离开了 /setup（向导做完，到了登录页或产品）：一次性链接用完了，不再留
		if (server.setupUrl && !new URL(url).pathname.startsWith("/setup")) {
			delete server.setupUrl;
			store.save();
		}
		if (origin && origin !== originOf(server.url) && !store.byOrigin(origin)) {
			server.url = `${origin}/`;
			server.name = new URL(origin).hostname;
			store.save();
			win.setTitle(`vpssh — ${server.name}`);
			buildMenu();
		}
	});
	// 新窗口：同一台服务器的页面开成子窗口（同一个登录状态），外部链接用系统浏览器
	wc.setWindowOpenHandler(({ url }) => {
		const cur = wc.getURL();
		if (!isLocalPage(cur) && originOf(url) === originOf(cur)) {
			return { action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true, sandbox: true } } };
		}
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: "deny" };
	});
	// 服务器打不开：回到本地页面说清楚，可以重试
	wc.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
		if (!isMainFrame || isLocalPage(url) || code === -3 /* 被新的跳转取代 */) return;
		const server = currentServerId && store.get(currentServerId);
		showHome("error", { id: server?.id || "", url, code: String(code), desc });
	});

	// --smoke-test：打包后自检（CI 在 Mac / Windows 上跑）：本地页面能渲染出表单、SSH 模块能加载，就退出 0
	if (process.argv.includes("--smoke-test")) {
		wc.once("did-finish-load", async () => {
			const ok = await wc.executeJavaScript("new Promise((r) => setTimeout(() => r(Boolean(document.querySelector('form [name=host]'))), 1500))").catch(() => false);
			let ssh = false;
			try { ssh = typeof require("ssh2").Client === "function"; } catch { /* 没打包进去 */ }
			console.log(`SMOKE ${ok && ssh ? "OK" : "FAIL"} form=${ok} ssh2=${ssh}`);
			app.exit(ok && ssh ? 0 : 1);
		});
		showHome("install");
		return;
	}
	const last = store.data.lastId && store.get(store.data.lastId);
	if (last) openServer(last);
	else showHome(store.list().length ? "" : "install");
}

// ———————————————————— 证书：用 IP 访问时钉住 Caddy 根证书 ————————————————————

function setupCertificates() {
	const ses = session.fromPartition(PARTITION);
	ses.setCertificateVerifyProc((req, callback) => {
		if (req.errorCode === 0) return callback(-3); // 正常的公共证书：照 Chromium 的结果
		const hostname = String(req.hostname).replace(/^\[|\]$/g, "");
		const chainPems = chainFromElectron(req.certificate);
		if (process.env.VPSSH_DEBUG_CERT) console.log("[cert]", hostname, req.errorCode, req.verificationResult, "chain", chainPems.length, "servers", store.byHostname(hostname).length);
		for (const server of store.byHostname(hostname)) {
			if (server.rootPem && verifyWithRoot({ hostname, chainPems, rootPem: server.rootPem })) return callback(0);
		}
		callback(-3);
	});
}

// ———————————————————— 菜单 ————————————————————

function buildMenu() {
	const servers = store.list();
	const serverMenu = {
		label: L("服务器", "Server"),
		submenu: [
			{ label: L("服务器列表", "Servers"), accelerator: "CmdOrCtrl+Shift+L", click: () => showHome() },
			{ label: L("安装到新的 VPS…", "Install on a new VPS…"), accelerator: "CmdOrCtrl+N", click: () => showHome("install") },
			{ label: L("连接已装好的服务器…", "Connect to an installed server…"), click: () => showHome("connect") },
			{ type: "separator" },
			...servers.map((s, i) => ({
				label: s.name,
				type: "radio",
				checked: s.id === currentServerId,
				accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
				click: () => openServer(s),
			})),
			...(servers.length ? [{ type: "separator" }] : []),
			{ label: L("重新加载", "Reload"), accelerator: "CmdOrCtrl+R", click: () => win?.webContents.reload() },
			{
				label: L("在浏览器中打开", "Open in browser"),
				enabled: Boolean(currentServerId),
				click: () => {
					const s = store.get(currentServerId);
					if (s) shell.openExternal(s.url);
				},
			},
		],
	};
	const template = [
		...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
		serverMenu,
		{ role: "editMenu" },
		{
			label: L("显示", "View"),
			submenu: [
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(app.isPackaged ? [] : [{ role: "toggleDevTools" }]),
			],
		},
		{ role: "windowMenu" },
		{
			role: "help",
			submenu: [
				{ label: L("vpssh 说明（GitHub）", "vpssh on GitHub"), click: () => shell.openExternal("https://github.com/AIcivilization/vpssh#readme") },
				...(process.platform === "darwin" ? [] : [{ role: "about" }]),
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ———————————————————— 本地页面的接口 ————————————————————

/** 只接本地页面的调用：服务器上的网页即使拿到 ipcRenderer 也用不了 */
function handle(channel, fn) {
	ipcMain.handle(channel, (event, ...args) => {
		if (!isLocalPage(event.senderFrame?.url)) throw new Error("forbidden");
		return fn(...args);
	});
}

const publicServer = (s) => ({ id: s.id, name: s.name, url: s.url, ssh: s.ssh || null, addedAt: s.addedAt || "" });
const errText = (err) => (err && err.zh ? L(err.zh, err.en) : String(err?.message || err));

function registerIpc() {
	handle("state", () => ({ lang, version: app.getVersion(), platform: process.platform, servers: store.list().map(publicServer), jobRunning }));
	handle("open", (id) => {
		const s = store.get(id);
		if (s) openServer(s);
	});
	handle("remove", (id) => {
		store.remove(id);
		buildMenu();
	});
	handle("open-external", (url) => {
		if (/^https:\/\//.test(String(url))) shell.openExternal(url);
	});
	handle("pick-key", async () => {
		const r = await dialog.showOpenDialog(win, {
			title: L("选择 SSH 私钥", "Choose an SSH private key"),
			defaultPath: path.join(app.getPath("home"), ".ssh"),
			properties: ["openFile", "showHiddenFiles"],
		});
		return r.canceled ? "" : r.filePaths[0];
	});

	handle("job-start", async (form) => {
		if (jobRunning) return { error: L("已经有一个任务在进行", "A task is already running") };
		const v = validate(form);
		if (v.error) return { error: L(...v.error) };
		const opts = v.value;
		const known = store.list().find((s) => s.ssh && s.ssh.host === opts.host && Number(s.ssh.port) === opts.port);
		jobRunning = true;
		const emit = (ev) => win?.webContents.send("job", ev);
		runJob(opts, { lang, knownFingerprint: known?.hostKey || "", emit })
			.then((r) => finishJob(opts, r, emit))
			.catch((err) => emit({ type: "done", ok: false, error: errText(err) }))
			.finally(() => {
				jobRunning = false;
				opts.password = ""; // 密码不多留
			});
		return { started: true };
	});

	handle("connect", async (form) => {
		let url;
		try {
			const raw = String(form.url || "").trim();
			url = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
		} catch {
			return { error: L("访问地址写法不对，例如 https://vps.example.com", "Not an address, e.g. https://vps.example.com") };
		}
		url.protocol = "https:";
		const hostname = url.hostname.replace(/^\[|\]$/g, "");
		const isIp = /^[0-9.]+$/.test(hostname) || hostname.includes(":");
		const server = { name: hostname, url: `${url.origin}/` };
		if (isIp) {
			// 用 IP 访问是自签证书：经 SSH 读一次服务器的根证书，只信任它
			const v = validate({ ...form, action: "install", host: form.host || hostname, domain: "" });
			if (v.error) return { error: L(...v.error) };
			try {
				const known = store.list().find((s) => s.ssh && s.ssh.host === v.value.host && Number(s.ssh.port) === v.value.port);
				const info = await readServerInfo(v.value, { knownFingerprint: known?.hostKey || "" });
				if (!info.rootPem) return { error: L("这台服务器上没找到 vpssh 的证书：确认 vpssh 已经装好", "No vpssh certificate found on that server: check that vpssh is installed") };
				Object.assign(server, { rootPem: info.rootPem, hostKey: info.fingerprint, ssh: { host: v.value.host, port: v.value.port, user: v.value.user } });
			} catch (err) {
				return { error: errText(err) };
			}
		}
		const saved = store.upsert(server);
		buildMenu();
		openServer(saved);
		return { ok: true };
	});
}

function finishJob(opts, r, emit) {
	if (opts.action === "uninstall") {
		if (r.exitCode === 0 || r.error === "not_installed") {
			for (const s of store.list()) if (s.ssh && s.ssh.host === opts.host) store.remove(s.id);
			buildMenu();
			return emit({ type: "done", ok: true, action: "uninstall", notInstalled: r.error === "not_installed" });
		}
		return emit({ type: "done", ok: false, error: L(`卸载没成功（退出码 ${r.exitCode}），详情见上面的日志`, `The uninstall failed (exit code ${r.exitCode}); see the log above`) });
	}
	if (r.error === "no_fetch") return emit({ type: "done", ok: false, error: L("服务器上没有 curl 也没有 wget，装不了：先在服务器上 apt install curl", "The server has neither curl nor wget: run apt install curl there first") });
	if (r.exitCode !== 0 && r.exitCode !== 3) {
		return emit({ type: "done", ok: false, error: L(`安装没成功（退出码 ${r.exitCode}），详情见上面的日志`, `The install failed (exit code ${r.exitCode}); see the log above`) });
	}
	const host = r.host || new URL(r.openUrl || `https://${opts.domain || opts.host}`).host;
	const server = store.upsert({
		name: host.replace(/:\d+$/, ""),
		url: `https://${host}/`,
		ssh: { host: opts.host, port: opts.port, user: opts.user },
		hostKey: r.fingerprint,
		rootPem: opts.domain ? "" : r.rootPem,
		setupUrl: r.setupUrl || undefined, // 向导做完就删（见 did-navigate）
	});
	buildMenu();
	emit({ type: "done", ok: true, action: "install", notReady: r.exitCode === 3, url: server.url });
	setTimeout(() => openServer(server), r.exitCode === 3 ? 8000 : 1500);
}

// ———————————————————— 启动 ————————————————————

app.whenReady().then(() => {
	lang = /^zh/i.test(app.getLocale()) ? "zh" : "en";
	store = new Store(app.getPath("userData"));
	setupCertificates();
	registerIpc();
	buildMenu();
	createWindow();
	app.on("activate", () => {
		if (!BrowserWindow.getAllWindows().length) createWindow();
	});
});

app.on("second-instance", () => {
	if (win) {
		if (win.isMinimized()) win.restore();
		win.focus();
	}
});

app.on("window-all-closed", () => app.quit());
