// ui/app.js — 桌面版的本地页面：服务器列表、安装 / 卸载 / 连接表单、安装进度、打不开时的说明
"use strict";

const api = window.vpssh;
const params = new URLSearchParams(location.search);
const lang = params.get("lang") === "zh" ? "zh" : "en";
const L = (zh, en) => (lang === "zh" ? zh : en);
document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

const INSTALL_CMD = "curl -fsSL https://github.com/AIcivilization/vpssh/releases/latest/download/install.sh | sudo bash";

/** 建元素：h('div', {class: 'x', onclick}, ...children) */
function h(tag, props, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className = v;
		else if (k === "value") el.value = v;
		else if (k === "checked") el.checked = Boolean(v);
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
	return el;
}

const main = document.getElementById("main");
const nav = document.getElementById("nav");
document.querySelector("[data-t=tagline]").textContent = L("全平台 AI 驱动的 VPS 管理及 SSH 工具", "AI-driven VPS management and SSH tool");

let state = { servers: [], jobRunning: false };
let view = params.get("view") || "";

async function refresh() {
	state = await api.state();
}

function setNav() {
	nav.replaceChildren(
		...[
			["", L("服务器", "Servers")],
			["install", L("安装到 VPS", "Install on a VPS")],
			["connect", L("连接已装好的", "Connect")],
		].map(([v, label]) => h("button", { class: v === view || (v === "" && view === "uninstall") ? "on" : "", onclick: () => go(v) }, label)),
	);
}

function go(v, data) {
	view = v;
	setNav();
	main.replaceChildren();
	window.scrollTo(0, 0);
	({ "": Home, install: InstallForm, uninstall: UninstallForm, connect: ConnectForm, progress: Progress, error: LoadError }[v] || Home)(data);
}

// ———————————————————— 服务器列表 ————————————————————

function Home() {
	main.append(h("h1", null, L("服务器", "Servers")), h("p", { class: "lead" }, L("点「打开」进入这台服务器上的 vpssh。菜单「服务器」里也能随时切换。", "Open a server to use vpssh on it. You can also switch from the Server menu at any time.")));
	if (!state.servers.length) {
		main.append(h("div", { class: "card empty" },
			h("p", null, L("还没有服务器。", "No servers yet.")),
			h("div", { class: "actions", style: "justify-content:center" },
				h("button", { class: "primary", onclick: () => go("install") }, L("安装到新的 VPS", "Install on a new VPS")),
				h("a", { onclick: () => go("connect") }, L("已经装好了？连接它", "Already installed? Connect to it")))));
		return;
	}
	main.append(h("div", { class: "servers" }, state.servers.map((s) => h("div", { class: "server" },
		h("div", { class: "info" }, h("div", { class: "sname" }, s.name), h("div", { class: "surl" }, s.url)),
		h("div", { class: "more" },
			s.ssh ? h("a", { onclick: () => go("uninstall", s) }, L("卸载…", "Uninstall…")) : null,
			h("a", { onclick: async () => {
				if (!confirm(L(`从列表里去掉 ${s.name}？（服务器上的 vpssh 不受影响）`, `Remove ${s.name} from the list? (vpssh on the server is not affected)`))) return;
				await api.remove(s.id);
				await refresh();
				go("");
			} }, L("移除", "Remove"))),
		h("button", { class: "primary", onclick: () => api.open(s.id) }, L("打开", "Open"))))));
}

// ———————————————————— 表单部件 ————————————————————

function field(label, input, hint) {
	return h("div", { class: "field" }, h("label", null, label), input, hint ? h("div", { class: "hint" }, hint) : null);
}
const text = (name, value, placeholder, type = "text") => h("input", { type, name, value: value ?? "", placeholder, autocomplete: "off", spellcheck: "false" });

/** 一段可复制的命令：点「复制」放进剪贴板 */
function copyBlock(textValue) {
	const btn = h("button", { type: "button", class: "plain small" }, L("复制", "Copy"));
	btn.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(textValue);
			btn.textContent = L("已复制", "Copied");
			setTimeout(() => { btn.textContent = L("复制", "Copy"); }, 1500);
		} catch {
			/* 剪贴板用不了：内容本身可以选中复制 */
		}
	});
	return h("div", { class: "copyrow" }, h("pre", { class: "cmd" }, textValue), btn);
}

/** 本机密钥：这台电脑上已有的钥匙（服务器认其中一把就直接能登），以及桌面版专用的那把怎么加到服务器上 */
function localKeyPanel(getHost) {
	const found = h("div", { class: "note", style: "margin-bottom:10px" });
	let timer = null;
	const refresh = () => {
		clearTimeout(timer);
		timer = setTimeout(async () => {
			const keys = await api.localKeys(getHost()).catch(() => []);
			found.replaceChildren(
				h("div", null, keys.length
					? L("这台电脑上有这些钥匙，登录时按顺序试：", "This computer has these keys; they are tried in this order when logging in:")
					: L("这台电脑的 ~/.ssh 里没有可用的钥匙（带口令的会跳过）。用下面 vpssh 的本机密钥：", "No usable key in ~/.ssh on this computer (keys with a passphrase are skipped). Use the vpssh key below:")),
				...(keys.length ? [h("ul", { class: "keys" }, keys.map((k) => h("li", null, k.label)))] : []),
				h("div", { class: "hint" }, L(
					"有钥匙不代表能登录：要这台服务器事先信任它（公钥已放在服务器上，比如 dsh-vps-manager 管过的服务器信任 dsh_vps_ed25519）。随便填一个别人的服务器，这些钥匙是进不去的。点下面的「测试登录」就知道这台服务器认不认。私钥只在这台电脑上用，不会发给服务器。",
					"Having a key does not mean you can log in: the server must already trust it (its public key placed on the server, e.g. servers managed by dsh-vps-manager trust dsh_vps_ed25519). These keys will not open someone else's server. Click Test login below to see whether this server accepts one. Private keys stay on this computer and are never sent to the server.")));
		}, 300);
	};
	refresh();
	const box = h("div", { class: "note" }, L("读取中…", "Loading…"));
	const render = (k, error) => {
		if (k?.publicKey) {
			box.replaceChildren(
				h("div", null, L("① 把这台电脑的公钥加到服务器上（只需一次）。在云厂商控制台打开服务器的网页终端（VNC / 远程连接 / Workbench），粘贴执行：", "① Add this computer's public key to the server (once). Open the server's web console in your cloud provider (VNC / remote connection) and run:")),
				copyBlock(k.command),
				h("div", { style: "margin-top:8px" }, L("或者在云厂商控制台的「SSH 密钥 / 密钥对」里导入下面这个公钥，绑定到这台服务器：", "Or import this public key under SSH keys / key pairs in your cloud provider's console and attach it to the server:")),
				copyBlock(k.publicKey),
				h("div", { style: "margin-top:8px" }, L("② 点「测试登录」确认能进，再安装。", "② Click Test login to check, then install.")));
		} else {
			const gen = h("button", { type: "button", class: "primary small" }, L("生成本机密钥", "Generate a key"));
			gen.addEventListener("click", async () => {
				gen.disabled = true;
				try {
					render(await api.localKey(true));
				} catch (e) {
					render(null, String(e.message || e));
				}
			});
			box.replaceChildren(
				h("div", null, L("服务器不认上面那些钥匙的话：生成一把 vpssh 专用的，把公钥加到服务器上，以后就能免密码登录。", "If the server trusts none of the keys above, generate a vpssh key and add its public key to the server; no password needed from then on.")),
				h("div", { style: "margin-top:8px" }, gen),
				...(error ? [h("div", { class: "error", style: "margin:8px 0 0" }, error)] : []));
		}
	};
	api.localKey(false).then((k) => render(k), (e) => render(null, String(e.message || e)));
	const wrap = h("div", null, found, box);
	wrap.refresh = refresh;
	return wrap;
}

/** 测试登录的结果，写成大白话：认没认、用的哪把、能不能装 */
function testResult(r) {
	if (r?.ok) {
		const who = `${r.user}@${r.host}`;
		const how = r.auth === "password" ? L("用密码", "with the password")
			: r.key === "app" ? L("用 vpssh 本机密钥", "with the vpssh key")
				: r.key === "pasted" ? L("用你粘贴的私钥", "with the private key you pasted")
					: r.key === "ssh-agent" ? L("用 ssh-agent 里的钥匙", "with a key from ssh-agent")
						: r.key ? L(`用这台电脑上的钥匙 ${r.key}`, `with this computer's key ${r.key}`) : "";
		const trusted = r.auth === "local" || r.auth === "key"
			? L("这台服务器事先信任这把钥匙，所以不需要密码。", "The server already trusts this key, so no password is needed.") : "";
		const sp = /[\x21-\x7e]$/.test(how) ? " " : ""; // 钥匙路径结尾是英文时和「登录」之间空一格
		return r.root
			? [h("b", null, L(`✓ 可以登录：${how}${sp}登录 ${who}`, `✓ You can log in: ${how} as ${who}`)),
				h("div", null, `${trusted}${L("有管理员权限，点下面的「安装到这台 VPS」就会用同样的方式登录。", "It has admin rights; Install on this VPS below logs in the same way.")}`)]
			: [h("b", null, L(`⚠ 登录成功（${how}），但 ${r.user} 没有管理员权限`, `⚠ Logged in (${how}), but ${r.user} has no admin rights`)),
				h("div", null, L("这个账号不是 root，也不能免密 sudo，装不了。改用 root 登录，或用这个账号的密码登录（密码会用来 sudo）。", "This account is not root and cannot sudo without a password, so it cannot install. Log in as root, or log in to this account with its password (used for sudo)."))];
	}
	const rows = [h("b", null, L("✗ 登录不了", "✗ Cannot log in")), h("div", null, r?.error || "?")];
	if (r?.code === "auth" && r?.auth === "local") {
		rows.push(h("div", null, L("这是正常的安全保护：服务器只放行事先信任的钥匙。也可以改用「密码」登录。", "This is normal protection: a server only lets in keys it already trusts. You can also log in with the password.")));
	}
	if (r?.code === "key_only") rows.push(h("div", null, L("已经切到「本机密钥」，再点一次「测试登录」。", "Switched to This computer's key; click Test login again.")));
	return rows;
}

/** 登录信息：IP、端口、用户名；登录方式：密码 / 私钥 / 本机密钥 */
function sshFields(prefill = {}, { hostLabel } = {}) {
	let auth = ["password", "key", "local"].includes(prefill.auth) ? prefill.auth : "password";
	// 私钥：粘贴进文本框，或选文件（选的文件路径放在隐藏字段里，交给主进程去读）
	const keyInput = h("input", { type: "hidden", name: "keyPath", value: prefill.keyPath || "" });
	const keyLine = h("div", { class: "keyline" });
	const showKey = () => {
		const keyPath = keyInput.value;
		keyLine.replaceChildren(keyInput, keyPath
			? h("span", null, L("私钥文件：", "Key file: "), keyPath, "  ", h("a", { onclick: () => { keyInput.value = ""; showKey(); } }, L("不用了", "Clear")))
			: h("a", { onclick: async () => { keyInput.value = (await api.pickKey()) || ""; showKey(); } }, L("或者选择私钥文件…", "Or choose a key file…")));
	};
	keyInput.addEventListener("change", showKey);
	showKey();
	const privateKey = h("textarea", { name: "privateKey", rows: "5", spellcheck: "false", autocomplete: "off", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----" });

	const panes = {
		password: h("div", null,
			field(L("密码", "Password"), text("password", "", L("服务器的登录密码", "The server's login password"), "password"),
				L("只用这一次，不保存。服务器关掉了密码登录时，改用「私钥」或「本机密钥」", "Used this once and never saved. If the server has password login turned off, use a private key or this computer's key"))),
		key: h("div", null,
			h("div", { class: "field" },
				h("label", null, L("私钥", "Private key")),
				privateKey,
				h("div", { class: "hint" }, L("云厂商创建或重装服务器时下载的 .pem 文件，或你自己的 id_ed25519 / id_rsa 的全部内容。只用这一次，不保存", "The .pem file your cloud provider gave you when creating or reinstalling the server, or the full contents of your own id_ed25519 / id_rsa. Used this once and never saved")),
				keyLine),
			field(L("私钥口令（可选）", "Key passphrase (optional)"), text("passphrase", "", "", "password"), L("私钥设过口令才填", "Only if the key has a passphrase"))),
		local: h("div", { class: "field" }),
	};
	const localPane = localKeyPanel(() => val(el, "host"));
	panes.local.append(localPane);
	const picker = h("div", { class: "seg" });
	const paneBox = h("div");
	const show = () => {
		picker.replaceChildren(...[["password", L("密码", "Password")], ["key", L("私钥", "Private key")], ["local", L("本机密钥", "This computer's key")]].map(([k, label]) => {
			const b = h("button", { type: "button", class: k === auth ? "on" : "" }, label);
			b.addEventListener("click", () => { auth = k; show(); });
			return b;
		}));
		paneBox.replaceChildren(panes[auth]);
	};
	show();
	// 测试登录：只登录看看（这台服务器认不认、用的哪把钥匙、有没有管理员权限），什么都不改
	const testOut = h("div", { class: "testresult", hidden: true });
	const testBtn = h("button", { type: "button", class: "plain small" }, L("测试登录", "Test login"));
	const testNote = h("span", { class: "hint" }, L("先试试能不能登录这台服务器，不会改动服务器上的任何东西", "Check whether you can log in to this server first; nothing on the server is changed"));
	testBtn.addEventListener("click", async () => {
		testBtn.disabled = true;
		testOut.hidden = false;
		testOut.className = "testresult wait";
		testOut.replaceChildren(h("div", null, L("正在连接这台服务器…", "Connecting to the server…")));
		const r = await api.testLogin(el.read()).catch((e) => ({ error: String(e.message || e) }));
		testBtn.disabled = false;
		testOut.replaceChildren(...testResult(r));
		testOut.className = `testresult ${r?.ok ? (r.root ? "ok" : "warn") : "bad"}`;
		if (r?.code === "key_only") { auth = "local"; show(); }
	});
	const el = h("div", null,
		h("div", { class: "row wide" },
			field(hostLabel || L("服务器 IP 或域名", "Server IP or hostname"), text("host", prefill.host, "203.0.113.10"), L("你买的 VPS 的公网地址", "Your VPS's public address")),
			field(L("SSH 端口", "SSH port"), text("port", prefill.port ?? 22, "22", "number"))),
		h("div", { class: "row" },
			field(L("用户名", "User name"), text("user", prefill.user ?? "root", "root"), L("建议用 root；别的账号要能 sudo", "root is easiest; another account must be able to sudo")),
			h("div", { class: "field" }, h("label", null, L("登录方式", "Log in with")), picker)),
		paneBox,
		h("div", { class: "testrow" }, testBtn, testNote),
		testOut);
	el.querySelector("[name=host]").addEventListener("input", () => localPane.refresh());
	el.read = () => ({
		host: val(el, "host"),
		port: Number(val(el, "port")) || 22,
		user: val(el, "user"),
		auth,
		password: auth === "password" ? panes.password.querySelector("[name=password]").value : "",
		privateKey: auth === "key" ? privateKey.value : "",
		passphrase: auth === "key" ? panes.key.querySelector("[name=passphrase]").value : "",
		keyPath: auth === "key" ? keyInput.value : "",
	});
	el.setAuth = (k) => { auth = k; show(); };
	return el;
}
const val = (root, name) => (root.querySelector(`[name=${name}]`)?.value || "").trim();

function errorBox() {
	const box = h("div", { class: "error", hidden: true });
	box.show = (msg) => { box.textContent = msg; box.hidden = !msg; if (msg) box.scrollIntoView({ block: "nearest" }); };
	return box;
}

// ———————————————————— 安装 ————————————————————

function InstallForm(prefill = {}) {
	const err = errorBox();
	const ssh = sshFields(prefill);
	const domain = text("domain", prefill.domain || "", "vps.example.com");
	const mirror = h("input", { type: "checkbox", name: "mirror", checked: prefill.mirror });
	const model = h("input", { type: "checkbox", name: "model", checked: prefill.model });
	const manual = h("div", { hidden: true }, h("div", { class: "hint" }, L("SSH 登录服务器后执行（装最新发布版）：", "Log in to the server over SSH and run (installs the latest release):")), h("pre", { class: "cmd" }, INSTALL_CMD));
	const btn = h("button", { class: "primary", type: "submit" }, L("安装到这台 VPS", "Install on this VPS"));
	const form = h("form", { class: "card", onsubmit: async (e) => {
		e.preventDefault();
		const data = { action: "install", ...ssh.read(), domain: domain.value.trim(), mirror: mirror.checked, model: model.checked };
		if (!data.host) return err.show(L("请填写服务器 IP 或域名", "Enter the server IP or hostname"));
		const target = `${data.user || "root"}@${data.host}`;
		if (!confirm(L(
			`在 ${target} 上安装 vpssh？\n\n会安装 Node.js、DeepSeek Harness、Caddy 并创建系统服务。同一台机器上已有 dsh-vps 等网站也没关系，vpssh 会和它共用。`,
			`Install vpssh on ${target}?\n\nThis installs Node.js, DeepSeek Harness and Caddy and creates system services. Another site on the machine (e.g. dsh-vps) is fine; vpssh shares it.`))) return;
		await startJob(data, err, btn);
	} },
		err,
		h("p", { class: "lead", style: "margin-top:0" }, L(
			"填好一台 Ubuntu 22.04+ / Debian 12+ 服务器的登录信息，点「安装到这台 VPS」：装好后就在这个窗口里进入初始设置、登录、使用 vpssh。",
			"Enter the login details of an Ubuntu 22.04+ / Debian 12+ server and click \"Install on this VPS\". When it is done, first-time setup, sign-in and vpssh itself open right in this window.")),
		ssh,
		field(L("访问域名（可选）", "Domain (optional)"), domain, L("已把 A 记录解析到这台服务器的域名，填了自动签发 HTTPS 证书；不填用 IP 访问，之后可在向导里补填", "A domain whose A record points at this server gets an automatic HTTPS certificate; without one vpssh uses the IP, and you can add a domain in the setup wizard later")),
		h("label", { class: "check" }, mirror, L("服务器在国内（Node 与 DSH 从 npmmirror 下载）", "Server in mainland China (download Node and DSH from npmmirror)")),
		h("label", { class: "check" }, model, L("同时启用模型来源（dsh-model：WorkBuddy 免费积分、各家订阅、API key 汇成一处，没有模型 key 也能用）", "Also turn on model sources (dsh-model: WorkBuddy free credits, subscriptions and API keys in one place; works without a model key)")),
		h("div", { class: "actions" }, btn, h("a", { onclick: () => { manual.hidden = !manual.hidden; } }, L("想自己在服务器上执行？", "Prefer to run it on the server yourself?"))),
		manual);
	main.append(h("h1", null, L("安装到 VPS", "Install on a VPS")), form);
}

// ———————————————————— 卸载 ————————————————————

function UninstallForm(server) {
	const err = errorBox();
	const ssh = sshFields(server?.ssh || server || {});
	const del = h("input", { type: "checkbox", name: "deleteData" });
	const btn = h("button", { class: "danger", type: "submit" }, L("从这台 VPS 卸载", "Uninstall from this VPS"));
	const form = h("form", { class: "card", onsubmit: async (e) => {
		e.preventDefault();
		const data = { action: "uninstall", ...ssh.read(), deleteData: del.checked };
		if (!data.host) return err.show(L("请填写服务器 IP 或域名", "Enter the server IP or hostname"));
		if (!confirm(L(
			`从 ${data.user}@${data.host} 卸载 vpssh？\n\n会停止并删除 vpssh 的服务和安装目录，${data.deleteData ? "并删除数据（对话、机器清单、钥匙）" : "保留数据（对话、机器清单），以后重装能接着用"}。卸载前会在服务器上备份到 /root。同机别的网站（比如 dsh-vps）不受影响。`,
			`Uninstall vpssh from ${data.user}@${data.host}?\n\nThis stops and removes vpssh's services and install directory, and ${data.deleteData ? "deletes the data (conversations, machine list, keys)" : "keeps the data (conversations, machine list) for a later reinstall"}. A backup goes to /root on the server first. Other sites on the machine (e.g. dsh-vps) are not affected.`))) return;
		await startJob(data, err, btn);
	} },
		err,
		h("p", { class: "lead", style: "margin-top:0" }, L("从服务器上卸载 vpssh。默认保留数据，以后重装能接着用。", "Removes vpssh from a server. Data is kept by default for a later reinstall.")),
		ssh,
		h("label", { class: "check" }, del, L("同时删除数据（对话、机器清单、钥匙）", "Also delete the data (conversations, machine list, keys)")),
		h("div", { class: "actions" }, btn, h("a", { onclick: () => go("") }, L("返回", "Back"))));
	main.append(h("h1", null, L("从 VPS 卸载", "Uninstall from a VPS")), form);
}

// ———————————————————— 连接已装好的 ————————————————————

function ConnectForm() {
	const err = errorBox();
	const address = text("url", "", "https://vps.example.com");
	const ssh = sshFields({}, { hostLabel: L("SSH 地址（一般就是服务器 IP）", "SSH address (usually the server IP)") });
	const sshBox = h("div", { hidden: true },
		h("div", { class: "hint", style: "margin:-6px 0 14px" }, L("用 IP 访问时 vpssh 是自签证书：经 SSH 读一次服务器的证书，以后只信任它，不会弹「不安全」。", "Over an IP address vpssh uses a self-signed certificate: the app reads it once over SSH and trusts only that one, so there is no \"not secure\" warning.")),
		ssh);
	const isIp = () => {
		const raw = address.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
		const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
		return /^[0-9.]+$/.test(host) || host.includes(":");
	};
	address.addEventListener("input", () => {
		sshBox.hidden = !isIp();
		const hostInput = ssh.querySelector("[name=host]");
		if (isIp() && !hostInput.dataset.touched) hostInput.value = address.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
	});
	ssh.querySelector("[name=host]").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });
	const btn = h("button", { class: "primary", type: "submit" }, L("连接", "Connect"));
	const form = h("form", { class: "card", onsubmit: async (e) => {
		e.preventDefault();
		err.show("");
		if (!address.value.trim()) return err.show(L("请填写访问地址", "Enter the address"));
		btn.disabled = true;
		btn.textContent = L("连接中…", "Connecting…");
		const r = await api.connect({ url: address.value.trim(), ...(isIp() ? ssh.read() : {}) }).catch((x) => ({ error: String(x.message || x) }));
		btn.disabled = false;
		btn.textContent = L("连接", "Connect");
		if (r?.error) err.show(r.error);
	} },
		err,
		h("p", { class: "lead", style: "margin-top:0" }, L("vpssh 已经装在服务器上了：填它的访问地址（安装完打印的那个，或你设的域名）。", "vpssh is already on the server: enter its address (the one printed after installing, or your domain).")),
		field(L("访问地址", "Address"), address, L("例如 https://vps.example.com 或 https://203.0.113.10:8443", "e.g. https://vps.example.com or https://203.0.113.10:8443")),
		sshBox,
		h("div", { class: "actions" }, btn));
	main.append(h("h1", null, L("连接已装好的服务器", "Connect to an installed server")), form);
}

// ———————————————————— 进度 ————————————————————

let progress = null;

async function startJob(data, err, btn) {
	err.show("");
	btn.disabled = true;
	const r = await api.startJob(data).catch((x) => ({ error: String(x.message || x) }));
	btn.disabled = false;
	if (r?.error) return err.show(r.error);
	// 任务开始后页面里不再留密码、私钥
	go("progress", { ...data, password: "", privateKey: "", passphrase: "" });
}

function Progress(data) {
	const un = data.action === "uninstall";
	const bar = h("div");
	const phase = h("div", { class: "phase" }, L("正在连接服务器…", "Connecting to the server…"));
	const log = h("pre", { class: "log" });
	const result = h("div");
	progress = { data, bar, phase, log, result };
	main.append(
		h("h1", null, un ? L(`正在从 ${data.host} 卸载 vpssh`, `Uninstalling vpssh from ${data.host}`) : L(`正在把 vpssh 装到 ${data.host}`, `Installing vpssh on ${data.host}`)),
		h("p", { class: "lead" }, un ? L("约 1 分钟。", "About a minute.") : L("一般 3–8 分钟。网络断了也没关系：安装在服务器上继续，这里会自动重新连上。", "Usually 3–8 minutes. A dropped connection is fine: the install continues on the server and this window reconnects.")),
		h("div", { class: "card" }, h("div", { class: "progress" }, bar), phase, log, result));
}

api.onJob((ev) => {
	if (!progress) return;
	const { bar, phase, log, result } = progress;
	if (ev.type === "phase") {
		phase.textContent = {
			connecting: L("正在连接服务器…", "Connecting to the server…"),
			running: ev.reattached ? L("已重新连上，接着看…", "Reconnected, following along…") : L("正在执行…", "Running…"),
			reconnecting: L(`连接断了，正在重连（第 ${ev.attempt} 次）…服务器上的安装不受影响`, `Connection lost, reconnecting (attempt ${ev.attempt})… the install continues on the server`),
			finishing: L("快好了：读取访问地址和证书…", "Almost there: reading the address and certificate…"),
		}[ev.phase] || phase.textContent;
	} else if (ev.type === "log") {
		if (ev.reset) log.textContent = "";
		const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
		log.textContent += ev.text.replace(/^VPSSH_(STARTED|EXIT=\d+)\n?/gm, "");
		if (atBottom) log.scrollTop = log.scrollHeight;
		if (ev.total) {
			bar.style.width = `${Math.round((ev.step / ev.total) * 100)}%`;
			phase.textContent = L(`第 ${ev.step}/${ev.total} 步`, `Step ${ev.step}/${ev.total}`);
		}
	} else if (ev.type === "done") {
		bar.style.width = ev.ok ? "100%" : bar.style.width;
		if (ev.ok && ev.action === "uninstall") {
			phase.textContent = "";
			result.replaceChildren(h("div", { class: "okmsg" }, ev.notInstalled ? L("这台服务器上没有装 vpssh。", "vpssh is not installed on that server.") : L("已卸载。", "Uninstalled.")), h("button", { class: "plain", onclick: async () => { await refresh(); go(""); } }, L("回到服务器列表", "Back to servers")));
		} else if (ev.ok) {
			phase.textContent = "";
			result.replaceChildren(h("div", { class: "okmsg" }, ev.notReady
				? L("装好了，服务还在启动，稍等几秒就打开初始设置…", "Installed; still starting. First-time setup opens in a few seconds…")
				: L("装好了，正在打开初始设置…", "Installed. Opening first-time setup…")));
		} else {
			phase.textContent = "";
			const back = { ...progress.data, password: "", privateKey: "", passphrase: "" };
			if (ev.code === "key_only") back.auth = "key";
			result.replaceChildren(h("div", { class: "error", style: "margin-top:16px" }, ev.error), h("button", { class: "plain", onclick: () => go(progress.data.action === "uninstall" ? "uninstall" : "install", back) }, L("返回修改", "Back")));
		}
	}
});

// ———————————————————— 打不开 ————————————————————

function LoadError() {
	const id = params.get("id");
	const server = state.servers.find((s) => s.id === id);
	const code = Number(params.get("code"));
	const certish = code <= -200 && code > -300;
	main.append(h("h1", null, L("打不开这台服务器", "Cannot open this server")),
		h("div", { class: "card" },
			h("p", null, server ? server.url : params.get("url")),
			h("div", { class: "error" }, certish
				? L("证书验证没通过。用域名的话，检查 A 记录是否解析到这台服务器、80/443 端口是否放行（证书签发需要）；用 IP 的话，在「连接已装好的」里重新连一次。", "The certificate did not verify. With a domain, check its A record points at the server and ports 80/443 are open (needed to get the certificate); with an IP, connect again under \"Connect\".")
				: L("连不上。可能服务器关机、网络不通，或云厂商安全组没放行访问端口。服务器上可以执行 sudo vpssh repair。", "Could not connect. The server may be off, the network down, or the provider's security group may block the port. On the server you can run sudo vpssh repair."),
				`\n(${params.get("desc") || code})`),
			h("div", { class: "actions" },
				server ? h("button", { class: "primary", onclick: () => api.open(server.id) }, L("重试", "Retry")) : null,
				h("button", { class: "plain", onclick: () => go("") }, L("服务器列表", "Servers")))));
}

// ———————————————————— 启动 ————————————————————

refresh().then(() => {
	if (view === "install" && state.jobRunning) view = "";
	go(view);
});
