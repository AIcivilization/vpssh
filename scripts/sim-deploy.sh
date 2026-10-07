#!/usr/bin/env bash
# 把当前工作区的 vpssh 装到本机 OrbStack 上的模拟测试机，并让浏览器能从 http://localhost:<网关端口> 打开（新装 3190，早期装的 3100）。
#
# 只用于开发：测试机里把 DSH 信任的访问地址改成 localhost:<网关端口>（绕过 Caddy 的自签证书），
# 真实安装不会这么做。前提：OrbStack 里有一台叫 vpssh-test 的 Ubuntu 机器（orb create ubuntu:noble vpssh-test）。
set -euo pipefail
ORB="${ORB:-$HOME/.orbstack/bin/orb}"
MACHINE="${VPSSH_SIM_MACHINE:-vpssh-test}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ORB" -m "$MACHINE" -u root bash -c "bash '$REPO/server/install.sh' --ip 127.0.0.1" 2>&1 \
	| grep -E '步骤|安装完成|失败|ERROR|\[install\].*(warn|失败)' || true
"$ORB" -m "$MACHINE" -u root bash -c '
	P=$(sed -n "s/.*\"gatePort\": *\([0-9]*\).*/\1/p" /opt/vpssh/state/config.json); P=${P:-3190}
	sed -i "s/^DSH_TRUSTED_HOST=.*/DSH_TRUSTED_HOST=localhost:$P/" /opt/vpssh/state/gate.env
	systemctl restart vpssh
	for i in $(seq 1 60); do
		curl -s http://127.0.0.1:$P/gate/health | grep -q "\"dshCookie\":{\"authority\"" && { echo "就绪：http://localhost:$P/"; exit 0; }
		sleep 2
	done
	echo "DSH 没有就绪：journalctl -u vpssh -n 50" >&2; exit 1'
