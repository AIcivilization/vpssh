// gate/totp.js — 两步验证：手机验证器 App（Google Authenticator、Microsoft Authenticator、1Password…）里的 6 位数字
//
// 标准 TOTP（RFC 6238）：SHA-1、30 秒一换、6 位。前后各多认一个 30 秒（手机和服务器的钟差一点也能过）。
"use strict";

const crypto = require("node:crypto");

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

function base32Encode(buf) {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

function base32Decode(text) {
	const clean = String(text).toUpperCase().replace(/[\s=-]/g, "");
	let bits = 0;
	let value = 0;
	const out = [];
	for (const ch of clean) {
		const i = ALPHABET.indexOf(ch);
		if (i < 0) throw new Error("bad base32");
		value = (value << 5) | i;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

/** 新密钥：20 字节随机数（base32，验证器 App 里手动输入也用它） */
function generateSecret() {
	return base32Encode(crypto.randomBytes(20));
}

/** 第 counter 个 30 秒的 6 位数字 */
function codeAt(secret, counter) {
	const msg = Buffer.alloc(8);
	msg.writeBigUInt64BE(BigInt(counter));
	const mac = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
	const offset = mac[mac.length - 1] & 15;
	const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
	return String(n).padStart(DIGITS, "0");
}

/**
 * 核对 6 位数字：对得上返回它属于第几个 30 秒（拿来防同一个数字用两次），对不上返回 -1。
 * notBefore：这个及以前的 30 秒已经用过了，不再认
 */
function verify(secret, code, { now = Date.now(), window = 1, notBefore = -1 } = {}) {
	const digits = String(code ?? "").replace(/\s/g, "");
	if (!/^\d{6}$/.test(digits)) return -1;
	const current = Math.floor(now / 1000 / STEP_SECONDS);
	for (let d = -window; d <= window; d++) {
		const counter = current + d;
		if (counter <= notBefore) continue;
		const expected = codeAt(secret, counter);
		if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(digits))) return counter;
	}
	return -1;
}

/** 验证器 App 扫的二维码内容 */
function otpauthUri({ secret, account, issuer = "vpssh" }) {
	const label = encodeURIComponent(`${issuer}:${account}`);
	return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { generateSecret, codeAt, verify, otpauthUri, base32Encode, base32Decode, STEP_SECONDS };
