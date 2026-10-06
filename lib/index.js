// lib/index.js — vpssh 插件的宿主侧入口
//
// vpssh 插件只管「这是 vpssh」：品牌和默认布局，都在界面侧（lib/client.js）。
// 管机器的能力全在 dsh-vps-manager，登录网关、安装、升级全在 dsh-vps，这里不重复。
// 宿主侧暂时没有要做的事；留着入口，以后放「VPS 管理」页的汇总接口。

export const name = 'vpssh'

export function apply() {}

export default { name, apply }
