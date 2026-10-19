// 两步验证（gate/totp.js）：和 RFC 6238 的标准答案一致、前后 30 秒能过、同一个数字不能用两次
const { test } = require("node:test");
const assert = require("node:assert/strict");
const totp = require("../gate/totp.js");

// RFC 6238 附录 B 的 SHA-1 测试密钥 "12345678901234567890"
const RFC_SECRET = totp.base32Encode(Buffer.from("12345678901234567890"));

test("和 RFC 6238 的标准答案一致（取后 6 位）", () => {
	const cases = [
		[59, "287082"],
		[1111111109, "081804"],
		[1111111111, "050471"],
		[1234567890, "005924"],
		[2000000000, "279037"],
	];
	for (const [t, code] of cases) assert.equal(totp.codeAt(RFC_SECRET, Math.floor(t / 30)), code, `t=${t}`);
});

test("base32 来回一致；新密钥 32 个字符", () => {
	const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
	assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
	const s = totp.generateSecret();
	assert.match(s, /^[A-Z2-7]{32}$/);
	assert.notEqual(s, totp.generateSecret());
});

test("核对：当前、前后 30 秒能过，再远的不行，格式不对的不行", () => {
	const s = totp.generateSecret();
	const now = 1_800_000_000_000;
	const c = Math.floor(now / 30000);
	assert.equal(totp.verify(s, totp.codeAt(s, c), { now }), c);
	assert.equal(totp.verify(s, totp.codeAt(s, c - 1), { now }), c - 1);
	assert.equal(totp.verify(s, totp.codeAt(s, c + 1), { now }), c + 1);
	assert.equal(totp.verify(s, totp.codeAt(s, c - 3), { now }), -1);
	assert.equal(totp.verify(s, "12345", { now }), -1);
	assert.equal(totp.verify(s, "abcdef", { now }), -1);
	assert.equal(totp.verify(s, ` ${totp.codeAt(s, c).slice(0, 3)} ${totp.codeAt(s, c).slice(3)} `, { now }), c, "带空格也认");
});

test("用过的 30 秒不再认（防同一个数字被截下来再用）", () => {
	const s = totp.generateSecret();
	const now = 1_800_000_000_000;
	const c = Math.floor(now / 30000);
	assert.equal(totp.verify(s, totp.codeAt(s, c), { now, notBefore: c }), -1);
	assert.equal(totp.verify(s, totp.codeAt(s, c - 1), { now, notBefore: c - 1 }), -1);
});

test("验证器二维码内容", () => {
	const uri = totp.otpauthUri({ secret: "ABC", account: "admin" });
	assert.equal(uri, "otpauth://totp/vpssh%3Aadmin?secret=ABC&issuer=vpssh&algorithm=SHA1&digits=6&period=30");
});
