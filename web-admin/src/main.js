import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Element Plus 按需引入：组件/指令/API 由 vite 的 unplugin 解析器自动注册并注入样式，
// 这里仅保留两件事——暗色变量表与基础图标字体（无 JS 注册，避免全量打包 1MB+）。
import 'element-plus/theme-chalk/dark/css-vars.css'
// ElFormItem 的样式必须显式引入：vite 的按需解析器把 ElFormItem 归到 form 目录，
// 而 form/style/css 只 import el-form.css（仅 inline 表单规则），**el-form-item.css 整份没进包**。
// 后果不是少个星号那么轻：.el-form-item 的 margin-bottom、__error 定位与配色、
// 标签布局规则一起丢失 —— 全站表单没有行间距（设置页的提示文字与下一行标签粘在一起，
// 看起来像同一段），校验错误也没有正常定位。此处补齐整份样式。
import 'element-plus/es/components/form-item/style/css'

// 全局样式（含 .el-* 覆写，依赖组件样式已按页面注入，靠 CSS 变量生效与加载顺序无关）
import '@/styles/index.scss'

import App from './App.vue'
import router from './router'
import { useSettingsStore } from './store/settings'
import { initTheme } from './utils/theme'

// 主题引擎：跟随系统 / 强制浅色 / 强制深色（持久化 edu_theme，旧脏值自动归一）
initTheme()

const app = createApp(App)

// 注册路由
app.use(router)
// 注册 Pinia
app.use(createPinia())

// 统一称呼：全局 $t(key) / $roleLabel(role)，页面文案跟随机构方案
const settingsStore = useSettingsStore()
settingsStore.loadSettings()
app.config.globalProperties.$t = (key) => settingsStore.t(key)
app.config.globalProperties.$roleLabel = (role) => settingsStore.roleLabel(role)

app.mount('#app')
