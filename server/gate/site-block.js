#!/usr/bin/env node
"use strict";

/*
 * Caddy 站点块的唯一模板。
 *
 * 三处共用同一份，任何改动只改这里：
 *   - install.sh        首次写入 /etc/caddy/vpssh-site.conf
 *   - gate/server.js    浏览器向导改域名时重写
 *   - bin/vpssh       vpn on/off 切换访问策略
 *
 * 隧道模式（state/vpn.env 里 VPSSH_VPN=on）：Caddy 只放行隧道网段，其余来源 abort。
 * 为什么不用公网出口 IP 白名单：出口 IP 不是身份，换网络 / 宽带重拨就变，会把使用者
 * 自己关在门外。隧道 IP 由我们自己分配（WireGuard），永不变化。
 *
 * 和别的产品共用一个 Caddy（比如同一台机器上装着 dsh-vps）时：主 Caddyfile 是别人的，全局设置块
 * 只能有一个、还必须在最前面，所以共用时站点文件里不写全局块（shared）。
 *
 * host 可以带端口（1.2.3.4:8443）：443 被别人占着、又没有域名时 vpssh 换到别的端口。
 *
 * CLI: node site-block.js <host> [installRoot] [gatePort] [shared:0|1] [altPort]
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SUBNET = "10.7.0.0/24";
const DEFAULT_GATE_PORT = 3190; // 不和同机的 dsh-vps（3100）撞

/** 读 state/vpn.env → { on, subnet }。文件不存在即未启用隧道。 */
function readVpnEnv(stateDir) {
	const out = { on: false, subnet: DEFAULT_SUBNET };
	try {
		const txt = fs.readFileSync(path.join(stateDir, "vpn.env"), "utf8");
		if (/^\s*VPSSH_VPN\s*=\s*on\s*$/m.test(txt)) out.on = true;
		const m = txt.match(/^\s*VPSSH_VPN_SUBNET\s*=\s*(\S+)\s*$/m);
		if (m) out.subnet = m[1];
	} catch {
		/* 未启用隧道 */
	}
	return out;
}

function proxyLines(port, indent) {
	return (
		`${indent}reverse_proxy 127.0.0.1:${port} {\n` +
		// 只信 Caddy 自己看到的对端地址：显式覆盖，客户端伪造的 X-Forwarded-For 一律作废。
		// gate 的登录限流与审计日志都读这个头，能被伪造就等于把限流关掉。
		`${indent}\theader_up X-Forwarded-For {remote_host}\n` +
		`${indent}}\n`
	);
}

/**
 * @param {string} host 站点地址（域名 / IP / :443）
 * @param {{gatePort?: number, vpn?: {on: boolean, subnet: string}}} opts
 */
/** 站点地址是否为裸 IP：公网 CA 不给 IP 签证书（至少不稳定），只能由 Caddy 内置 CA 签。 */
function isIpHost(host) {
	return net.isIP(hostName(host)) !== 0;
}

/** 去掉端口（1.2.3.4:8443 → 1.2.3.4，[::1]:8443 → ::1） */
function hostName(host) {
	const h = String(host);
	const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
	if (v6) return v6[1];
	return net.isIP(h) === 6 ? h : h.replace(/:\d+$/, "");
}

/** 这台机器网卡上的 IPv4 地址（不含本机回环），最多 4 个 */
function localIps() {
	const out = [];
	for (const list of Object.values(os.networkInterfaces())) {
		for (const a of list || []) if (a.family === "IPv4" && !a.internal && !out.includes(a.address)) out.push(a.address);
	}
	return out.slice(0, 4);
}

function caddySiteBlock(host, opts = {}) {
	const port = opts.gatePort || DEFAULT_GATE_PORT;
	// 用域名（走 443）时也听「域名:访问端口」：带端口的旧地址照样能进（gate 会换成主地址再转给 DSH）
	const altPort = Number(opts.altPort) || 0;
	let address = altPort && altPort !== 443 && !isIpHost(host) && !/:\d+$/.test(String(host)) ? `${host}, ${host}:${altPort}` : host;
	// 和别人共用 Caddy、用 IP 访问：浏览器按 IP 打开时不报网站名（没有 SNI），共用的 Caddy 又不能由 vpssh 写
	// default_sni（全局设置是别人的），Caddy 就按「连接到达的网卡地址」找证书。云主机多是 NAT，网卡上只有
	// 内网地址，于是找不到证书、握手直接失败（实测）。给网卡上的地址也各签一张，没有网站名时照样有证书可用
	if (opts.shared && isIpHost(host) && Array.isArray(opts.extraIps) && opts.extraIps.length) {
		const m = /:(\d+)$/.exec(String(host));
		const suffix = net.isIP(String(host)) === 6 || !m ? "" : `:${m[1]}`;
		const extra = opts.extraIps.filter((ip) => net.isIP(ip) === 4 && ip !== hostName(host)).map((ip) => `${ip}${suffix}`);
		if (extra.length) address = [host, ...extra].join(", ");
	}
	const vpn = opts.vpn || { on: false, subnet: DEFAULT_SUBNET };
	// IP 站点：浏览器按 IP 访问时不发 SNI，Caddy 会退而按本机网卡地址找证书；
	// 云主机网卡上多是内网地址（公网 IP 经 NAT），于是找不到证书、握手失败。
	// default_sni 让无 SNI 的连接按公网 IP 选证书。本文件被主 Caddyfile 第一行 import，
	// 全局选项块因此仍位于配置开头，合法。
	const ip = isIpHost(host);
	// 用 IP 访问时浏览器不发 SNI，要靠 default_sni 挑证书。和别人共用 Caddy 时不能写全局块：
	// 同一台机器的另一个产品若也是 IP 站点，它的 default_sni 就是同一个 IP，照样挑得到
	// offDefaultPorts：80/443 是别的网站（nginx 等）的，vpssh 自己的 Caddy 只听访问端口：
	// 关掉 HTTP→HTTPS 跳转（它要占 80）。用 IP 访问、证书是 Caddy 自签的，也用不着 80 签证书
	const globalLines = [];
	if (ip && !opts.shared) globalLines.push(`\tdefault_sni ${hostName(host)}`);
	if (opts.offDefaultPorts && !opts.shared) globalLines.push("\tauto_https disable_redirects");
	const globals = globalLines.length ? `{\n${globalLines.join("\n")}\n}\n\n` : "";
	const tls = ip ? "\ttls internal\n" : "";
	if (!vpn.on) return `${globals}${address} {\n${tls}${proxyLines(port, "\t")}}\n`;
	// 隧道模式：非隧道来源直接断连，连响应体都不给。
	// ACME HTTP-01 挑战由 Caddy 在路由之前处理（fall-through），不受本块影响，证书照常续期。
	return (
		globals +
		`${address} {\n` +
		tls +
		`\t@tunnel remote_ip ${vpn.subnet}\n` +
		`\thandle @tunnel {\n` +
		proxyLines(port, "\t\t") +
		`\t}\n` +
		`\thandle {\n\t\tabort\n\t}\n` +
		`}\n`
	);
}

/** 安装时记下的：是否和别人共用 Caddy（caddyShared）、访问端口（publicPort）、是不是 --port 指定的（portForced） */
function readConfig(stateDir) {
	try {
		return JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8"));
	} catch {
		return {};
	}
}
function readShared(stateDir) {
	return readConfig(stateDir).caddyShared === true;
}

module.exports = { caddySiteBlock, readVpnEnv, readShared, isIpHost, hostName, localIps, DEFAULT_SUBNET, DEFAULT_GATE_PORT };

if (require.main === module) {
	const host = process.argv[2];
	const root = process.argv[3] || process.env.GATE_HOME || "/opt/vpssh";
	const gatePort = Number(process.argv[4] || process.env.GATE_PORT || DEFAULT_GATE_PORT);
	if (!host) {
		console.error("用法: node site-block.js <host> [installRoot] [gatePort] [shared:0|1]");
		process.exit(2);
	}
	const state = path.join(root, "state");
	const shared = process.argv[5] !== undefined ? process.argv[5] === "1" : readShared(state);
	const cfg = readConfig(state);
	const altPort = process.argv[6] !== undefined ? Number(process.argv[6]) : cfg.portForced ? 0 : Number(cfg.publicPort) || 0;
	const offDefaultPorts = process.argv[7] !== undefined ? process.argv[7] === "1" : Boolean(cfg.foreignWeb);
	process.stdout.write(caddySiteBlock(host, { gatePort, vpn: readVpnEnv(state), shared, altPort, offDefaultPorts, extraIps: localIps() }));
}
