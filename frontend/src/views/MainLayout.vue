<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { authService, userService } from '@/services/api'
import { Button } from '@/components/ui/button'
import { filterAdminMenuTreeByFeatureFlags, getFallbackAdminMenuTree, normalizeAdminMenuTree, type AdminMenuNode } from '@/lib/adminMenus'
import { Menu, X, LogOut, ChevronRight, Github } from 'lucide-vue-next'
import { useBreakpoints } from '@vueuse/core'
import { useAppConfigStore } from '@/stores/appConfig'
import { useAnnouncementsStore } from '@/stores/announcements'
import AnnouncementBell from '@/components/AnnouncementBell.vue'

const router = useRouter()
const route = useRoute()
const appConfigStore = useAppConfigStore()
const announcementsStore = useAnnouncementsStore()

const currentUser = ref(authService.getCurrentUser())
const githubRepoUrl = 'https://github.com/Kylsky/chatgpt-team-helper'

let unreadPollTimer: number | null = null

const stopUnreadPolling = () => {
  if (unreadPollTimer === null) return
  clearInterval(unreadPollTimer)
  unreadPollTimer = null
}

const startUnreadPolling = () => {
  stopUnreadPolling()
  unreadPollTimer = window.setInterval(() => {
    announcementsStore.refreshUnreadCount()
  }, 60_000)
}

const syncCurrentUser = () => {
  currentUser.value = authService.getCurrentUser()
  if (!authService.isAuthenticated()) {
    announcementsStore.reset()
    stopUnreadPolling()
  }
}

onMounted(() => {
  window.addEventListener('auth-updated', syncCurrentUser)
  ;(async () => {
    try {
      const me = await userService.getMe()
      authService.setCurrentUser(me)
      await announcementsStore.refreshUnreadCount()
      startUnreadPolling()
    } catch (error: any) {
      if (error?.response?.status === 401 || error?.response?.status === 403) {
        announcementsStore.reset()
        stopUnreadPolling()
        authService.logout()
        router.push('/login')
      }
    }
  })()
})

onUnmounted(() => {
  stopUnreadPolling()
  window.removeEventListener('auth-updated', syncCurrentUser)
})

const menuTree = computed<AdminMenuNode[]>(() => {
  const user: any = currentUser.value
  const tree = normalizeAdminMenuTree(user?.adminMenus)
  const resolved = tree.length ? tree : getFallbackAdminMenuTree(user?.menus, user?.roles)
  return filterAdminMenuTreeByFeatureFlags(resolved, appConfigStore.features)
})

const findLabelByPath = (nodes: AdminMenuNode[], path: string): string | null => {
  for (const node of nodes) {
    if (node.path && node.path === path) return node.label
    if (node.children?.length) {
      const child = findLabelByPath(node.children, path)
      if (child) return child
    }
  }
  return null
}

const currentPageLabel = computed(() => {
  return findLabelByPath(menuTree.value, route.path) || 'Console'
})

const roleLabel = computed(() => {
  const user = currentUser.value
  const roles = Array.isArray(user?.roles) ? user.roles.map(String) : []
  if (roles.includes('super_admin')) return '超级管理员'
  return roles.length ? roles.join(', ') : '普通用户'
})

const breakpoints = useBreakpoints({
  laptop: 1024,
})

const isLaptop = breakpoints.greater('laptop')
const isSidebarOpen = ref(isLaptop.value)

const handleMenuClick = () => {
  if (!isLaptop.value) {
    isSidebarOpen.value = false
  }
}

const handleLogout = () => {
  announcementsStore.reset()
  stopUnreadPolling()
  authService.logout()
  router.push('/login')
}

const toggleSidebar = () => {
  isSidebarOpen.value = !isSidebarOpen.value
}

watch(() => route.path, () => {
  if (!isLaptop.value) { 
    isSidebarOpen.value = false
  }
})

const isActive = (path: string) => {
  return route.path === path
}

const isNodeActive = (node: AdminMenuNode): boolean => {
  if (node.path && isActive(node.path)) return true
  return Boolean(node.children?.some(isNodeActive))
}

const expandedGroups = ref<Record<string, boolean>>({})

const ensureGroupKeys = (nodes: AdminMenuNode[]) => {
  const next = { ...expandedGroups.value }
  const walk = (list: AdminMenuNode[]) => {
    for (const node of list) {
      if (node.children?.length) {
        if (next[node.key] === undefined) next[node.key] = true
        walk(node.children)
      }
    }
  }
  walk(nodes)
  expandedGroups.value = next
}

const expandActiveGroups = (nodes: AdminMenuNode[]) => {
  const next = { ...expandedGroups.value }
  const walk = (node: AdminMenuNode): boolean => {
    const active = isNodeActive(node)
    if (node.children?.length) {
      const childActive = node.children.some(walk)
      if (active || childActive) next[node.key] = true
      return active || childActive
    }
    return active
  }
  for (const node of nodes) walk(node)
  expandedGroups.value = next
}

watch(menuTree, (nodes) => {
  ensureGroupKeys(nodes)
  expandActiveGroups(nodes)
}, { immediate: true })

watch(() => route.path, () => {
  expandActiveGroups(menuTree.value)
})

const toggleGroup = (key: string) => {
  expandedGroups.value = {
    ...expandedGroups.value,
    [key]: !expandedGroups.value[key],
  }
}

const isGroupExpanded = (key: string) => {
  const value = expandedGroups.value[key]
  return value === undefined ? true : value
}
</script>

<template>
  <div class="relative min-h-screen bg-[#F5F5F7]">
    
    <!-- 移动端遮罩 -->
    <div
      v-if="isSidebarOpen"
      class="fixed inset-0 z-30 bg-black/20 backdrop-blur-[2px] lg:hidden"
      @click="isSidebarOpen = false"
    />

    <!-- 侧边栏 -->
    <aside
      class="fixed inset-y-0 left-0 z-40 w-[260px] bg-[#F5F5F7]/95 backdrop-blur-xl border-r border-gray-200/50 flex flex-col transition-transform duration-500 cubic-bezier(0.32, 0.72, 0, 1)"
      :class="isSidebarOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <!-- Logo 区域 -->
      <div class="px-8 pt-10 pb-6">
        <div class="flex items-center gap-3 mb-2">
          <a
            :href="githubRepoUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="w-8 h-8 rounded-lg bg-gradient-to-br from-gray-900 to-gray-700 flex items-center justify-center shadow-lg shadow-black/10 hover:from-gray-800 hover:to-gray-600 transition-colors"
            aria-label="Open GitHub repository"
            title="GitHub"
            @click="handleMenuClick"
          >
            <Github class="w-5 h-5 text-white" />
          </a>
          <router-link to="/admin" class="text-xl font-semibold tracking-tight text-gray-900" @click="handleMenuClick">
            ChatGPT Team Helper
          </router-link>
        </div>
        <p class="text-xs font-medium text-gray-400 pl-11">Management Console</p>
      </div>

      <!-- 导航菜单 -->
      <nav class="flex-1 px-4 space-y-1 overflow-y-auto py-4">
        <template v-for="item in menuTree" :key="item.key">
          <!-- Group -->
          <div v-if="item.children?.length" class="space-y-1">
            <div
              class="relative group flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300"
              :class="isNodeActive(item)
                ? 'bg-white shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-blue-600'
                : 'text-gray-500 hover:bg-white/60 hover:text-gray-900'"
            >
              <component
                :is="item.icon"
                class="w-5 h-5 transition-colors duration-300"
                :class="isNodeActive(item) ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'"
                :strokeWidth="3"
              />

              <router-link
                v-if="item.path"
                :to="item.path"
                class="flex-1 font-medium text-[15px]"
                @click="handleMenuClick"
              >
                {{ item.label }}
              </router-link>
              <button
                v-else
                type="button"
                class="flex-1 text-left font-medium text-[15px]"
                @click="toggleGroup(item.key)"
              >
                {{ item.label }}
              </button>

              <button
                type="button"
                class="ml-auto p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-200/40 transition"
                @click.stop="toggleGroup(item.key)"
                aria-label="Toggle group"
              >
                <ChevronRight
                  class="w-4 h-4 transition-transform duration-300"
                  :class="isGroupExpanded(item.key) ? 'rotate-90' : ''"
                />
              </button>

              <div
                v-if="isNodeActive(item)"
                class="absolute right-3 w-1.5 h-1.5 rounded-full bg-blue-500"
              />
            </div>

            <div v-show="isGroupExpanded(item.key)" class="pl-6 space-y-1">
              <template v-for="child in item.children" :key="child.key">
                <router-link
                  v-if="child.path"
                  :to="child.path"
                  class="relative group flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-300"
                  :class="isActive(child.path)
                    ? 'bg-white shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-blue-600'
                    : 'text-gray-500 hover:bg-white/60 hover:text-gray-900'"
                  @click="handleMenuClick"
                >
                  <component
                    :is="child.icon"
                    class="w-5 h-5 transition-colors duration-300"
                    :class="isActive(child.path) ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'"
                    :strokeWidth="3"
                  />
                  <span class="font-medium text-[14px]">{{ child.label }}</span>

                  <div
                    v-if="isActive(child.path)"
                    class="absolute right-3 w-1.5 h-1.5 rounded-full bg-blue-500"
                  />
                </router-link>

                <div
                  v-else
                  class="relative flex items-center gap-3 px-4 py-2.5 rounded-xl text-gray-400 bg-white/30 cursor-not-allowed"
                  title="未配置路径"
                >
                  <component :is="child.icon" class="w-5 h-5" :strokeWidth="3" />
                  <span class="font-medium text-[14px]">{{ child.label }}</span>
                </div>
              </template>
            </div>
          </div>

          <!-- Leaf -->
          <template v-else>
            <router-link
              v-if="item.path"
              :to="item.path"
              class="relative group flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300"
              :class="isActive(item.path)
                ? 'bg-white shadow-[0_2px_12px_rgba(0,0,0,0.08)] text-blue-600'
                : 'text-gray-500 hover:bg-white/60 hover:text-gray-900'"
              @click="handleMenuClick"
            >
              <component
                :is="item.icon"
                class="w-5 h-5 transition-colors duration-300"
                :class="isActive(item.path) ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'"
                :strokeWidth="3"
              />
              <span class="font-medium text-[15px]">{{ item.label }}</span>

              <div
                v-if="isActive(item.path)"
                class="absolute right-3 w-1.5 h-1.5 rounded-full bg-blue-500"
              />
            </router-link>

            <div
              v-else
              class="relative flex items-center gap-3 px-4 py-3 rounded-xl text-gray-400 bg-white/30 cursor-not-allowed"
              title="未配置路径"
            >
              <component :is="item.icon" class="w-5 h-5" :strokeWidth="3" />
              <span class="font-medium text-[15px]">{{ item.label }}</span>
            </div>
          </template>
        </template>
      </nav>

      <!-- 底部用户区域 -->
      <div class="p-4 m-4 bg-white/50 rounded-2xl border border-white/60 shadow-sm backdrop-blur-sm">
        <div class="flex items-center gap-3 mb-3">
          <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center text-gray-500 font-semibold text-lg">
            {{ (currentUser?.username || 'A').charAt(0).toUpperCase() }}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-semibold text-gray-900 truncate">
              {{ currentUser?.username || 'Administrator' }}
            </p>
            <p class="text-xs text-gray-500 truncate">{{ roleLabel }}</p>
          </div>
          <AnnouncementBell />
        </div>
        <Button
          variant="ghost"
          class="w-full justify-start text-red-500 hover:text-red-600 hover:bg-red-50/50 h-9 px-2 font-medium"
          @click="handleLogout"
        >
          <LogOut class="w-4 h-4 mr-2" />
          退出登录
        </Button>
      </div>
    </aside>

    <!-- 主内容区域 -->
    <div 
      class="flex flex-col min-h-screen transition-all duration-500 cubic-bezier(0.32, 0.72, 0, 1)"
      :class="[isSidebarOpen ? 'lg:pl-[260px]' : 'lg:pl-0']"
    >
      <!-- 顶部栏 (仅移动端或需要面包屑时显示) -->
      <header class="flex-none h-16 px-6 flex items-center justify-between lg:hidden bg-[#F5F5F7]/80 backdrop-blur-md z-20 sticky top-0">
         <div class="flex items-center gap-3">
            <button
              class="p-2 -ml-2 rounded-lg hover:bg-gray-200/50 text-gray-600 transition-colors"
              @click="toggleSidebar"
            >
              <Menu v-if="!isSidebarOpen" class="w-6 h-6" />
              <X v-else class="w-6 h-6" />
            </button>
            <span class="font-semibold text-gray-900">{{ currentPageLabel }}</span>
         </div>
      </header>

      <!-- 滚动内容区 -->
      <main class="flex-1 overflow-auto p-4 lg:p-8 scroll-smooth">
        <div class="max-w-[1600px] mx-auto space-y-8 animate-fade-in-up">
          
          <!-- 页面标题与面包屑 -->
          <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between mb-6 lg:mb-8 gap-4">
            <div class="hidden lg:block">
              <h2 class="text-3xl font-bold text-gray-900 tracking-tight">
                {{ currentPageLabel || 'Dashboard' }}
              </h2>
              <div class="flex items-center gap-2 mt-2 text-sm text-gray-500 font-medium">
                <span>Console</span>
                <ChevronRight class="w-4 h-4 text-gray-400" />
                <span class="text-gray-900">{{ currentPageLabel || 'Home' }}</span>
              </div>
            </div>
            
            <!-- 顶部操作栏占位 -->
            <div id="header-actions" class="w-full lg:w-auto flex justify-end"></div>
          </div>

          <router-view />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* 自定义缓动动画 */
.cubic-bezier {
  transition-timing-function: cubic-bezier(0.32, 0.72, 0, 1);
}

/* 内容进入动画 — 使用 backwards 而非 forwards，避免动画结束后残留 transform 破坏后代 sticky 定位 */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.animate-fade-in-up {
  animation: fadeInUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) backwards;
}

/* 隐藏滚动条但保留功能 (可选) */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-track {
  background: transparent;
}
::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(0, 0, 0, 0.2);
}
</style>
