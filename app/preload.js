// preload.js — 只给桌面版自己的本地页面（file://）开放安装接口；服务器上的网页拿不到
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

if (location.protocol === "file:") {
	contextBridge.exposeInMainWorld("vpssh", {
		state: () => ipcRenderer.invoke("state"),
		open: (id) => ipcRenderer.invoke("open", id),
		remove: (id) => ipcRenderer.invoke("remove", id),
		pickKey: () => ipcRenderer.invoke("pick-key"),
		localKey: (generate) => ipcRenderer.invoke("local-key", Boolean(generate)),
		localKeys: (host) => ipcRenderer.invoke("local-keys", String(host || "")),
		testLogin: (form) => ipcRenderer.invoke("test-login", form),
		startJob: (form) => ipcRenderer.invoke("job-start", form),
		connect: (form) => ipcRenderer.invoke("connect", form),
		openExternal: (url) => ipcRenderer.invoke("open-external", url),
		onJob: (cb) => ipcRenderer.on("job", (_e, ev) => cb(ev)),
		onUpdate: (cb) => ipcRenderer.on("update", (_e, info) => cb(info)),
	});
}
