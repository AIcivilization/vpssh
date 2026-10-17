// Caddy 站点块：带端口的地址、和别的网站共用 Caddy 时不写全局块
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { caddySiteBlock, hostName, isIpHost } = require("../gate/site-block.js");

test("地址可以带端口：IP 判断和 default_sni 用不带端口的部分", () => {
	assert.equal(hostName("1.2.3.4:8443"), "1.2.3.4");
	assert.equal(hostName("[::1]:8443"), "::1");
	assert.equal(hostName("vps.example.com:8443"), "vps.example.com");
	assert.ok(isIpHost("1.2.3.4:8443"));
	assert.ok(!isIpHost("vps.example.com:8443"));
	const block = caddySiteBlock("1.2.3.4:8443", { gatePort: 3190 });
	assert.match(block, /default_sni 1\.2\.3\.4\n/);
	assert.match(block, /^1\.2\.3\.4:8443 \{$/m);
	assert.match(block, /tls internal/);
	assert.match(block, /reverse_proxy 127\.0\.0\.1:3190/);
});

test("和别的网站共用 Caddy：不写全局块（只能有一个，而且要在主 Caddyfile 最前面）", () => {
	const block = caddySiteBlock("1.2.3.4:8443", { gatePort: 3190, shared: true });
	assert.doesNotMatch(block, /default_sni/);
	assert.match(block, /^1\.2\.3\.4:8443 \{/);
});

test("内部端口默认 3190，不和同机 dsh-vps 的 3100 撞", () => {
	assert.match(caddySiteBlock("vps.example.com"), /127\.0\.0\.1:3190/);
});

test("域名走 443 时同时听「域名:8443」：带端口的地址照样能进", () => {
	assert.match(caddySiteBlock("vps.example.com", { altPort: 8443, shared: true }), /^vps\.example\.com, vps\.example\.com:8443 \{$/m);
	// IP、已带端口、访问端口就是 443：只有一个地址
	assert.match(caddySiteBlock("1.2.3.4:8443", { altPort: 8443, shared: true }), /^1\.2\.3\.4:8443 \{$/m);
	assert.match(caddySiteBlock("vps.example.com:9443", { altPort: 8443, shared: true }), /^vps\.example\.com:9443 \{$/m);
	assert.match(caddySiteBlock("vps.example.com", { altPort: 443, shared: true }), /^vps\.example\.com \{$/m);
});

test("80/443 是别的程序（nginx）的：自己的 Caddy 关掉 HTTP 跳转，不去占 80", () => {
	const block = caddySiteBlock("1.2.3.4:8443", { offDefaultPorts: true });
	assert.match(block, /^\{\n\tdefault_sni 1\.2\.3\.4\n\tauto_https disable_redirects\n\}/);
	assert.match(block, /^1\.2\.3\.4:8443 \{$/m);
	// 和别人共用 Caddy 时不写全局块（那是别人的配置）
	assert.doesNotMatch(caddySiteBlock("1.2.3.4:8443", { offDefaultPorts: true, shared: true }), /auto_https/);
	assert.doesNotMatch(caddySiteBlock("1.2.3.4"), /auto_https/);
});

test("共用 Caddy + 用 IP：网卡上的地址也签证书（浏览器按 IP 访问不报网站名、云主机网卡是内网地址时照样有证书）", () => {
	const b = caddySiteBlock("203.0.113.77:8443", { shared: true, extraIps: ["10.0.0.5", "203.0.113.77", "fe80::1"] });
	assert.match(b, /^203\.0\.113\.77:8443, 10\.0\.0\.5:8443 \{$/m);
	// 自己的 Caddy（能写 default_sni）、用域名：不加
	assert.match(caddySiteBlock("203.0.113.77:8443", { extraIps: ["10.0.0.5"] }), /^203\.0\.113\.77:8443 \{$/m);
	assert.match(caddySiteBlock("vps.example.com", { shared: true, extraIps: ["10.0.0.5"] }), /^vps\.example\.com \{$/m);
});
