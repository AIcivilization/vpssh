/* global window, document, navigator, setTimeout */
// lib/client.js — vpssh 的品牌与默认布局（设计第四节）
//
// 手写单文件 bundle，没有构建链：供 DSH web 客户端的 ModuleLoader 注入（写法同 dsh-vps-manager）。
// 只做两件事，都不改 DSH 本身的样子：
//   sidebar.brand.mark / sidebar.brand.name  侧栏顶部换成 vpssh（DSH 品牌规范要求别的产品不冒充官方）
//   默认布局                                 页面加载后打开右侧栏的「VPS 状态」；DSH 打开右栏时会自动收起左栏
//
// 硬约束：品牌插件出错不能影响任何功能，所以注册一律包在 try/catch 里。

window.__ModuleLoader__.load({
  id: 'vpssh',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    // 界面语言：跟着 DSH（DSH 切语言时会改网页的 lang）。写法：L('中文', 'English')
    function lang() {
      const page = typeof document === 'undefined' ? '' : document.documentElement?.lang || navigator?.language || ''
      return /^zh/i.test(page) ? 'zh' : 'en'
    }
    const L = (zh, en) => (lang() === 'zh' ? zh : en)

    // dsh-vps-manager 右侧栏「VPS 状态」页签的类型（lib/client.js 里的 SIDEBAR_KIND）
    const STATUS_TAB_KIND = 'vps-manager-status'

    function BrandMark({ size = 24 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('rect', { x: 1, y: 1, width: 22, height: 22, rx: 6, fill: 'currentColor', opacity: 0.12 }),
        h('path', { d: 'M6.5 8.5 10 12l-3.5 3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M12 16h5.5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }))
    }

    function BrandName() {
      return h('span', { title: L('全平台 AI 驱动的 VPS 管理及 SSH 工具', 'AI-driven VPS management and SSH tool for every platform') }, 'vpssh')
    }

    const name = 'vpssh-client'
    const inject = ['slots']

    function apply(ctx) {
      try {
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, BrandMark))
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName))
      } catch (error) {
        console.warn('[vpssh] 品牌注册失败，沿用 DSH 默认', error)
      }
      try {
        // DSH 刷新后会重置布局：每次加载打开一次「VPS 状态」。只开一次，之后用户怎么摆都不管
        ctx.inject?.(['sidebarRight'], (scope) => {
          const right = scope.get?.('sidebarRight') ?? scope.sidebarRight
          if (typeof right?.openTab !== 'function') return
          if (typeof window !== 'undefined' && window.__vpsshLayoutDone) return
          setTimeout(() => {
            try {
              right.openTab(STATUS_TAB_KIND)
              window.__vpsshLayoutDone = true
            } catch (error) {
              console.warn('[vpssh] 打开 VPS 状态失败', error)
            }
          }, 0)
        })
      } catch (error) {
        console.warn('[vpssh] 默认布局失败', error)
      }
    }

    module.exports = { name, inject, apply, __test: { L, lang, BrandMark, BrandName } }
    return module.exports
  },
})
