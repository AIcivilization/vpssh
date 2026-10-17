// vpssh 安卓版的本地页面：服务器列表、扫码添加、手动添加。只有这个页面能调 App 的接口（window.vpsshApp）
"use strict";

const app = window.vpsshApp;
const zh = app.lang() === "zh";
const L = (a, b) => (zh ? a : b);
const main = document.getElementById("main");
document.getElementById("tag").textContent = L("全平台 AI 驱动的 VPS 管理及 SSH 工具", "AI-driven VPS management and SSH tool");
document.documentElement.lang = zh ? "zh-CN" : "en";

function h(tag, props, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(props || {})) {
		if (v === undefined || v === null || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "class") el.className = v;
		else el.setAttribute(k, v);
	}
	for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
	return el;
}

let message = null; // { kind: "error" | "ok", text }
let manual = false;

function render() {
	const servers = JSON.parse(app.list());
	const banner = message ? h("div", { class: message.kind }, message.text) : null;
	const list = servers.length
		? [h("h2", null, L("服务器", "Servers")), ...servers.map((s) => h("div", { class: "server", onclick: () => app.open(s.id) },
			h("div", { class: "info" },
				h("div", { class: "n" }, s.name),
				h("div", { class: "u" }, s.url),
				s.caSha256 ? h("div", { class: "pin" }, L("✓ 只信任这台服务器自己的证书", "✓ Trusts only this server's own certificate")) : null),
			h("button", { class: "link", onclick: (e) => {
				e.stopPropagation();
				if (confirm(L(`从列表里去掉 ${s.name}？（服务器上的 vpssh 不受影响）`, `Remove ${s.name} from the list? (vpssh on the server is not affected)`))) { app.remove(s.id); render(); }
			} }, L("移除", "Remove"))))]
		: [h("div", { class: "card" },
			h("div", null, L("还没有服务器。先在 VPS 上装好 vpssh（电脑上用桌面版，或在服务器上执行一键命令），然后：", "No servers yet. Install vpssh on your VPS first (with the desktop app, or the one-line command on the server), then:")),
			h("ol", null,
				h("li", null, L("在电脑上打开 vpssh，进入「VPS 管理 → 手机、平板」", "Open vpssh on your computer and go to VPS Manager → Phone and tablet")),
				h("li", null, L("点下面的「扫码添加」，扫那里的二维码", "Tap Scan to add below and scan the code there"))))];
	const manualBox = manual
		? h("div", { class: "card", style: "margin-top:12px" },
			h("div", null, L("用域名访问的服务器可以直接填地址；用 IP 的请扫码（二维码里带着证书指纹）。也可以粘贴从电脑上复制的链接。", "A server on a domain can be added by address; one on an IP needs the code (it carries the certificate fingerprint). You can also paste a link copied from your computer.")),
			h("input", { id: "addr", placeholder: "https://vps.example.com", autocapitalize: "none", autocorrect: "off", spellcheck: "false" }),
			h("button", { class: "primary wide", onclick: () => add(document.getElementById("addr").value) }, L("添加", "Add")))
		: null;
	main.replaceChildren(
		...(banner ? [banner] : []),
		...list,
		h("button", { class: "primary wide", onclick: () => { message = null; app.scan(); } }, L("扫码添加", "Scan to add")),
		h("button", { class: "wide", onclick: () => { manual = !manual; message = null; render(); } }, manual ? L("收起", "Close") : L("手动添加", "Add by address")),
		...(manualBox ? [manualBox] : []),
		h("div", { class: "foot" }, `vpssh ${app.version()} · `, h("a", { href: "#", style: "color:inherit", onclick: (e) => { e.preventDefault(); app.openUrl("https://github.com/AIcivilization/vpssh"); } }, "GitHub")));
}

function add(text) {
	const r = JSON.parse(app.add(text || ""));
	if (r.error) {
		message = { kind: "error", text: r.error };
		render();
		return;
	}
	manual = false;
	message = null;
	render();
	app.open(r.id);
}

// App 回调
window.onScan = (text) => add(text);
window.showError = (text) => { message = { kind: "error", text }; render(); };
window.refresh = () => render();

render();
