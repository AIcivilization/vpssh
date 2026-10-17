// lib/certs.js — 用 IP 访问时的证书：只信任装机时经 SSH 读到的那张 Caddy 根证书
//
// Caddy 的自签证书由它自己的根证书签发（中间证书和网站证书会定期换，根证书十年不变），
// 所以钉的是根证书：网站证书链能一级级验到这张根证书、对得上访问的地址、在有效期内，才算可信。
// 用域名访问时走正常的公共证书验证，不经过这里。
"use strict";

const { X509Certificate } = require("node:crypto");
const net = require("node:net");

function inDate(cert, now) {
	return new Date(cert.validFrom) <= now && now <= new Date(cert.validTo);
}

/**
 * chainPems：网站给的证书链（第一张是网站证书）；rootPem：钉住的根证书。
 * 返回 true = 可信
 */
function verifyWithRoot({ hostname, chainPems, rootPem, altNames = [], now = new Date() }) {
	if (!rootPem || !chainPems?.length) return false;
	let root, certs;
	try {
		root = new X509Certificate(rootPem);
		certs = chainPems.map((p) => new X509Certificate(p));
	} catch {
		return false;
	}
	const leaf = certs[0];
	const host = String(hostname).replace(/^\[|\]$/g, "");
	// altNames：这台服务器网卡上的地址（装机 / 连接时经 SSH 读到的）。和别人共用 Caddy 时，浏览器按 IP 访问
	// 不报网站名，拿到的是签给网卡地址的证书（gate/site-block.js）；仍然要能验到这台自己的根证书
	const names = [host, ...altNames.filter((n) => net.isIP(n))];
	const nameOk = names.some((n) => (net.isIP(n) ? leaf.checkIP(n) !== undefined : leaf.checkHost(n) !== undefined));
	if (!nameOk) return false;
	if (!inDate(root, now)) return false;
	for (let i = 0; i < certs.length; i++) {
		const cert = certs[i];
		if (!inDate(cert, now)) return false;
		if (cert.fingerprint256 === root.fingerprint256) return true;
		if (cert.checkIssued(root) && cert.verify(root.publicKey)) return true;
		const next = certs[i + 1];
		if (!next || !cert.checkIssued(next) || !cert.verify(next.publicKey)) return false;
	}
	return false;
}

/** Electron 的 Certificate（带 issuerCert 链）摊平成 PEM 数组 */
function chainFromElectron(certificate) {
	const out = [];
	let c = certificate;
	const seen = new Set();
	while (c && c.data && !seen.has(c.fingerprint)) {
		seen.add(c.fingerprint);
		out.push(c.data);
		c = c.issuerCert;
	}
	return out;
}

module.exports = { verifyWithRoot, chainFromElectron };
