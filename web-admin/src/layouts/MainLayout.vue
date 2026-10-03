<template>
  <div class="main-layout">
    <!-- 左侧导航 -->
        <!-- 顶部状态栏（全宽） -->
    <header class="header">
        <!-- 品牌区（固定标题，不随页面变化） -->
        <div class="header-brand">
          <div class="logo-icon">
            <el-icon :size="16"><School /></el-icon>
          </div>
          <span class="logo-text">{{ orgName }}</span>
        </div>

        <div class="header-right">
          <!-- 快速切换（Cmd/Ctrl + K） -->
          <el-button text class="quick-switch-btn" @click="quickOpen = true">
            <el-icon :size="16"><Search /></el-icon>
            <span class="quick-switch-text">快速切换</span>
            <kbd class="quick-kbd">⌘K</kbd>
          </el-button>

          <!-- 主题切换 -->
          <el-tooltip :content="themeTip" placement="bottom">
            <el-button text class="header-icon theme-toggle-btn" :aria-label="themeTip" @click="cycleThemeMode">
              <el-icon :size="18"><component :is="themeIcon" /></el-icon>
            </el-button>
          </el-tooltip>

          <!-- 通知 -->
          <el-badge :value="unreadCount" :hidden="unreadCount === 0" class="header-icon">
            <!-- aria-label 供屏幕阅读器识别；@click 从 el-icon 上移到 el-button
                 （原先点击区只有 20px 图标大小，不符合 44px 触控目标） -->
            <el-button text aria-label="通知" @click="openNotices">
              <el-icon :size="20"><Bell /></el-icon>
            </el-button>
          </el-badge>

          <!-- 用户下拉 -->
          <el-dropdown trigger="click" @command="handleCommand">
            <div class="user-trigger">
              <EntityAvatar :name="userStore.userName" size="sm" tone="accent" />
              <span class="user-name">{{ userStore.userName }}</span>
              <el-icon :size="12"><CaretBottom /></el-icon>
            </div>
            <template #dropdown>
              <el-dropdown-menu>
                <!-- 个人设置对全部员工角色开放：教练/销售需要自助修改初始密码。
                     MainLayout 本身仅 admin/coach/sales 可达，故此处无需再按角色收窄。 -->
                <el-dropdown-item command="profile">
                  <el-icon><User /></el-icon>个人设置
                </el-dropdown-item>
                <el-dropdown-item v-if="userStore.userRole === 'admin'" command="settings">
                  <el-icon><Setting /></el-icon>系统设置
                </el-dropdown-item>
                <el-dropdown-item divided command="logout">
                  <el-icon><SwitchButton /></el-icon>退出登录
                </el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

<aside class="sidebar" :class="{ collapsed: menuCollapsed }">
      <!-- 主导航。
           键盘可达性（WCAG 2.1.1）：Element Plus 2.14 的垂直 el-menu 把每个
           menu-item 的 tabindex 硬编码为 -1，且组件内部没有任何 keydown 处理，
           所以 7 个一级入口在键盘下完全进不去。这里：
             1) 用 <nav aria-label> 提供导航地标语义；
             2) 给 el-menu 传 tabindex="0"，让 <ul role="menubar"> 可被 Tab 聚焦；
             3) 在 nav 上补一套 roving tabindex（方向键移动焦点、Enter/Space 触发跳转），
                因为 EP 自身不提供这套行为，只让容器可聚焦仍然无法激活菜单项。 -->
      <nav class="sidebar-nav" aria-label="主导航" @keydown="onNavKeydown">
        <el-menu
          ref="menuRef"
          :default-active="activeMenu"
          :collapse="menuCollapsed"
          :collapse-transition="false"
          class="sidebar-menu"
          tabindex="0"
          router
        >
          <el-menu-item
            v-for="route in menuRoutes"
            :key="route.path"
            :index="'/' + route.path"
            :aria-current="activeMenu === '/' + route.path ? 'page' : undefined"
          >
            <el-icon v-if="iconMap[route.meta.icon]">
              <component :is="iconMap[route.meta.icon]" />
            </el-icon>
            <template #title>{{ resolveTitle(route.meta.title) }}</template>
          </el-menu-item>
        </el-menu>
      </nav>

      <!-- 底部折叠按钮：窄屏下侧栏被断点强制折叠，按钮失去意义，直接隐藏 -->
      <div v-if="!isNarrow" class="sidebar-footer">
        <el-button
          text
          :aria-label="isCollapsed ? '展开侧栏' : '折叠侧栏'"
          :title="isCollapsed ? '展开侧栏' : '折叠侧栏'"
          @click="toggleCollapse"
          class="collapse-btn"
        >
          <el-icon :size="18">
            <Fold v-if="!isCollapsed" />
            <Expand v-else />
          </el-icon>
        </el-button>
      </div>
    </aside>

    <!-- 右侧主区域 -->
    <div class="main-content">
      <!-- 顶部 Header -->
      

      <!-- 内容区 -->
      <main class="content">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <!-- 通知抽屉 -->
    <el-drawer v-model="noticeDrawer" size="420px" class="notice-drawer">
      <template #header>
        <div class="notice-drawer-header">
          <span class="notice-drawer-title">消息通知</span>
          <el-button v-if="notices.length" text type="primary" size="small" @click="markAllRead">
            全部已读
          </el-button>
        </div>
      </template>
      <div v-loading="noticeLoading" class="notice-body">
        <div v-if="!noticeLoading && notices.length === 0" class="notice-empty">
          <el-icon :size="40" color="var(--t-text-faint)"><Bell /></el-icon>
          <p>暂无通知</p>
        </div>
        <div role="button" tabindex="0"
          v-for="n in notices"
          :key="n.id"
          class="notice-item"
          :class="{ unread: !n.isRead }"
          @click="readNotice(n)" @keydown.enter="readNotice(n)" @keydown.space.prevent="readNotice(n)"
        >
          <span class="notice-item-dot" :class="'p-' + (n.priority || 'normal')"></span>
          <div class="notice-item-main">
            <div class="notice-item-title">{{ n.title }}</div>
            <div class="notice-item-summary">{{ n.summary }}</div>
            <div class="notice-item-time">{{ formatNoticeTime(n.createdAt) }}</div>
          </div>
          <span v-if="!n.isRead" class="notice-item-unread"></span>
        </div>
      </div>
      <template #footer>
        <div class="notice-footer">
          <el-button type="primary" plain @click="goNotifications">通知中心</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 快速切换器（借鉴 trycompai/crm 的 QuickSwitcher） -->
    <el-dialog v-model="quickOpen" class="quick-switcher-dialog dlg-md" :show-close="false" append-to-body>
      <div class="quick-body">
        <el-input
          ref="quickInputRef"
          v-model="quickQuery"
          placeholder="搜索页面、成员、线索…"
          :prefix-icon="Search"
          clearable
          size="large"
          @keyup.enter="quickGoFirst"
        />
        <div class="quick-results">
          <template v-if="!quickQuery">
            <div class="quick-group">
              <div class="quick-group-title">页面导航</div>
              <div role="button" tabindex="0"
                v-for="r in quickMenus"
                :key="r.path"
                class="quick-item"
                @click="quickGo('/' + r.path)" @keydown.enter="quickGo('/' + r.path)" @keydown.space.prevent="quickGo('/' + r.path)"
              >
                <span class="quick-item-title">{{ resolveTitle(r.meta.title) }}</span>
                <span class="quick-item-hint">/{{ r.path }}</span>
              </div>
            </div>
          </template>
          <template v-else>
            <div v-if="quickMenusFiltered.length" class="quick-group">
              <div class="quick-group-title">页面</div>
              <div role="button" tabindex="0"
                v-for="r in quickMenusFiltered"
                :key="r.path"
                class="quick-item"
                @click="quickGo('/' + r.path)" @keydown.enter="quickGo('/' + r.path)" @keydown.space.prevent="quickGo('/' + r.path)"
              >
                <span class="quick-item-title">{{ resolveTitle(r.meta.title) }}</span>
                <span class="quick-item-hint">页面</span>
              </div>
            </div>
            <div v-if="quickStudents.length" class="quick-group">
              <div class="quick-group-title">成员</div>
              <div role="button" tabindex="0"
                v-for="s in quickStudents"
                :key="s.id"
                class="quick-item"
                @click="quickGo('/students?keyword=' + encodeURIComponent(s.name))" @keydown.enter="quickGo('/students?keyword=' + encodeURIComponent(s.name))" @keydown.space.prevent="quickGo('/students?keyword=' + encodeURIComponent(s.name))"
              >
                <span class="quick-item-title">{{ s.name }}</span>
                <span class="quick-item-hint">{{ s.parent_phone || '成员' }}</span>
              </div>
            </div>
            <div v-if="quickLeads.length" class="quick-group">
              <div class="quick-group-title">线索</div>
              <div role="button" tabindex="0"
                v-for="l in quickLeads"
                :key="l.id"
                class="quick-item"
                @click="quickGo('/growth')" @keydown.enter="quickGo('/growth')" @keydown.space.prevent="quickGo('/growth')"
              >
                <span class="quick-item-title">{{ l.name }}</span>
                <span class="quick-item-hint">{{ l.phone || '线索' }}</span>
              </div>
            </div>
            <div v-if="!quickMenusFiltered.length && !quickStudents.length && !quickLeads.length" class="quick-empty">
              没有匹配的结果
            </div>
          </template>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/store/user'
import { useSettingsStore } from '@/store/settings'
import EntityAvatar from '@/components/EntityAvatar.vue'
import { themeMode, cycleThemeMode, THEME_LABELS } from '@/utils/theme'
import {
  School,
  Fold,
  Expand,
  Bell,
  UserFilled,
  User,
  Setting,
  SwitchButton,
  Search,
  Sunny,
  Moon,
  Monitor,
  DataAnalysis,
  Calendar,
  Checked,
  ChatDotRound,
  ChatDotSquare,
  ShoppingBag,
  TrendCharts,
  Star,
  Avatar,
  CaretBottom
} from '@element-plus/icons-vue'

const iconMap = {
  DataAnalysis,
  Calendar,
  Checked,
  ChatDotRound,
  ChatDotSquare,
  User,
  School,
  ShoppingBag,
  TrendCharts,
  Star,
  Avatar,
  Setting,
  Bell,
}
import {
  getMyNotices,
  getNoticeUnreadCount,
  markNoticeRead,
  markAllNoticesRead,
  getSettings,
} from '@/api/modules'
import { getStudents, getLeads } from '@/api/modules'
import { usePageAccess } from '@/utils/access'

const route = useRoute()
const router = useRouter()
const userStore = useUserStore()
const settingsStore = useSettingsStore()
const { can: canAccess } = usePageAccess()
const t = settingsStore.t

// 将菜单标题中的 {concept} 占位符解析为当前称呼方案下的词（如 {learner} → 学员/会员）
const resolveTitle = (title) => (title ? String(title).replace(/\{(\w+)\}/g, (_, k) => t(k) || k) : title)

// 主题切换：system → light → dark 循环，偏好持久化于 edu_theme（见 utils/theme.js）。
// 历史版本曾写入无 CSS 支撑的 data-theme='dark' 导致页面失效，现已由完整暗色 token 块实现。
const themeIcon = computed(() => {
  if (themeMode.value === 'system') return Monitor
  if (themeMode.value === 'light') return Sunny
  return Moon
})
const themeTip = computed(() => `主题：${THEME_LABELS[themeMode.value]}（点击切换）`)

// ============================================
// 通知面板
// ============================================
const noticeDrawer = ref(false)
const noticeLoading = ref(false)
const notices = ref([])
const unreadCount = ref(0)
const orgName = ref('管理中心')

const loadOrgName = async () => {
  try {
    const res = await getSettings()
    orgName.value = res?.org_info?.name || '管理中心'
  } catch (e) {
    orgName.value = '管理中心'
  }
}

const loadNotices = async () => {
  noticeLoading.value = true
  try {
    const res = await getMyNotices({ limit: 30 })
    notices.value = Array.isArray(res) ? res : (res?.list || [])
  } catch (e) {
    notices.value = []
  } finally {
    noticeLoading.value = false
  }
}

const loadUnread = async () => {
  try {
    const res = await getNoticeUnreadCount()
    unreadCount.value = res?.count || 0
  } catch (e) {
    unreadCount.value = 0
  }
}

const openNotices = () => {
  noticeDrawer.value = true
  loadNotices()
  loadUnread()
}

const readNotice = async (n) => {
  if (!n.isRead) {
    await markNoticeRead({ id: n.id }).catch(() => {})
    n.isRead = true
    unreadCount.value = Math.max(0, unreadCount.value - 1)
  }
}

const markAllRead = async () => {
  await markAllNoticesRead().catch(() => {})
  notices.value.forEach((n) => { n.isRead = true })
  unreadCount.value = 0
  ElMessage.success('已全部标记为已读')
}

const formatNoticeTime = (ts) => {
  if (!ts) return ''
  const d = new Date(ts)
  const now = Date.now()
  const diff = now - ts
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 24 * 3600 * 1000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const goNotifications = () => {
  noticeDrawer.value = false
  router.push('/notifications')
}

// ============================================
// 快速切换器（Cmd/Ctrl + K）
// ============================================
const quickOpen = ref(false)
const quickQuery = ref('')
const quickInputRef = ref(null)
const quickStudents = ref([])
const quickLeads = ref([])
let quickTimer = null
let quickSeq = 0

const quickMenus = computed(() => menuRoutes.value)
const quickMenusFiltered = computed(() => {
  const q = quickQuery.value.trim().toLowerCase()
  if (!q) return []
  return quickMenus.value.filter((r) => (resolveTitle(r.meta.title) || '').toLowerCase().includes(q))
})

watch(quickOpen, (open) => {
  if (open) {
    quickQuery.value = ''
    quickStudents.value = []
    quickLeads.value = []
    nextTick(() => quickInputRef.value?.focus())
  }
})

watch(quickQuery, (val) => {
  clearTimeout(quickTimer)
  const q = (val || '').trim()
  if (!q) {
    quickStudents.value = []
    quickLeads.value = []
    return
  }
  quickTimer = setTimeout(async () => {
    // 请求序号防竞态：旧请求后回时丢弃，避免覆盖新关键词的结果
    const seq = ++quickSeq
    try {
      const [s, l] = await Promise.all([
        getStudents({ keyword: q, page: 1, pageSize: 6 }),
        getLeads({ keyword: q, page: 1, pageSize: 5 }),
      ])
      if (seq !== quickSeq) return
      quickStudents.value = s?.list || []
      quickLeads.value = l?.list || []
    } catch (e) {
      if (seq !== quickSeq) return
      quickStudents.value = []
      quickLeads.value = []
    }
  }, 200)
})

const quickGo = (path) => {
  quickOpen.value = false
  router.push(path)
}

const quickGoFirst = () => {
  if (quickMenusFiltered.value.length) return quickGo('/' + quickMenusFiltered.value[0].path)
  if (quickStudents.value.length) return quickGo('/students?keyword=' + encodeURIComponent(quickStudents.value[0].name))
  if (quickLeads.value.length) return quickGo('/growth')
}

const onGlobalKeydown = (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    quickOpen.value = !quickOpen.value
  }
}

// ============================================
// 侧边栏折叠
// ============================================
const isCollapsed = ref(false)
const toggleCollapse = () => {
  isCollapsed.value = !isCollapsed.value
}

// 窄屏（≤768px）：CSS 在该断点把侧栏宽度固定为 64px，但折叠状态与断点此前互不同步——
// 手机上点「折叠」按钮毫无反应，用户永久损失约 17% 屏宽且无法改变。
// 这里把断点状态并入折叠计算：窄屏一律折叠（与 CSS 的 64px 对齐），桌面端行为不变。
const isNarrow = ref(false)
let narrowMedia = null
const syncNarrow = (e) => { isNarrow.value = e.matches }
const menuCollapsed = computed(() => isCollapsed.value || isNarrow.value)

// 侧栏键盘导航（roving tabindex）。EP 垂直菜单不提供键盘行为，需自行补：
// 方向键在菜单项之间移动焦点，Home/End 跳首尾，Enter/Space 触发当前项跳转。
const menuRef = ref(null)
const navItems = () => Array.from(menuRef.value?.$el?.querySelectorAll('.el-menu-item') || [])
const focusNavItem = (idx) => {
  const items = navItems()
  if (!items.length) return
  const i = ((idx % items.length) + items.length) % items.length
  items.forEach((el, k) => el.setAttribute('tabindex', k === i ? '0' : '-1'))
  items[i].focus()
}
const onNavKeydown = (e) => {
  const items = navItems()
  if (!items.length) return
  const cur = items.indexOf(document.activeElement)
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusNavItem(cur < 0 ? 0 : cur + 1); break
    case 'ArrowUp': e.preventDefault(); focusNavItem(cur < 0 ? items.length - 1 : cur - 1); break
    case 'Home': e.preventDefault(); focusNavItem(0); break
    case 'End': e.preventDefault(); focusNavItem(items.length - 1); break
    case 'Enter':
    case ' ':
      if (cur >= 0) { e.preventDefault(); items[cur].click() }
      break
  }
}

onMounted(() => {
  loadUnread()
  loadOrgName()
  window.addEventListener('keydown', onGlobalKeydown)
  narrowMedia = window.matchMedia('(max-width: 768px)')
  syncNarrow(narrowMedia)
  narrowMedia.addEventListener('change', syncNarrow)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown)
  clearTimeout(quickTimer) // 布局卸载后不再触发待执行的搜索请求
  narrowMedia?.removeEventListener('change', syncNarrow)
})

// 当前激活的菜单
const activeMenu = computed(() => route.path)

// 当前页面标题
const currentTitle = computed(() => resolveTitle(route.meta.title) || '')

// 菜单路由（排除重定向和登录页）：与路由守卫共用 usePageAccess 判定，
// 保证"守卫放行的页面一定有菜单入口"（此前菜单只看 meta.roles，
// 被自定义授权 sales/students 的 coach 能进页面却找不到入口）
const menuRoutes = computed(() => {
  const rootRoute = router.options.routes.find((r) => r.path === '/')
  return (rootRoute?.children || []).filter(
    (r) => r.meta && r.meta.title && canAccess(r.meta)
  ) || []
})

// 用户下拉菜单操作
const handleCommand = async (command) => {
  switch (command) {
    case 'profile':
      router.push('/profile')
      break
    case 'settings':
      router.push('/settings')
      break
    case 'logout':
      await ElMessageBox.confirm('确定要退出登录吗？', '提示', {
        confirmButtonText: '确定',
        cancelButtonText: '取消',
        type: 'warning'
      })
      userStore.logout()
      router.push('/login')
      break
  }
}
</script>

<style lang="scss" scoped>
.main-layout {
  display: flex;
  min-height: 100vh;
}

// ============================================
// 侧边栏
// ============================================
.sidebar {
  width: 160px;
  background: var(--t-bg-elev);
  border-right: 1px solid var(--t-line);
  display: flex;
  flex-direction: column;
  transition: width var(--t-dur-base) var(--t-ease-standard);
  position: fixed;
  top: 56px;
  left: 0;
  bottom: 0;
  z-index: 100;

  &.collapsed {
    width: 64px;

    

    .sidebar-menu {
      width: 100%;

      :deep(.el-menu--collapse) {
        width: 100%;
        --el-menu-collapse-width: 64px;
      }

      :deep(.el-menu-item) {
        margin: 2px 0 !important;
        padding: 0 !important;
        justify-content: center;
        width: 100%;

        .el-menu-tooltip__trigger {
          width: 100%;
          padding: 0 !important;
          justify-content: center;
        }

        .el-icon {
          margin-right: 0;
        }
      }
    }

    .sidebar-footer {
      padding: 8px 0;
    }
  }
}

// 导航地标容器：承接 .sidebar 的 flex:1，内部仍由 .sidebar-menu 滚动
.sidebar-nav {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.sidebar-menu {
  flex: 1;
  padding: 8px 0;
  background: transparent;
  border: none;
  overflow-y: auto;

  // 键盘焦点可见性：roving tabindex 把焦点落在 li 上，需明确焦点环
  &:focus-visible,
  :deep(.el-menu-item:focus-visible) {
    outline: 2px solid var(--t-accent-line);
    outline-offset: -2px;
    border-radius: 8px;
  }

  :deep(.el-menu-item) {
    color: var(--t-text-2);
    height: 40px;
    line-height: 40px;
    font-size: var(--t-fs-base);
    font-weight: 500;
    margin: 2px 8px;
    border-radius: 8px;
    transition: background-color 0.2s ease, color 0.2s ease, transform 0.2s var(--t-ease-standard);

      .el-icon {
      width: 20px;
      margin-right: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: var(--t-fs-lg);
    }

    &:hover {
      background: var(--t-surface) !important;
      color: var(--t-text-1);
    }

    &.is-active {
      background: var(--t-accent-bg) !important;
      color: var(--t-accent-strong) !important;
      font-weight: 600;
      position: relative;
    }
  }
}

.sidebar-footer {
  padding: 16px;
  border-top: 1px solid var(--t-line);

  .collapse-btn {
    width: 100%;
    height: 40px;
    color: var(--t-text-3);

    &:hover {
      color: var(--t-text-1);
      background: var(--t-surface);
    }
  }
}

// ============================================
// 主内容区
// ============================================
.main-content {
  flex: 1;
  margin-left: 160px;
  padding-top: 56px;
  display: flex;
  flex-direction: column;
  transition: margin-left var(--t-dur-base) var(--t-ease-standard);
  min-width: 0;

  .sidebar.collapsed ~ & {
    margin-left: 64px;
  }
}

// ============================================
// Header
// ============================================
.header {
  height: 56px;
  background: var(--t-bg-elev);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  border-bottom: 1px solid var(--t-line);
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 200;
}

.header-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;

  .logo-icon {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--t-accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    box-shadow: var(--t-elevation-accent);
  }
}

.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;

  .el-button {
    width: 34px;
    height: 34px;
    border-radius: 8px;
    padding: 0;
    color: var(--t-text-2);

    &:hover {
      color: var(--t-accent-text);
      background: var(--t-hover-bg);
    }
  }

  :deep(.el-badge__content) {
    border: none;
    background: var(--t-danger);
    transform: translate(55%, -30%);
    min-width: 14px;
    height: 14px;
    padding: 0 3px;
    font-size: var(--t-fs-2xs);
    line-height: 14px;
  }
}

// 快速切换按钮
.quick-switch-btn {
  color: var(--t-text-2);
  height: 34px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  border: 1px solid var(--t-line);
  background: var(--t-surface);

  &:hover {
    color: var(--t-accent-text);
    border-color: var(--t-line-strong);
    background: var(--t-surface-hover);
  }
}

.quick-switch-text {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
}

.quick-kbd {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-2);
  border: 1px solid var(--t-line);
  border-radius: 4px;
  padding: 0 4px;
  font-family: inherit;
}

// 快速切换面板
.quick-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.quick-results {
  max-height: 380px;
  overflow-y: auto;
}

.quick-group {
  margin-bottom: 8px;
}

.quick-group-title {
  font-size: var(--t-fs-2xs);
  font-weight: 600;
  color: var(--t-text-faint);
  text-transform: uppercase;
  letter-spacing: 0.6px;
  padding: 4px 8px;
}

.quick-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.15s ease;

  &:hover {
    background: var(--t-surface-hover);
  }
}

.quick-item-title {
  font-size: var(--t-fs-base);
  font-weight: 500;
  color: var(--t-text-1);
}

.quick-item-hint {
  font-size: var(--t-fs-xs);
  color: var(--t-text-faint);
  font-variant-numeric: tabular-nums;
}

.quick-empty {
  text-align: center;
  color: var(--t-text-faint);
  font-size: var(--t-fs-sm);
  padding: 28px 0;
}

.user-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-radius: var(--t-radius-lg);
  cursor: pointer;
  transition: background 0.2s;

  &:hover {
    background: var(--t-surface);
  }

  .user-name {
    font-size: var(--t-fs-base);
    font-weight: 500;
    color: var(--t-text-1);
  }
}

// ============================================
// 内容区
// ============================================
.content {
  flex: 1;
  padding: 24px 32px;
  background: transparent;
  min-height: calc(100vh - 56px);
  min-width: 0;
}

// ============================================
// 通知抽屉
// ============================================
.notice-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}

.notice-drawer-title {
  font-size: var(--t-fs-xl);
  font-weight: 700;
  color: var(--t-text-1);
}

.notice-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 200px;
}

.notice-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 0;
  color: var(--t-text-3);
  font-size: var(--t-fs-base);
}

.notice-item {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 8px;
  background: var(--t-surface);
  border: 1px solid var(--t-line);
  cursor: pointer;
  position: relative;
  transition: background-color 0.2s ease, border-color 0.2s ease;

  &:hover {
    background: var(--t-surface-hover);
    border-color: var(--t-line-strong);
  }

  &.unread {
    background: var(--t-accent-bg);
    border-color: var(--t-accent-line);
  }
}

.notice-item-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--t-text-faint);
  margin-top: 7px;
  flex-shrink: 0;

  &.p-urgent { background: var(--t-danger, var(--t-danger)); }
  &.p-important { background: var(--t-warning, var(--t-warning)); }
  &.p-normal { background: var(--t-accent); }
}

.notice-item-main {
  flex: 1;
  min-width: 0;
}

.notice-item-title {
  font-size: var(--t-fs-base);
  font-weight: 600;
  color: var(--t-text-1);
  line-height: 1.4;
  margin-bottom: 3px;
}

.notice-item-summary {
  font-size: var(--t-fs-xs);
  color: var(--t-text-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.notice-item-time {
  font-size: var(--t-fs-2xs);
  color: var(--t-text-faint);
  margin-top: 6px;
}

.notice-item-unread {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--t-danger);
}

.notice-footer {
  display: flex;
  justify-content: center;
  padding-top: 4px;
}

// 响应式
@media (max-width: 768px) {
  .sidebar {
    width: 64px;
  }

  .main-content {
    margin-left: 64px;
  }

  // 375px 顶栏溢出修复：此前 .header scrollWidth 409 / clientWidth 375，
  // 右侧的用户菜单（个人设置/退出登录）被挤出视口且无法横向滚到；
  // .logo-text 还被压成 14px 宽的竖排文字。窄屏下隐藏这些纯装饰/次要文本，
  // 并给头部与右侧容器 min-width:0 允许收缩。
  .header {
    padding: 0 12px;
    height: 56px;
    min-width: 0;
    gap: 8px;
  }

  .header-brand {
    min-width: 0;
    flex-shrink: 0;
  }

  .header-right {
    gap: 4px;
    min-width: 0;
  }

  .logo-text,
  .quick-switch-text,
  .quick-kbd,
  .user-name {
    display: none;
  }

  .quick-switch-btn {
    padding: 0 8px;
  }

  .content {
    padding: 16px;
    min-height: calc(100vh - 56px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .sidebar,
  .main-content {
    transition: none;
  }
}
</style>
