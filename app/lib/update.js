// lib/update.js — 桌面版有没有新版本：看 GitHub 上 vpssh 最新的 Release，有就给这台电脑对应的安装包
//
// 只提醒、不自己装：点「下载新版」在浏览器里下载安装包，装上覆盖旧版（服务器列表、登录状态都留着）。
"use strict";

const RELEASES_API = "https://api.github.com/repos/AIcivilization/vpssh/releases/latest";
const RELEASES_PAGE = "https://github.com/AIcivilization/vpssh/releases/latest";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** a 比 b 新返回正数（预发布版比同号正式版旧） */
function compareVersions(a, b) {
	const x = SEMVER.exec(a);
	const y = SEMVER.exec(b);
	if (!x || !y) return 0;
	for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
	if (!x[4] || !y[4]) return (x[4] ? 0 : 1) - (y[4] ? 0 : 1);
	return x[4] < y[4] ? -1 : x[4] > y[4] ? 1 : 0;
}

/** 这台电脑该下哪个安装包（发布流程里的文件名：vpssh-<版本>-mac-arm64.dmg / -mac-x64.dmg / -win-x64.exe） */
function pickAsset(assets, platform, arch) {
	const suffix = platform === "darwin" ? (arch === "arm64" ? "-mac-arm64.dmg" : "-mac-x64.dmg") : platform === "win32" ? "-win-x64.exe" : null;
	if (!suffix) return null;
	const a = (assets || []).find((x) => typeof x?.name === "string" && x.name.endsWith(suffix));
	return a ? a.browser_download_url : null;
}

/**
 * 查一次。fetchFn：fetch 一样的函数（桌面版里用 Electron 的 net.fetch，走系统代理）。
 * 返回 { current, latest, available, url }；查不到返回 { current, error }
 */
async function checkLatest({ fetchFn, current, platform = process.platform, arch = process.arch }) {
	try {
		const res = await fetchFn(RELEASES_API, { headers: { accept: "application/vnd.github+json", "user-agent": `vpssh-desktop/${current}` } });
		if (!res.ok) return { current, error: `HTTP ${res.status}` };
		const body = await res.json();
		const latest = String(body.tag_name || "").replace(/^v/, "");
		if (!SEMVER.test(latest)) return { current, error: "bad tag" };
		return {
			current,
			latest,
			available: compareVersions(latest, current) > 0,
			url: pickAsset(body.assets, platform, arch) || body.html_url || RELEASES_PAGE,
		};
	} catch (err) {
		return { current, error: String(err?.message || err) };
	}
}

module.exports = { compareVersions, pickAsset, checkLatest, RELEASES_PAGE };
