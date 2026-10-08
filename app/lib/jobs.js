// lib/jobs.js — 一次安装 / 卸载任务：SSH 登录 → 服务器后台执行 → 跟着看日志（断线自动重连）→ 装完读访问地址和根证书
"use strict";

const { connect, runAsRoot, SshError } = require("./ssh.js");
const { startScript, attachScript, INFO_SCRIPT, parseInfo, parseLog, strip } = require("./remote.js");

const RECONNECT_TRIES = 30;
const RECONNECT_DELAY_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * opts：validate() 规整过的表单。emit(event)：
 *   { type: "phase", phase: "connecting" | "running" | "reconnecting" | "finishing" }
 *   { type: "log", text, step, total }
 * 返回 { exitCode, setupUrl, openUrl, host, rootPem, fingerprint, error }
 */
async function runJob(opts, { lang = "en", knownFingerprint = "", emit = () => {}, deps = {} } = {}) {
	const doConnect = deps.connect || connect;
	const asRoot = deps.runAsRoot || runAsRoot;
	const pause = deps.sleep || sleep;

	emit({ type: "phase", phase: "connecting" });
	let { conn, fingerprint } = await doConnect(opts, { knownFingerprint });
	knownFingerprint = fingerprint;
	let log = "";
	const onData = (chunk) => {
		log += chunk;
		const p = parseLog(log);
		emit({ type: "log", text: strip(chunk), step: p.step, total: p.total });
	};
	try {
		emit({ type: "phase", phase: "running" });
		try {
			await asRoot(conn, startScript(opts, lang), { password: opts.password, onData });
		} catch (err) {
			if (err instanceof SshError) throw err;
			// 执行中断线：下面重连接着看
		}
		let parsed = parseLog(log);
		for (let i = 0; parsed.exitCode === null && !parsed.error && i < RECONNECT_TRIES; i++) {
			emit({ type: "phase", phase: "reconnecting", attempt: i + 1 });
			try { conn.end(); } catch { /* 已断 */ }
			await pause(RECONNECT_DELAY_MS);
			try {
				({ conn } = await doConnect(opts, { knownFingerprint }));
			} catch (err) {
				if (err instanceof SshError && (err.code === "auth" || err.code === "host_key")) throw err;
				continue;
			}
			emit({ type: "phase", phase: "running", reattached: true });
			const before = log;
			log = "";
			emit({ type: "log", reset: true, text: "" });
			try {
				await asRoot(conn, attachScript(opts.action), { password: opts.password, onData });
			} catch (err) {
				if (err instanceof SshError) throw err;
			}
			if (!log) log = before;
			parsed = parseLog(log);
		}
		if (parsed.exitCode === null && !parsed.error) {
			throw new SshError("lost", "和服务器的连接一直断着。安装可能仍在服务器上进行：稍后用「连接已装好的服务器」再试", "Lost the connection to the server. The install may still be running there: try again later with \"Connect to an installed server\"");
		}
		const result = { ...parsed, fingerprint, host: "", rootPem: "" };
		if (opts.action === "install" && (parsed.exitCode === 0 || parsed.exitCode === 3)) {
			emit({ type: "phase", phase: "finishing" });
			const info = await asRoot(conn, INFO_SCRIPT, { password: opts.password });
			Object.assign(result, parseInfo(info.out));
		}
		return result;
	} finally {
		try { conn.end(); } catch { /* 已断 */ }
	}
}

/** 只读访问地址和根证书（「连接已装好的服务器」用 IP 时） */
async function readServerInfo(opts, { knownFingerprint = "" } = {}) {
	const { conn, fingerprint } = await connect(opts, { knownFingerprint });
	try {
		const info = await runAsRoot(conn, INFO_SCRIPT, { password: opts.password });
		return { ...parseInfo(info.out), fingerprint };
	} finally {
		conn.end();
	}
}

module.exports = { runJob, readServerInfo };
