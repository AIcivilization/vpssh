// lib/store.js — 桌面版记住的东西：服务器列表、上次打开的是哪台、窗口大小
//
// 存在应用数据目录的 servers.json。不存密码。每台服务器记：
//   id、name（显示名）、url（访问地址）、ssh（host/port/user，卸载时预填）、
//   hostKey（SSH 主机指纹）、rootPem（用 IP 访问时钉住的 Caddy 根证书）
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class Store {
	constructor(dir) {
		this.file = path.join(dir, "servers.json");
		this.data = { servers: [], lastId: "", window: null };
		try {
			const d = JSON.parse(fs.readFileSync(this.file, "utf8"));
			if (Array.isArray(d.servers)) this.data = { ...this.data, ...d };
		} catch {
			/* 第一次运行 */
		}
	}
	save() {
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, this.file);
	}
	list() {
		return this.data.servers;
	}
	get(id) {
		return this.data.servers.find((s) => s.id === id);
	}
	/** 同一个访问地址只留一条：重装同一台服务器时更新它 */
	upsert(server) {
		const origin = new URL(server.url).origin;
		const old = this.data.servers.find((s) => s.id === server.id || new URL(s.url).origin === origin);
		if (old) Object.assign(old, server, { id: old.id });
		else this.data.servers.push({ id: crypto.randomUUID(), addedAt: new Date().toISOString(), ...server });
		this.save();
		return old || this.data.servers[this.data.servers.length - 1];
	}
	remove(id) {
		this.data.servers = this.data.servers.filter((s) => s.id !== id);
		if (this.data.lastId === id) this.data.lastId = "";
		this.save();
	}
	/** 按访问地址的 origin 找服务器（证书验证、导航判断用） */
	byOrigin(origin) {
		return this.data.servers.find((s) => {
			try {
				return new URL(s.url).origin === origin;
			} catch {
				return false;
			}
		});
	}
	byHostname(hostname) {
		return this.data.servers.filter((s) => {
			try {
				return new URL(s.url).hostname.replace(/^\[|\]$/g, "") === hostname;
			} catch {
				return false;
			}
		});
	}
}

module.exports = { Store };
