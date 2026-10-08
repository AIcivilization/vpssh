#!/usr/bin/env bash
# vpssh 卸载脚本
#
# 用法：
#   curl -fsSL https://raw.githubusercontent.com/AIcivilization/vpssh/main/server/uninstall.sh \
#     | sudo bash -s -- --yes
#   # 或在仓库克隆目录内：
#   sudo bash uninstall.sh [--yes] [--delete-data] [--purge-caddy]
#
# 目标 OS：Ubuntu 22.04+ / Debian 12+
#
# 顺序：备份 → 停服务 → 移除 unit 与安装目录 → 移除 Caddy 站点块 → 本机账号 → 数据（默认保留）。
# 任何一步失败都会就地停下（set -euo pipefail），不做半吊子清理。

set -Eeuo pipefail

## region: 常量与参数

INSTALL_ROOT="/opt/vpssh"
DSH_USER="vpssh"
DSH_HOME_DIR="/home/vpssh/.dsh"
SERVICE="vpssh"
UNIT_FILE="/etc/systemd/system/vpssh.service"
CADDY_SITE_FILE="/etc/caddy/vpssh-site.conf"
CADDYFILE="/etc/caddy/Caddyfile"
KEYS_USER="vpssh-keys"
KEY_DIR="/var/lib/vpssh-keys"
LOCAL_ADMIN="vpssh-admin"

ASSUME_YES=0
KEEP_DATA=1 # 默认保留数据（机器清单、对话、钥匙）；--delete-data 才删
PURGE_CADDY=0

log()  { printf '\033[1;32m[uninstall]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[uninstall]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[uninstall]\033[0m %s\n' "$*" >&2; exit 1; }
# 输出跟系统语言：zh 开头用中文，否则英文。写法：M '中文' 'English'
M() { case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in zh*) printf '%s' "$1" ;; *) printf '%s' "$2" ;; esac; }

usage() {
	if [[ "$(M zh en)" != zh ]]; then
		cat <<'EOF'
vpssh uninstaller
Usage: sudo bash uninstall.sh [--yes] [--delete-data] [--purge-caddy]
  --yes          Do not ask for confirmation
  --delete-data  Also delete the data: conversations and machine list (/home/vpssh), keys (/var/lib/vpssh-keys), system users. Kept by default
  --purge-caddy  Also remove the Caddy package and its apt source (by default only vpssh's site is removed)
EOF
		return
	fi
	cat <<'EOF'
vpssh 卸载脚本
用法: sudo bash uninstall.sh [--yes] [--delete-data] [--purge-caddy]
  --yes          跳过交互确认（脚本化调用时用）
  --delete-data  连数据一起删：对话与机器清单（/home/vpssh）、钥匙（/var/lib/vpssh-keys）、系统用户。默认保留
  --purge-caddy  连 Caddy 软件包与 apt 源一起移除（默认只删本产品的站点块）
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
	--yes) ASSUME_YES=1; shift ;;
	--delete-data) KEEP_DATA=0; shift ;;
	--keep-data) KEEP_DATA=1; shift ;;
	--purge-caddy) PURGE_CADDY=1; shift ;;
	-h | --help) usage; exit 0 ;;
	*) die "$(M "未知参数: $1（--help 查看用法）" "Unknown option: $1 (see --help)")" ;;
	esac
done

[[ $EUID -eq 0 ]] || die "$(M "需要 root（sudo bash uninstall.sh ...）" "Run as root (sudo bash uninstall.sh ...)")"

## endregion

## region: 步骤 1：确认

if [[ $ASSUME_YES -eq 0 ]]; then
	if [[ "$(M zh en)" == zh ]]; then
		cat <<EOF
即将移除 vpssh：
  - 服务        ${SERVICE}、vpssh-keyd（停止并删除）
  - 程序        ${INSTALL_ROOT}、/usr/local/bin/vpssh
  - Caddy 站点  $CADDY_SITE_FILE$([ $PURGE_CADDY -eq 1 ] && echo "（并移除 caddy 软件包）")
  - 隧道        /etc/wireguard/wg0.conf（仅当它是 vpssh 创建的；你自己的 wg0 不动）
  - 本机登录    root 的 authorized_keys 里 vpssh 加的那一行；专用账号 $LOCAL_ADMIN（如有，连同它的免密 sudo）
  - 数据        /home/vpssh、$KEY_DIR、系统用户 $DSH_USER / $KEYS_USER$([ $KEEP_DATA -eq 1 ] && echo "（保留；要删加 --delete-data）" || echo "（删除）")

删除前会先打包备份到 /root/vpssh-uninstall-<时间>.tar.gz
EOF
	else
		cat <<EOF
About to remove vpssh:
  - Services       ${SERVICE}, vpssh-keyd (stopped and removed)
  - Program        ${INSTALL_ROOT}, /usr/local/bin/vpssh
  - Caddy site     $CADDY_SITE_FILE$([ $PURGE_CADDY -eq 1 ] && echo " (and the caddy package)")
  - Tunnel         /etc/wireguard/wg0.conf (only if vpssh created it; your own wg0 is left alone)
  - Local login    vpssh's line in root's authorized_keys; the account $LOCAL_ADMIN if present (with its sudo rule)
  - Data           /home/vpssh, $KEY_DIR, users $DSH_USER / $KEYS_USER$([ $KEEP_DATA -eq 1 ] && echo " (kept; add --delete-data to remove)" || echo " (deleted)")

A backup goes to /root/vpssh-uninstall-<time>.tar.gz first.
EOF
	fi
	read -rp "$(M "确认卸载？输入 yes 继续： " "Type yes to uninstall: ")" ans
	[[ "$ans" == "yes" ]] || die "$(M "已取消" "Cancelled")"
fi

## endregion

## region: 步骤 2：备份

log "$(M "步骤 1/6：备份" "Step 1/6: backup")"
mkdir -p /root
local_ts="vpssh-uninstall-$(date +%Y%m%d-%H%M%S).tar.gz"
BACKUP="/root/$local_ts"
targets=()
# 注意：set -e 下不能写 `[[ -d x ]] && arr+=(x)`——条件为假时整条列表返回非 0 会直接退出
if [[ -d "$INSTALL_ROOT/state" ]]; then targets+=("${INSTALL_ROOT#/}/state"); fi
if [[ -d "$INSTALL_ROOT/backups" ]]; then targets+=("${INSTALL_ROOT#/}/backups"); fi
if [[ -d /home/vpssh ]]; then targets+=("home/vpssh"); fi
# 钥匙也进备份（备份文件只有 root 能读）：恢复后不用把钥匙重新放到每台机器上
if [[ -d "$KEY_DIR" ]]; then targets+=("${KEY_DIR#/}"); fi
# Caddyfile 下一步会被改写，先连同站点块一起进备份
if [[ -f "$CADDYFILE" ]]; then targets+=("${CADDYFILE#/}"); fi
if [[ -f "$CADDY_SITE_FILE" ]]; then targets+=("${CADDY_SITE_FILE#/}"); fi
if [[ ${#targets[@]} -gt 0 ]]; then
	tar -czf "$BACKUP" -C / "${targets[@]}" 2>/dev/null || warn "$(M "部分文件无法打包（继续卸载）" "Some files could not be packed (continuing)")"
	chmod 600 "$BACKUP"
	log "$(M "备份完成: $BACKUP" "Backup written: $BACKUP")"
else
	BACKUP=""
	log "$(M "没有可备份的内容" "Nothing to back up")"
fi

## endregion

## region: 步骤 3：停服务、移除 unit

log "$(M "步骤 2/6：停止并移除 $SERVICE" "Step 2/6: stop and remove $SERVICE")"
systemctl stop "$SERVICE" 2>/dev/null || true
systemctl disable "$SERVICE" 2>/dev/null || true
rm -f "$UNIT_FILE"
systemctl disable --now vpssh-keyd 2>/dev/null || true
rm -f /etc/systemd/system/vpssh-keyd.service
# 浏览器一键升级单元
systemctl disable --now vpssh-upgrade.path vpssh-uninstall.path 2>/dev/null || true
rm -f /etc/systemd/system/vpssh-upgrade.path /etc/systemd/system/vpssh-upgrade.service \
	/etc/systemd/system/vpssh-uninstall.path /etc/systemd/system/vpssh-uninstall.service
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed "$SERVICE" 2>/dev/null || true

# gate 拉起的 DSH 子进程随 gate 停止而退出；残留则兜底清理
pkill -u "$DSH_USER" -f "dsh/lib/bin.js" 2>/dev/null || true
pkill -u "$DSH_USER" -f "gate/server.js" 2>/dev/null || true

## endregion

## region: 步骤 4：删文件

log "$(M "步骤 3/6：移除安装目录与命令" "Step 3/6: remove the program and command")"
rm -rf "$INSTALL_ROOT"
rm -f /usr/local/bin/vpssh

## endregion

## region: 步骤 5：Caddy

log "$(M "步骤 4/6：移除 Caddy 站点块" "Step 4/6: remove the Caddy site")"
if [[ -f "$CADDY_SITE_FILE" ]]; then
	rm -f "$CADDY_SITE_FILE"
fi
if [[ -f "$CADDYFILE" ]] && grep -qF "import $CADDY_SITE_FILE" "$CADDYFILE" && ! grep -q "vpssh 主 Caddyfile" "$CADDYFILE"; then
	# 和别的网站共用 Caddy（主 Caddyfile 是别人的）：只去掉 vpssh 加的那一行和它的说明，别的一字不动
	sed -i "\|^# vpssh：只加了下面这一行|d; \|^import $CADDY_SITE_FILE\$|d" "$CADDYFILE"
	log "$(M "Caddy 和别的网站共用：只去掉了 vpssh 加的那一行 import" "Caddy is shared with another site: removed only vpssh's import line")"
elif [[ -f "$CADDYFILE" ]] && grep -qF "import $CADDY_SITE_FILE" "$CADDYFILE"; then
	# install.sh 覆盖前留下的原文件（Caddyfile.bak.<时间戳>）：取最新一份不含本产品 import 的还原；
	# 没有则换成占位文件，避免 Caddy 因 import 缺失而启动失败。
	orig=""
	for f in $(ls -1t "$CADDYFILE".bak.* 2>/dev/null); do
		if ! grep -qF "import $CADDY_SITE_FILE" "$f"; then orig="$f"; break; fi
	done
	if [[ -n "$orig" ]]; then
		cp "$orig" "$CADDYFILE" && log "$(M "已还原安装前的 Caddyfile（来自 $orig）" "Restored the Caddyfile from before the install ($orig)")" \
			|| warn "$(M "Caddyfile 还原失败，请手工检查 $CADDYFILE" "Could not restore the Caddyfile; check $CADDYFILE by hand")"
	else
		printf '# Caddyfile 已被 vpssh 卸载脚本重置（原内容已备份进 %s）\n' "${BACKUP:-（无备份）}" >"$CADDYFILE" \
			|| warn "$(M "Caddyfile 重置失败，请手工检查 $CADDYFILE" "Could not reset the Caddyfile; check $CADDYFILE by hand")"
	fi
fi
if command -v caddy >/dev/null 2>&1; then
	systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
fi
if [[ $PURGE_CADDY -eq 1 ]]; then
	systemctl stop caddy 2>/dev/null || true
	systemctl disable caddy 2>/dev/null || true
	apt-get purge -y caddy >/dev/null 2>&1 || warn "$(M "caddy 卸载失败（可能不是 apt 安装的）" "Could not remove caddy (maybe not installed with apt)")"
	rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	log "$(M "已移除 caddy" "Removed caddy")"
fi

## endregion

## region: 步骤 5：隧道

log "$(M "步骤 5/6：移除隧道" "Step 5/6: remove the tunnel")"
# 只认 vpssh 自己写的那行开头（同机 dsh-vps 的 wg0 开头是「# dsh-vps 隧道接口」，不能碰）
if [[ -f /etc/wireguard/wg0.conf ]] && ! grep -q "^# vpssh 隧道接口" /etc/wireguard/wg0.conf; then
	log "$(M "wg0.conf 不是 vpssh 创建的，保留不动" "wg0.conf was not created by vpssh; left alone")"
elif [[ -f /etc/wireguard/wg0.conf ]]; then
	systemctl stop wg-quick@wg0 2>/dev/null || true
	systemctl disable wg-quick@wg0 2>/dev/null || true
	rm -f /etc/wireguard/wg0.conf
	log "$(M "已移除 wg0（设备里的客户端配置请自行删掉）" "Removed wg0 (delete the client configs on your devices yourself)")"
else
	log "$(M "没有隧道，跳过" "No tunnel")"
fi

## endregion

## region: 步骤 6：本机账号与数据

log "$(M "步骤 6/6：本机账号与数据" "Step 6/6: local account and data")"
# vpssh 用 root 登录这台机器时在 /root/.ssh/authorized_keys 里加过一行：按 vpssh 的公钥认出那一行删掉，其余不动
if [[ -s "$KEY_DIR/vpssh_ed25519.pub" && -f /root/.ssh/authorized_keys ]]; then
	key_body=$(awk '{print $2}' "$KEY_DIR/vpssh_ed25519.pub")
	if [[ -n "$key_body" ]] && grep -qF "$key_body" /root/.ssh/authorized_keys; then
		cp -p /root/.ssh/authorized_keys "/root/.ssh/authorized_keys.bak-vpssh-$(date +%s)"
		grep -vF "$key_body" /root/.ssh/authorized_keys >/root/.ssh/authorized_keys.vpssh-tmp || true
		cat /root/.ssh/authorized_keys.vpssh-tmp >/root/.ssh/authorized_keys # 原文件就地改写，保留属主和权限
		rm -f /root/.ssh/authorized_keys.vpssh-tmp
		log "$(M "已从 root 的 authorized_keys 去掉 vpssh 的那一行" "Removed vpssh's line from root's authorized_keys")"
	fi
fi
if id "$LOCAL_ADMIN" >/dev/null 2>&1; then
	# vpssh 刚经 SSH 登录过它：登录会话（含 systemd --user）还在时 userdel 会拒绝，先结束再删
	loginctl terminate-user "$LOCAL_ADMIN" 2>/dev/null || true
	pkill -KILL -u "$LOCAL_ADMIN" 2>/dev/null || true
	sleep 1
	if userdel -f -r "$LOCAL_ADMIN" 2>/dev/null || ! id "$LOCAL_ADMIN" >/dev/null 2>&1; then
		log "$(M "已删除本机账号 $LOCAL_ADMIN" "Removed the local account $LOCAL_ADMIN")"
	else
		warn "$(M "删除账号 $LOCAL_ADMIN 失败，请手工处理：sudo userdel -f -r $LOCAL_ADMIN" "Could not remove $LOCAL_ADMIN; run: sudo userdel -f -r $LOCAL_ADMIN")"
	fi
fi
rm -f /etc/sudoers.d/vpssh-admin
if [[ $KEEP_DATA -eq 1 ]]; then
	log "$(M "保留数据：/home/vpssh、$KEY_DIR（要删：sudo bash uninstall.sh --delete-data）" "Kept the data: /home/vpssh, $KEY_DIR (to remove: sudo bash uninstall.sh --delete-data)")"
else
	rm -rf /home/vpssh "$KEY_DIR"
	userdel "$DSH_USER" 2>/dev/null || true
	userdel "$KEYS_USER" 2>/dev/null || true
	log "$(M "已删除数据与系统用户 $DSH_USER、$KEYS_USER" "Removed the data and the users $DSH_USER, $KEYS_USER")"
fi

## endregion

if [[ "$(M zh en)" == zh ]]; then
	cat <<EOF

卸载完成。
  备份：${BACKUP:-（无）}

被管的机器上还留着 vpssh 的公钥（authorized_keys 里结尾是 vpssh@... 的那一行）。
不打算再用 vpssh 了，就到各台机器上删掉那一行。

从备份恢复（先放回数据、再安装：安装会沿用原来的账号和钥匙）：
  1. sudo tar -xzf ${BACKUP:-<备份文件>} -C /
  2. curl -fsSL https://github.com/AIcivilization/vpssh/releases/latest/download/install.sh | sudo bash
EOF
else
	cat <<EOF

vpssh is uninstalled.
  Backup: ${BACKUP:-(none)}

Managed machines still have vpssh's public key (the authorized_keys line ending in vpssh@...).
If you are done with vpssh, delete that line on each machine.

To restore from the backup (data first, then install, so the account and key carry over):
  1. sudo tar -xzf ${BACKUP:-<backup file>} -C /
  2. curl -fsSL https://github.com/AIcivilization/vpssh/releases/latest/download/install.sh | sudo bash
EOF
fi
