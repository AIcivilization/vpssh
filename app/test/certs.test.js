// 用 IP 访问时的证书：链能验到钉住的根证书、地址对得上才可信（用 openssl 现场造一套 根 → 中间 → 网站）
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyWithRoot } = require("../lib/certs.js");

function haveOpenssl() {
	try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return true; } catch { return false; }
}

function makeChain(dir, name, ip) {
	const o = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
	fs.writeFileSync(path.join(dir, "ca.ext"), "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
	fs.writeFileSync(path.join(dir, "leaf.ext"), `basicConstraints=CA:FALSE\nsubjectAltName=IP:${ip}\n`);
	o("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}-root.key`, "-out", `${name}-root.pem`, "-days", "3650", "-subj", `/CN=${name} Root`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
	o("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}-int.key`, "-out", `${name}-int.csr`, "-subj", `/CN=${name} Intermediate`);
	o("x509", "-req", "-in", `${name}-int.csr`, "-CA", `${name}-root.pem`, "-CAkey", `${name}-root.key`, "-CAcreateserial", "-out", `${name}-int.pem`, "-days", "30", "-extfile", "ca.ext");
	o("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", `${name}-leaf.key`, "-out", `${name}-leaf.csr`, "-subj", "/CN=leaf");
	o("x509", "-req", "-in", `${name}-leaf.csr`, "-CA", `${name}-int.pem`, "-CAkey", `${name}-int.key`, "-CAcreateserial", "-out", `${name}-leaf.pem`, "-days", "7", "-extfile", "leaf.ext");
	const r = (f) => fs.readFileSync(path.join(dir, f), "utf8");
	return { root: r(`${name}-root.pem`), int: r(`${name}-int.pem`), leaf: r(`${name}-leaf.pem`) };
}

test("证书链：对的根、对的地址才可信", { skip: !haveOpenssl() && "没有 openssl" }, () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vpssh-cert-"));
	try {
		const a = makeChain(dir, "a", "203.0.113.10");
		const b = makeChain(dir, "b", "203.0.113.10");
		const chain = [a.leaf, a.int];
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: chain, rootPem: a.root }), true);
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: [a.leaf, a.int, a.root], rootPem: a.root }), true);
		// 别的服务器的根证书（有人冒充）
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: chain, rootPem: b.root }), false);
		// 证书不是给这个地址的
		assert.equal(verifyWithRoot({ hostname: "203.0.113.11", chainPems: chain, rootPem: a.root }), false);
		// 链断了（少了中间证书）
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: [a.leaf], rootPem: a.root }), false);
		// 过期
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: chain, rootPem: a.root, now: new Date(Date.now() + 30 * 864e5) }), false);
		assert.equal(verifyWithRoot({ hostname: "203.0.113.10", chainPems: chain, rootPem: "" }), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
