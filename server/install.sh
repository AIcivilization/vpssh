#!/usr/bin/env bash
# vpssh 一键安装脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/AIcivilization/vpssh/main/server/install.sh \
#     | sudo bash -s -- --domain vps.example.com
#   # 或在仓库克隆目录内：
#   sudo bash server/install.sh --domain vps.example.com [--mirror cn]
#
# 目标 OS：Ubuntu 22.04+ / Debian 12+（裸机，无 Docker）
#
# 装什么：Node 22 → DSH（npm 原样、钉住版本）→ vpssh 插件（本仓库 plugin/）→ 登录网关 → Caddy → systemd。
# 仓库文件：在克隆目录内运行时用本地文件；curl 管道模式先把整个仓库（VPSSH_REF 指定的分支或标签）下载下来再装。

set -euo pipefail

## region: 常量与参数

DSH_VERSION="0.2.0-rc.2" # 钉住版本（设计文档 §10 已验证版本表，勿随意改）
# 只钉顶层包版本是不够的：DSH 各子包的依赖是 ^0.1.5-rc.2 这类浮动范围，上游一发新的
# 预发布波次，解析结果就整体漂上去。2026-09-22 上游发了 0.1.5-rc.3 波次，但漏发了
# dsh-client-ui-sidebar-documentpreview，于是 ETARGET 装不上。用 --before 把解析冻结在
# 验证通过的那个时间点之前，装到的就是验证过的那棵树。升级 DSH_VERSION 时同步推后这个值。
# 注意：同一天 03:46 上游还先发了一批 cordis 系列（cordis 4.0.3 / cordis-plugin-hmr 1.0.18 等），
# 与 rc.2 不兼容——web profile 启动即报 "user patch-layer watching requires the Cordis HMR service"。
# 冻结点必须早于这一批，所以是 03:40 而不是 05:00。
# 之后升到 0.1.7-rc.1（npm next 渠道），冻结点 2026-09-24T08:20Z——该时刻解析出的依赖树已逐包比对、实测通过。
# vpssh 换到 0.2.0-rc.2（右侧栏从 0.2 起才有）。冻结点 2026-10-02T00:00Z：rc.2 发布（09-29）三天后、0.2.1-alpha 波次（10-03）之前。
# 设为 none 可关闭冻结。
VPSSH_VERSION=""
DSH_RESOLVE_BEFORE_SET="${DSH_RESOLVE_BEFORE:+1}" # 用户显式指定过就不被 manifest 覆盖
DSH_RESOLVE_BEFORE="${DSH_RESOLVE_BEFORE:-2026-10-02T00:00:00Z}"
INSTALL_ROOT="/opt/vpssh"
DSH_USER="vpssh"
DSH_HOME_DIR="/home/vpssh/.dsh"
GATE_PORT=3100
DSH_PORT=3080
# 仓库来源：curl 管道模式下载这个分支或标签的整个仓库
REPO_TARBALL="${VPSSH_TARBALL:-https://codeload.github.com/AIcivilization/vpssh/tar.gz/${VPSSH_REF:-main}}"

DOMAIN=""
MIRROR=""
FORCE_IP=""

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install]\033[0m %s\n' "$*" >&2; exit 1; }
# 输出跟系统语言：zh 开头用中文，否则英文。写法：M '中文' 'English'
M() { case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }

usage() {
	if [[ "$(M zh en)" == zh ]]; then
		cat <<'EOF'
vpssh 安装脚本
用法: sudo bash install.sh [--domain <域名>] [--mirror cn] [--ip <IP>]
  --domain <域名>   访问域名（需已解析到本机）。不传则用公网 IP + 自签证书
  --mirror cn       国内镜像：Node 和 DSH 都从 npmmirror 下载
  --ip <IP>         不传 --domain 时用这个 IP 访问（默认自动探测公网 IP；内网、多 IP、测试机时用）
EOF
	else
		cat <<'EOF'
vpssh installer
Usage: sudo bash install.sh [--domain <domain>] [--mirror cn] [--ip <IP>]
  --domain <domain>  Address to use (its A record must point here). Without it: the public IP and a self-signed certificate
  --mirror cn        Download Node and DSH from npmmirror (mainland China)
  --ip <IP>          Without --domain, use this IP (default: detect the public IP; for private networks, several IPs, test machines)
EOF
	fi
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--domain) DOMAIN="${2:?--domain 需要一个值}"; shift 2 ;;
	--mirror) MIRROR="${2:?--mirror 需要一个值}"; shift 2 ;;
	--ip) FORCE_IP="${2:?--ip 需要一个值}"; shift 2 ;;
	-h | --help) usage; exit 0 ;;
	*) die "$(M "未知参数: $1（--help 查看用法）" "Unknown option: $1 (see --help)")" ;;
	esac
done

[[ "$MIRROR" == "" || "$MIRROR" == "cn" ]] || die "$(M "--mirror 目前仅支持 cn" "--mirror only supports cn")"
if [[ -n "$DOMAIN" ]]; then
	[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] \
		|| die "$(M "域名格式不合法: $DOMAIN" "Invalid domain: $DOMAIN")"
fi

SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
	SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
fi

# 仓库根目录：本地克隆（server/ 的上一级）优先，否则下载整个仓库
REPO_DIR=""
fetch_repo() {
	if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/gate/server.js" && -f "$SCRIPT_DIR/../plugin/package.json" ]]; then
		REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
		return 0
	fi
	command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y curl ca-certificates >/dev/null; }
	local tmp
	tmp=$(mktemp -d /tmp/vpssh-src.XXXXXX)
	log "$(M "下载 vpssh：${REPO_TARBALL}" "Downloading vpssh: ${REPO_TARBALL}")"
	curl -fsSL --retry 2 "$REPO_TARBALL" | tar -xz -C "$tmp" --strip-components=1 \
		|| die "$(M "下载 vpssh 失败：${REPO_TARBALL}" "Could not download vpssh: ${REPO_TARBALL}")"
	[[ -f "$tmp/server/gate/server.js" && -f "$tmp/plugin/package.json" ]] || die "$(M "下载的 vpssh 不完整" "The downloaded vpssh is incomplete")"
	REPO_DIR="$tmp"
}

# DSH 版本与冻结点以仓库根目录的 manifest.json 为准（上面的常量只是读不到时的兜底）
read_manifest() {
	local m="$REPO_DIR/manifest.json" v rb
	[[ -f "$m" ]] || return 0
	v=$(sed -n 's/^ *"dsh": *"\([^"]*\)".*/\1/p' "$m" | head -1)
	rb=$(sed -n 's/^ *"resolveBefore": *"\([^"]*\)".*/\1/p' "$m" | head -1)
	VPSSH_VERSION=$(sed -n 's/^ *"vpssh": *"\([^"]*\)".*/\1/p' "$m" | head -1)
	[[ -n "$v" ]] && DSH_VERSION="$v"
	[[ -n "$rb" && -z "${DSH_RESOLVE_BEFORE_SET:-}" ]] && DSH_RESOLVE_BEFORE="$rb"
	return 0
}

# 取仓库文件（路径相对于 server/）
fetch_file() { # $1=server/ 内相对路径 $2=目标路径
	install -m 644 "$REPO_DIR/server/$1" "$2"
}

export DEBIAN_FRONTEND=noninteractive
trap 'warn "$(M "安装失败（行 ${LINENO}），可用 journalctl -u vpssh -n 50 排查服务问题" "Install failed (line ${LINENO}); see journalctl -u vpssh -n 50")"' ERR

## endregion

## region: 步骤 1：前置检查

REINSTALL=0

step1_prechecks() {
	log "$(M "步骤 1/11：前置检查" "Step 1/11: checks")"
	[[ $EUID -eq 0 ]] || die "$(M "请用 root 运行（sudo bash install.sh ...）" "Run as root (sudo bash install.sh ...)")"
	command -v curl >/dev/null 2>&1 || { apt-get update -y >/dev/null; apt-get install -y curl ca-certificates >/dev/null; }

	# OS 检查
	. /etc/os-release
	local ok=0
	case "${ID:-}" in
	ubuntu) awk -v v="${VERSION_ID:-0}" 'BEGIN{exit !(v>=22.04)}' && ok=1 ;;
	debian) awk -v v="${VERSION_ID:-0}" 'BEGIN{exit !(v>=12)}' && ok=1 ;;
	esac
	[[ $ok -eq 1 ]] || die "$(M "不支持的发行版: ${ID:-unknown} ${VERSION_ID:-}（目标：Ubuntu 22.04+ / Debian 12+）" "Unsupported system: ${ID:-unknown} ${VERSION_ID:-} (needs Ubuntu 22.04+ / Debian 12+)")"

	# glibc 检查（Ubuntu 22.04=2.35 / Debian 12=2.36，正常必然通过，仅告警）
	local glibc
	glibc=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
	awk -v v="$glibc" 'BEGIN{exit !(v>=2.28)}' || warn "$(M "glibc $glibc < 2.28，DSH 可能无法运行" "glibc $glibc < 2.28; DSH may not run")"

	# 内存检查（< 1.5G 仅告警）
	local mem_kb
	mem_kb=$(awk '/MemTotal/{print $2}' /proc/meminfo)
	[[ "$mem_kb" -lt 1572864 ]] && warn "$(M "内存 $((mem_kb / 1024))MB 低于建议的 1.5GB，体验可能不稳定" "Only $((mem_kb / 1024)) MB of memory; it may be slow or unstable")"

	# 幂等判定：已有安装则进入修复/更新模式（不碰 state/ 内的凭据与 setup.lock）
	[[ -f "$INSTALL_ROOT/state/config.json" ]] && REINSTALL=1

	# 端口检查（重装时本机服务已占用这些端口，跳过）
	if [[ $REINSTALL -eq 0 ]]; then
		local p
		for p in 80 443 "$DSH_PORT" "$GATE_PORT"; do
			if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"; then
				die "$(M "端口 $p 已被占用，请先释放（重装场景请保留 $INSTALL_ROOT 后重跑）" "Port $p is in use; free it first (to reinstall, keep $INSTALL_ROOT and run again)")"
			fi
		done
	else
		log "$(M "检测到已有安装（${INSTALL_ROOT}），进入修复/更新模式（保留 state/）" "Found an existing install (${INSTALL_ROOT}); repairing/updating it (state/ is kept)")"
	fi
}

## endregion

## region: 步骤 2：Node.js 22

install_node_nodesource() {
	curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
	bash /tmp/nodesource_setup.sh >/dev/null
	apt-get install -y nodejs >/dev/null
}

install_node_cn() {
	# npmmirror 二进制镜像：取 latest-v22.x 目录中最新的 linux-x64 包并校验 sha256
	local list pkg
	list=$(curl -fsSL --max-time 30 "https://registry.npmmirror.com/-/binary/node/latest-v22.x/")
	pkg=$(printf '%s' "$list" | grep -o 'node-v22[0-9.]*-linux-x64\.tar\.xz' | sort -Vu | tail -1)
	[[ -n "$pkg" ]] || die "$(M "无法从 npmmirror 获取 Node 22 版本号" "Could not get the Node 22 version from npmmirror")"
	log "$(M "下载 Node.js: ${pkg}（npmmirror）" "Downloading Node.js: ${pkg} (npmmirror)")"
	curl -fsSL --retry 2 -o "/tmp/$pkg" "https://registry.npmmirror.com/-/binary/node/latest-v22.x/$pkg"
	(cd /tmp && curl -fsSL "https://registry.npmmirror.com/-/binary/node/latest-v22.x/SHASUMS256.txt" \
		| grep "${pkg}\$" | sha256sum -c - >/dev/null) || die "$(M "Node 包 sha256 校验失败" "Node package sha256 check failed")"
	tar -xJf "/tmp/$pkg" -C /usr/local --strip-components=1
	rm -f "/tmp/$pkg"
	hash -r
}

step2_node() {
	log "$(M "步骤 2/11：Node.js 22 + pnpm" "Step 2/11: Node.js 22 + pnpm")"
	local major
	major=$(node --version 2>/dev/null | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p' || true)
	if [[ "${major:-0}" -ge 22 ]]; then
		log "$(M "已安装 Node $(node --version)，跳过" "Node $(node --version) already installed")"
	else
		apt-get update -y >/dev/null
		if [[ "$MIRROR" == "cn" ]]; then install_node_cn; else install_node_nodesource; fi
		major=$(node --version | sed -n 's/^v\{0,1\}\([0-9]\{1,\}\).*/\1/p')
		[[ "${major:-0}" -ge 22 ]] || die "$(M "Node.js 22 安装失败" "Installing Node.js 22 failed")"
		log "$(M "Node $(node --version) 安装完成" "Node $(node --version) installed")"
	fi

	# pnpm：`dsh plugin` 管理插件依赖的包管理器（/setup 向导可选安装插件需要）
	if ! command -v pnpm >/dev/null 2>&1; then
		log "$(M "安装 pnpm（插件管理需要）" "Installing pnpm")"
		if [[ "$MIRROR" == "cn" ]]; then
			npm install -g pnpm --registry=https://registry.npmmirror.com >/dev/null 2>&1 \
				|| npm install -g pnpm >/dev/null 2>&1 || true
		else
			npm install -g pnpm >/dev/null 2>&1 || true
		fi
	fi
	command -v pnpm >/dev/null 2>&1 || warn "$(M "pnpm 未安装，插件安装功能不可用（可稍后 npm i -g pnpm）" "pnpm is not installed (npm i -g pnpm later)")"
}

## endregion

## region: 步骤 3：DSH 版本化安装

step3_dsh() {
	log "$(M "步骤 3/11：DeepSeek Harness ${DSH_VERSION}（版本化安装）" "Step 3/11: DeepSeek Harness ${DSH_VERSION}")"
	local prefix="$INSTALL_ROOT/dsh/$DSH_VERSION"
	local bin="$prefix/node_modules/@deepseek-ai/dsh/lib/bin.js"
	if [[ -f "$bin" ]]; then
		log "$(M "DSH $DSH_VERSION 已安装，跳过" "DSH $DSH_VERSION already installed")"
	else
		mkdir -p "$prefix"
		# 数组恒不为空：bash 3.2 在 set -u 下展开空数组会报 unbound variable
		local args=(--no-audit --no-fund --loglevel=error)
		[[ "$MIRROR" == "cn" ]] && args+=(--registry=https://registry.npmmirror.com)
		local frozen=1
		[[ "$DSH_RESOLVE_BEFORE" == "none" ]] && frozen=0
		[[ $frozen -eq 1 ]] && args+=(--before="$DSH_RESOLVE_BEFORE")
		if ! npm install --prefix "$prefix" "${args[@]}" "@deepseek-ai/dsh@$DSH_VERSION"; then
			# 冻结解析本身失败（例如镜像源不带发布时间戳）时退化为不冻结，
			# 宁可装到未验证的新预发布版，也别让安装卡死在这一步。
			if [[ $frozen -eq 1 ]]; then
				warn "$(M "按时间点冻结解析失败，改为不冻结重试（可能装到未验证的新版本）" "Frozen dependency resolution failed; retrying without it (may get untested versions)")"
				local args2=(--no-audit --no-fund --loglevel=error)
				[[ "$MIRROR" == "cn" ]] && args2+=(--registry=https://registry.npmmirror.com)
				npm install --prefix "$prefix" "${args2[@]}" "@deepseek-ai/dsh@$DSH_VERSION"
			fi
		fi
		[[ -f "$bin" ]] || die "$(M "DSH 安装产物缺失: $bin" "DSH install is missing $bin")"
	fi
	ln -sfn "$DSH_VERSION" "$INSTALL_ROOT/dsh/current"
}

## endregion

## region: 步骤 4：运行身份

step4_user() {
	log "$(M "步骤 4/11：系统用户 $DSH_USER" "Step 4/11: system user $DSH_USER")"
	if ! id "$DSH_USER" >/dev/null 2>&1; then
		useradd --system --shell /usr/sbin/nologin --home-dir /home/vpssh --create-home "$DSH_USER"
	fi
	mkdir -p "$DSH_HOME_DIR"
	# 从备份恢复时文件先放回来、用户后建，uid 可能对不上：整个家目录交还给 vpssh
	chown -R "$DSH_USER:" /home/vpssh
	if [[ -d "$INSTALL_ROOT/state" ]]; then chown -R "$DSH_USER:" "$INSTALL_ROOT/state"; fi
	chmod 700 "$DSH_HOME_DIR"
}

## endregion

## region: 步骤 5：钥匙保管与本机账号

KEYS_USER="vpssh-keys"
LOCAL_ADMIN="vpssh-admin"
KEY_PUB="/var/lib/vpssh-keys/vpssh_ed25519.pub"
LOCAL_SSH_PORT=22

# 1) vpssh-keyd：私钥只有 vpssh-keys 用户能读，vpssh 只能请它签名（见 keyd/keyd.js）
# 2) 本机账号 vpssh-admin：vpssh 经本机 SSH 管这台机器自己，和管别的机器一样走确认。
#    只接受从 127.0.0.1 用 vpssh 的钥匙登录，没有密码；免密 sudo（管服务器离不开它）
step5_keys() {
	log "$(M "步骤 5/11：钥匙保管与本机账号" "Step 5/11: key holder and local account")"
	id "$KEYS_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin --no-create-home --home-dir /nonexistent "$KEYS_USER"
	mkdir -p "$INSTALL_ROOT/keyd"
	fetch_file keyd/keyd.js "$INSTALL_ROOT/keyd/keyd.js"
	node --check "$INSTALL_ROOT/keyd/keyd.js" || die "$(M "keyd/keyd.js 语法检查失败" "keyd/keyd.js failed its syntax check")"
	fetch_file units/vpssh-keyd.service /tmp/vpssh-keyd.service.tpl
	sed "s|__NODE_BIN__|$(command -v node)|" /tmp/vpssh-keyd.service.tpl >/etc/systemd/system/vpssh-keyd.service
	systemctl daemon-reload
	systemctl enable vpssh-keyd >/dev/null 2>&1
	systemctl restart vpssh-keyd
	local i
	for i in $(seq 1 20); do [[ -s "$KEY_PUB" && -S /run/vpssh-keys/agent.sock ]] && break; sleep 0.5; done
	[[ -s "$KEY_PUB" ]] || die "$(M "vpssh-keyd 没有生成钥匙，见 journalctl -u vpssh-keyd -n 30" "vpssh-keyd did not create a key; see journalctl -u vpssh-keyd -n 30")"

	# 本机 SSH 服务：没有就装上
	if ! command -v sshd >/dev/null 2>&1; then
		log "$(M "安装 openssh-server（vpssh 经本机 SSH 管理这台机器）" "Installing openssh-server (vpssh manages this machine over local SSH)")"
		apt-get install -y openssh-server >/dev/null
	fi
	systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || true
	LOCAL_SSH_PORT=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2; exit}')
	LOCAL_SSH_PORT="${LOCAL_SSH_PORT:-22}"

	if ! id "$LOCAL_ADMIN" >/dev/null 2>&1; then
		useradd --create-home --shell /bin/bash "$LOCAL_ADMIN"
		passwd -l "$LOCAL_ADMIN" >/dev/null
	fi
	local sudoers="/etc/sudoers.d/vpssh-admin"
	printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$LOCAL_ADMIN" >"$sudoers.tmp"
	chmod 440 "$sudoers.tmp"
	visudo -cf "$sudoers.tmp" >/dev/null || die "$(M "sudoers 校验失败" "sudoers check failed")"
	mv "$sudoers.tmp" "$sudoers"
	local home ssh_dir
	home=$(getent passwd "$LOCAL_ADMIN" | cut -d: -f6)
	ssh_dir="$home/.ssh"
	mkdir -p "$ssh_dir"
	printf 'from="127.0.0.1,::1",no-agent-forwarding,no-X11-forwarding %s\n' "$(cat "$KEY_PUB")" >"$ssh_dir/authorized_keys"
	chown -R "$LOCAL_ADMIN:" "$ssh_dir"
	chmod 700 "$ssh_dir"
	chmod 600 "$ssh_dir/authorized_keys"
	# sshd 限制了 AllowUsers / AllowGroups 时提醒（不替用户改 sshd 配置）
	if sshd -T 2>/dev/null | grep -qiE '^(allowusers|allowgroups) '; then
		warn "$(M "sshd 设了 AllowUsers/AllowGroups：请把 $LOCAL_ADMIN 加进去，否则 vpssh 管不了这台机器" "sshd uses AllowUsers/AllowGroups: add $LOCAL_ADMIN, or vpssh cannot manage this machine")"
	fi
	log "$(M "钥匙由 vpssh-keyd 保管；本机账号 $LOCAL_ADMIN（SSH 端口 $LOCAL_SSH_PORT）" "Key held by vpssh-keyd; local account $LOCAL_ADMIN (SSH port $LOCAL_SSH_PORT)")"
}

## endregion

## region: 步骤 6：vpssh 插件

# vpssh 的全部功能都在这个 DSH 插件里（本仓库 plugin/）。只装它，不装别的插件。
# 放在 $INSTALL_ROOT/plugin（root 所有），再登记到 DSH 的 web profile。
# 登记时 pnpm 要复制文件（copy）：默认的硬链接碰到 root 的文件会被内核拒绝（protected_hardlinks）；
# 也不能用 link: 软链接，插件按需加载的 @deepseek-ai/* 包要从 profile 里解析。
step5_plugin() {
	log "$(M "步骤 6/11：vpssh 插件" "Step 6/11: vpssh plugin")"
	local dst="$INSTALL_ROOT/plugin"
	rm -rf "$dst.new"
	mkdir -p "$dst.new"
	(cd "$REPO_DIR/plugin" && tar -cf - --exclude=node_modules --exclude=test --exclude=scripts .) | tar -xf - -C "$dst.new"
	local args=(--omit=dev --no-audit --no-fund --loglevel=error)
	[[ "$MIRROR" == "cn" ]] && args+=(--registry=https://registry.npmmirror.com)
	(cd "$dst.new" && npm ci "${args[@]}") || die "$(M "vpssh 插件依赖安装失败" "Installing the vpssh plugin's dependencies failed")"
	rm -rf "$dst.old"
	[[ -d "$dst" ]] && mv "$dst" "$dst.old"
	mv "$dst.new" "$dst"
	rm -rf "$dst.old"
	chown -R root:root "$dst"
	chmod -R go-w "$dst"

	local dsh_bin="$INSTALL_ROOT/dsh/current/node_modules/@deepseek-ai/dsh/lib/bin.js"
	runuser -u "$DSH_USER" -- env HOME=/home/vpssh DSH_HOME="$DSH_HOME_DIR" pnpm_config_minimum_release_age=0 pnpm_config_package_import_method=copy \
		node "$dsh_bin" plugin --profile web add "file:$dst" \
		|| die "$(M "vpssh 插件登记到 DSH 失败" "Registering the vpssh plugin with DSH failed")"
	log "$(M "vpssh 插件已安装" "vpssh plugin installed")"
}

## endregion

## region: 步骤 7：vpssh 网关

# 一次性启动令牌：初始向导在安装结束到用户首次打开浏览器之间是全网可达的，
# 谁先提交谁就是管理员。令牌写进 state/setup.token，向导提交成功后由 gate 删除。
generate_setup_token() {
	SETUP_TOKEN=""
	[[ -f "$INSTALL_ROOT/state/setup.lock" ]] && return 0
	local tok
	tok=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 32)
	if [[ ${#tok} -lt 24 ]]; then
		warn "$(M "启动令牌生成失败，向导将不校验令牌" "Could not create the setup token; the wizard will not check one")"
		return 0
	fi
	printf '%s' "$tok" >"$INSTALL_ROOT/state/setup.token"
	chown "$DSH_USER" "$INSTALL_ROOT/state/setup.token" 2>/dev/null || true
	chmod 600 "$INSTALL_ROOT/state/setup.token"
	SETUP_TOKEN="$tok"
	log "$(M "已生成一次性启动令牌" "One-time setup token created")"
}

step6_gate() {
	log "$(M "步骤 7/11：vpssh 网关" "Step 7/11: vpssh gateway")"
	mkdir -p "$INSTALL_ROOT/gate" "$INSTALL_ROOT/bin"
	fetch_file gate/server.js "$INSTALL_ROOT/gate/server.js"
	node --check "$INSTALL_ROOT/gate/server.js" || die "$(M "gate/server.js 语法检查失败" "gate/server.js failed its syntax check")"
	fetch_file gate/site-block.js "$INSTALL_ROOT/gate/site-block.js"
	node --check "$INSTALL_ROOT/gate/site-block.js" || die "$(M "gate/site-block.js 语法检查失败" "gate/site-block.js failed its syntax check")"
	fetch_file bin/vpssh "$INSTALL_ROOT/bin/vpssh"
	# 卸载脚本留一份在服务器上：sudo vpssh uninstall、网页上的「卸载」都用它
	fetch_file uninstall.sh "$INSTALL_ROOT/uninstall.sh"
	chmod 755 "$INSTALL_ROOT/bin/vpssh"
	bash -n "$INSTALL_ROOT/bin/vpssh" || die "$(M "bin/vpssh 语法检查失败" "bin/vpssh failed its syntax check")"
	ln -sfn "$INSTALL_ROOT/bin/vpssh" /usr/local/bin/vpssh
	# 公网域名下浏览器判定 isLoopback=false，设置页会报"设置在此浏览器中不可用"。
	# 直接写前端静态文件解除该判定（DSH 每次响应都重读该文件，无需重启）。
	vpssh ownshost on || warn "$(M "ownsHost 补丁未生效，稍后可手动运行: sudo vpssh ownshost on" "The settings patch did not apply; later run: sudo vpssh ownshost on")"
	mkdir -p "$INSTALL_ROOT/state"
	chmod 700 "$INSTALL_ROOT/state"
	generate_setup_token
}

## endregion

## region: 步骤 8：Caddy

step7_caddy() {
	log "$(M "步骤 8/11：Caddy" "Step 8/11: Caddy")"
	if ! command -v caddy >/dev/null 2>&1; then
		apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gpg >/dev/null
		curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
			| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
		curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
			>/etc/apt/sources.list.d/caddy-stable.list
		apt-get update -y >/dev/null
		apt-get install -y caddy >/dev/null
	fi

	# 主 Caddyfile（静态，import 站点文件）+ 站点文件（向导改域名时由 gate 重写）
	fetch_file caddy/Caddyfile.template /tmp/Caddyfile.vpssh
	if [[ -f /etc/caddy/Caddyfile ]] && ! cmp -s /etc/caddy/Caddyfile /tmp/Caddyfile.vpssh; then
		cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.bak.$(date +%s)"
	fi
	install -m 644 /tmp/Caddyfile.vpssh /etc/caddy/Caddyfile

	# 站点块：有域名写域名块（自动 HTTPS），无则按公网 IP 写站点、Caddy 内置 CA 自签过渡
	# 属主 vpssh（向导重写）、组 caddy（Caddy 读取）、640
	# 站点块由 gate/site-block.js 生成：install.sh 写初始块、gate 改域名、vpssh vpn
	# 切换访问策略，三处共用同一份模板。重装时若 state/vpn.env 还开着隧道模式，
	# 这里会直接沿用「仅隧道可访问」，不会把已经关上的门重新敞开。
	local site="$TRUSTED_HOST"
	node "$INSTALL_ROOT/gate/site-block.js" "$site" "$INSTALL_ROOT" "$GATE_PORT" \
		>/etc/caddy/vpssh-site.conf || die "$(M "生成站点块失败" "Generating the site config failed")"
	chown "$DSH_USER":caddy /etc/caddy/vpssh-site.conf
	chmod 640 /etc/caddy/vpssh-site.conf

	systemctl enable --now caddy >/dev/null 2>&1 || true
	systemctl reload caddy >/dev/null 2>&1 || systemctl restart caddy
	log "$(M "Caddyfile 已生效（站点：${site}）" "Caddy configured (site: ${site})")"
}

## endregion

## region: 步骤 9：systemd + gate.env + config.json

detect_public_ip() {
	local ip url
	if [[ -n "$FORCE_IP" ]]; then
		[[ "$FORCE_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$(M "--ip 不是合法的 IPv4 地址: $FORCE_IP" "--ip is not a valid IPv4 address: $FORCE_IP")"
		printf '%s' "$FORCE_IP"
		return 0
	fi
	for url in https://api.ipify.org https://ifconfig.me https://icanhazip.com; do
		ip=$(curl -4 -fsSL --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]') || continue
		if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			printf '%s' "$ip"
			return 0
		fi
	done
	ip=$(hostname -I 2>/dev/null | awk '{print $1}')
	[[ -n "$ip" ]] || die "$(M "无法探测公网 IP，请显式传 --domain" "Could not detect the public IP; pass --domain or --ip")"
	printf '%s' "$ip"
}

# 访问地址（= DSH --trusted-host = Caddy 站点地址）必须在写站点块之前确定：
# 域名优先；重装且未传 --domain 时沿用已有配置（含向导改过的域名）；最后回退公网 IP。
TRUSTED_HOST=""
CFG_DOMAIN=""
resolve_trusted_host() {
	TRUSTED_HOST="${DOMAIN:-}"
	local existing_domain=""
	# 显式传了 --ip：以它为准，重装时也覆盖原来的访问地址
	[[ -z "$TRUSTED_HOST" && -n "$FORCE_IP" ]] && TRUSTED_HOST=$(detect_public_ip)
	if [[ -z "$TRUSTED_HOST" && $REINSTALL -eq 1 ]]; then
		if [[ -f "$INSTALL_ROOT/state/gate.env" ]]; then
			TRUSTED_HOST=$(sed -n 's/^DSH_TRUSTED_HOST=//p' "$INSTALL_ROOT/state/gate.env" | tail -1)
		fi
		if [[ -f "$INSTALL_ROOT/state/config.json" ]]; then
			existing_domain=$(sed -n 's/.*"domain": *"\([^"]*\)".*/\1/p' "$INSTALL_ROOT/state/config.json" | tail -1)
		fi
	fi
	if [[ -z "$TRUSTED_HOST" ]]; then
		TRUSTED_HOST=$(detect_public_ip)
	fi
	CFG_DOMAIN="${DOMAIN:-$existing_domain}"
}

step8_systemd() {
	log "$(M "步骤 9/11：systemd 服务" "Step 9/11: systemd services")"
	mkdir -p "$INSTALL_ROOT/state" "$INSTALL_ROOT/backups"

	local trusted="$TRUSTED_HOST"
	local cfg_domain="$CFG_DOMAIN"

	# gate.env：集中管理运行环境变量（0600 属主 vpssh，M3 向导改域名后重写并 restart 即可）
	cat >"$INSTALL_ROOT/state/gate.env" <<EOF
GATE_HOME=$INSTALL_ROOT
DSH_BIN=$INSTALL_ROOT/dsh/current/node_modules/@deepseek-ai/dsh/lib/bin.js
DSH_HOME=$DSH_HOME_DIR
DSH_TRUSTED_HOST=$trusted
VPSSH_LOCAL_PORT=$LOCAL_SSH_PORT
EOF
	chmod 600 "$INSTALL_ROOT/state/gate.env"
	chown "$DSH_USER" "$INSTALL_ROOT/state/gate.env"

	# config.json：安装元数据
	cat >"$INSTALL_ROOT/state/config.json" <<EOF
{
  "vpsshVersion": "${VPSSH_VERSION:-}",
  "dshVersion": "$DSH_VERSION",
  "domain": "$cfg_domain",
  "trustedHost": "$trusted",
  "gatePort": $GATE_PORT,
  "dshPort": $DSH_PORT,
  "mirror": "${MIRROR:-default}",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
	chmod 600 "$INSTALL_ROOT/state/config.json"
	chown "$DSH_USER" "$INSTALL_ROOT/state/config.json"
	chown "$DSH_USER" "$INSTALL_ROOT/state" "$INSTALL_ROOT/backups"
	chmod 700 "$INSTALL_ROOT/state"

	# systemd unit（模板替换 node 路径）
	local node_bin
	node_bin=$(command -v node)
	fetch_file units/vpssh.service /tmp/vpssh.service.tpl
	sed "s|__NODE_BIN__|${node_bin}|" /tmp/vpssh.service.tpl >/etc/systemd/system/vpssh.service
	systemctl daemon-reload
	systemctl enable vpssh >/dev/null 2>&1
	systemctl restart vpssh
	log "$(M "vpssh.service 已启动（DSH_TRUSTED_HOST=${trusted}）" "vpssh.service started (address: ${trusted})")"
	# 浏览器一键升级：DSH 有新版本时页面提示，确认后由 root 服务执行升级
	"$INSTALL_ROOT/bin/vpssh" install-units || warn "$(M "一键升级单元安装失败（不影响使用，可稍后 sudo vpssh install-units）" "Could not set up web upgrades (vpssh still works; later run sudo vpssh install-units)")"
}

## endregion

## region: 步骤 10：防火墙

step9_firewall() {
	log "$(M "步骤 10/11：防火墙" "Step 10/11: firewall")"
	if command -v ufw >/dev/null 2>&1; then
		ufw allow 22/tcp >/dev/null
		ufw allow 80/tcp >/dev/null
		ufw allow 443/tcp >/dev/null
		log "$(M "ufw 已放行 22/80/443" "ufw now allows 22/80/443")"
	else
		log "$(M "未检测到 ufw，跳过（请自行确认云厂商安全组放行 80/443）" "No ufw; make sure your provider's firewall allows 80/443")"
	fi
}

## endregion

## region: 步骤 11：健康自检 + 完成输出

wait_gate_health() {
	local i body
	for i in $(seq 1 30); do
		body=$(curl -fsS --max-time 3 "http://127.0.0.1:$GATE_PORT/gate/health" 2>/dev/null) || { sleep 2; continue; }
		if printf '%s' "$body" | grep -q '"gate":"ok"'; then
			printf '%s' "$body"
			return 0
		fi
		sleep 2
	done
	return 1
}

step10_verify() {
	log "$(M "步骤 11/11：健康自检" "Step 11/11: health check")"
	local body healthy=1
	body=$(wait_gate_health) || {
		warn "$(M "gate 未就绪，请查看: journalctl -u vpssh -n 50" "The gateway is not ready; see journalctl -u vpssh -n 50")"
		die "$(M "健康检查失败（gate）" "Health check failed (gateway)")"
	}
	# 等待 DSH 子进程启动 + launchToken 兑换完成（冷启动需要几秒到几十秒，小内存机器更久）
	local i
	for i in $(seq 1 60); do
		body=$(curl -fsS --max-time 3 "http://127.0.0.1:$GATE_PORT/gate/health" 2>/dev/null) || true
		if printf '%s' "$body" | grep -q '"launchTokenCaptured":true' \
			&& printf '%s' "$body" | grep -q '"dshCookie":{"authority"'; then
			log "$(M "gate 正常，DSH 会话兑换成功" "Gateway and DSH are up")"
			break
		fi
		if [[ $i -eq 60 ]]; then
			# 不在这里退出：令牌链接只在下面打印，退出了用户就只剩"缺少令牌"页
			healthy=0
			warn "$(M "DSH 会话兑换超时（DSH 可能仍在启动，或启动失败）" "DSH did not come up in time (still starting, or failed to start)")"
			local err
			err=$(printf '%s' "$body" | sed -n 's/.*"lastError":"\([^"]*\)".*/\1/p')
			[[ -n "$err" ]] && warn "$(M "最近错误: $err" "Last error: $err")"
			warn "$(M "排查: journalctl -u vpssh -n 80 --no-pager" "To investigate: journalctl -u vpssh -n 80 --no-pager")"
			break
		fi
		sleep 2
	done

	local url="https://$TRUSTED_HOST"
	local open_url="$url"
	[[ -n "$SETUP_TOKEN" ]] && open_url="$url/setup?token=$SETUP_TOKEN"

	echo
	echo "============================================================"
	if [[ $healthy -eq 1 ]]; then
		echo " $(M "vpssh 安装完成" "vpssh is installed")"
	else
		echo " $(M "vpssh 已安装，但还没就绪（见上方警告；页面会显示启动进度与错误）" "vpssh is installed but not ready yet (see the warnings above; the page shows progress and errors)")"
	fi
	echo "------------------------------------------------------------"
	echo " $(M "打开      " "Open      "): $open_url"
	if [[ -n "$SETUP_TOKEN" ]]; then
		echo "             $(M "（初始设置要用上面这个带一次性令牌的地址）" "(first-time setup needs this address with its one-time token)")"
	elif [[ -z "$DOMAIN" ]]; then
		echo "             $(M "（没有域名，用的是自签证书，浏览器会提示不安全；域名可以稍后在向导里填）" "(no domain: self-signed certificate, so the browser warns; you can add a domain in the setup wizard)")"
	fi
	echo " $(M "版本      " "Version   "): vpssh ${VPSSH_VERSION:-?} · DeepSeek Harness ${DSH_VERSION}"
	echo " $(M "管理命令  " "Commands  "): vpssh status | repair | upgrade | rollback | uninstall | reset-admin | setup-url | backup"
	echo " $(M "网页打不开" "Page down "): sudo vpssh repair"
	echo "------------------------------------------------------------"
	echo " $(M "下一步：" "Next:")"
	echo " $(M "1. 用域名的话，先把 A 记录解析到这台机器（Caddy 会自动签发证书）" "1. With a domain, point its A record at this machine first (Caddy gets the certificate)")"
	echo " $(M "2. 浏览器打开上面的地址，进入初始设置" "2. Open the address above in a browser for first-time setup")"
	echo " $(M "3. 设置管理员账号（可选：域名、模型 API Key）→ 登录" "3. Create the admin account (optional: domain, model API key), then sign in")"
	if [[ -n "$SETUP_TOKEN" ]]; then
		echo
		echo " $(M "链接丢了随时重取：sudo vpssh setup-url" "Lost the link? sudo vpssh setup-url")"
	fi
	echo "============================================================"
	# 没就绪时返回非零：vpssh upgrade 据此自动回到升级前
	[[ $healthy -eq 1 ]] || exit 3
}

## endregion

fetch_repo
read_manifest
step1_prechecks
step2_node
step3_dsh
step4_user
step5_keys
step5_plugin
step6_gate
resolve_trusted_host
step7_caddy
step8_systemd
step9_firewall
step10_verify
