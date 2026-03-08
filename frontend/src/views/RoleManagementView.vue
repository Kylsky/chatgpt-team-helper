<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { adminService, authService, userService, type RbacMenu, type RbacRole } from '@/services/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useToast } from '@/components/ui/toast'
import { Plus, RefreshCw, Settings2 } from 'lucide-vue-next'

type MenuNode = {
  id: number
  menuKey: string
  label: string
  path: string
  parentId: number | null
  sortOrder: number
  isActive: boolean
  children: MenuNode[]
}

const { success: showSuccess, error: showError } = useToast()

const teleportReady = ref(false)
const loading = ref(false)
const roles = ref<RbacRole[]>([])
const menus = ref<RbacMenu[]>([])

const buildMenuTree = (items: RbacMenu[]): MenuNode[] => {
  const nodesById = new Map<number, MenuNode>()
  for (const menu of items || []) {
    if (!menu?.id || !menu.menuKey) continue
    nodesById.set(menu.id, {
      id: menu.id,
      menuKey: String(menu.menuKey),
      label: String(menu.label || ''),
      path: String(menu.path || ''),
      parentId: menu.parentId == null ? null : Number(menu.parentId),
      sortOrder: Number(menu.sortOrder || 0),
      isActive: Boolean(menu.isActive ?? true),
      children: [],
    })
  }

  const roots: MenuNode[] = []
  for (const node of nodesById.values()) {
    const parent = node.parentId ? nodesById.get(node.parentId) : null
    if (parent && parent !== node) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortTree = (list: MenuNode[]) => {
    list.sort((a, b) => {
      const order = (a.sortOrder || 0) - (b.sortOrder || 0)
      if (order !== 0) return order
      return (a.id || 0) - (b.id || 0)
    })
    for (const node of list) {
      if (node.children.length) sortTree(node.children)
    }
  }
  sortTree(roots)

  return roots
}

const menuTree = computed(() => buildMenuTree(menus.value))

const loadData = async () => {
  loading.value = true
  try {
    const [rolesRes, menusRes] = await Promise.all([
      adminService.getRoles(),
      adminService.getMenus(),
    ])
    roles.value = rolesRes.roles || []
    menus.value = menusRes.menus || []
  } catch (err: any) {
    showError(err.response?.data?.error || '加载角色/菜单失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  await loadData()
})

onUnmounted(() => {
  teleportReady.value = false
})

const createDialogOpen = ref(false)
const newRoleKey = ref('')
const newRoleName = ref('')
const newRoleDesc = ref('')
const newRoleMenuKeys = ref<Set<string>>(new Set())
const createSaving = ref(false)

const menuKeyPattern = /^[a-z][a-z0-9_]{2,63}$/

const resetCreateForm = () => {
  newRoleKey.value = ''
  newRoleName.value = ''
  newRoleDesc.value = ''
  newRoleMenuKeys.value = new Set()
}

const openCreateDialog = () => {
  resetCreateForm()
  createDialogOpen.value = true
}

const toggleSelection = (selected: Set<string>, key: string, value?: boolean) => {
  const next = new Set(selected)
  const shouldSelect = value ?? !next.has(key)
  if (shouldSelect) next.add(key)
  else next.delete(key)
  return next
}

const setSubtreeSelection = (selected: Set<string>, node: MenuNode, value: boolean) => {
  let next = new Set(selected)
  next = toggleSelection(next, node.menuKey, value)
  for (const child of node.children) {
    next = toggleSelection(next, child.menuKey, value)
  }
  return next
}

const getSubtreeState = (selected: Set<string>, node: MenuNode) => {
  const keys = [node.menuKey, ...node.children.map(c => c.menuKey)]
  const count = keys.filter(k => selected.has(k)).length
  return {
    total: keys.length,
    count,
    checked: count === keys.length,
    indeterminate: count > 0 && count < keys.length,
  }
}

const createRole = async () => {
  const roleKey = newRoleKey.value.trim()
  const roleName = newRoleName.value.trim()
  const description = newRoleDesc.value.trim()

  if (!menuKeyPattern.test(roleKey)) {
    showError('roleKey 需为小写字母开头，且仅包含 a-z0-9_，长度 3-64')
    return
  }
  if (!roleName) {
    showError('请输入角色名称')
    return
  }

  createSaving.value = true
  try {
    await adminService.createRole({
      roleKey,
      roleName,
      description,
      menuKeys: Array.from(newRoleMenuKeys.value),
    })
    showSuccess('角色已创建')
    createDialogOpen.value = false
    await loadData()
  } catch (err: any) {
    showError(err.response?.data?.error || '创建角色失败')
  } finally {
    createSaving.value = false
  }
}

const editDialogOpen = ref(false)
const editingRole = ref<RbacRole | null>(null)
const editingMenuKeys = ref<Set<string>>(new Set())
const editSaving = ref(false)

const openEditMenus = (role: RbacRole) => {
  editingRole.value = role
  editingMenuKeys.value = new Set((role.menuKeys || []).map(String))
  editDialogOpen.value = true
}

const saveRoleMenus = async () => {
  if (!editingRole.value) return
  editSaving.value = true
  try {
    const nextKeys = Array.from(editingMenuKeys.value)
    await adminService.updateRoleMenus(editingRole.value.id, nextKeys)
    const idx = roles.value.findIndex(r => r.id === editingRole.value?.id)
    if (idx !== -1 && roles.value[idx]) {
      roles.value[idx] = { ...roles.value[idx]!, menuKeys: nextKeys }
    }

    const currentUser = authService.getCurrentUser()
    const currentRoles = Array.isArray(currentUser?.roles) ? currentUser.roles.map(String) : []
    if (editingRole.value?.roleKey && currentRoles.includes(editingRole.value.roleKey)) {
      try {
        const me = await userService.getMe()
        authService.setCurrentUser(me)
      } catch (refreshError) {
        console.warn('Refresh current user after role menu update failed:', refreshError)
      }
    }
    showSuccess('角色菜单权限已更新')
    editDialogOpen.value = false
  } catch (err: any) {
    showError(err.response?.data?.error || '更新角色菜单失败')
  } finally {
    editSaving.value = false
  }
}

const formatMenuCount = (role: RbacRole) => {
  const count = Array.isArray(role.menuKeys) ? role.menuKeys.length : 0
  return `${count} 项`
}
</script>

<template>
  <div class="space-y-6">
    <Teleport v-if="teleportReady" to="#header-actions">
      <div class="flex items-center gap-3 flex-wrap justify-end">
        <Button
          variant="outline"
          class="bg-white border-gray-200 text-gray-700 hover:bg-gray-50 h-10 rounded-xl px-4"
          :disabled="loading"
          @click="loadData"
        >
          <RefreshCw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
          刷新列表
        </Button>
        <Button
          class="bg-black hover:bg-gray-800 text-white rounded-xl px-5 h-10 shadow-lg shadow-black/10"
          :disabled="loading"
          @click="openCreateDialog"
        >
          <Plus class="w-4 h-4 mr-2" />
          新建角色
        </Button>
      </div>
    </Teleport>

    <div>
      <h3 class="text-xl font-semibold text-gray-900">角色管理</h3>
      <p class="text-sm text-gray-500 mt-1">为角色分配可访问的系统菜单（menu_key）</p>
    </div>

    <div class="bg-white/70 border border-white/60 rounded-2xl shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50/60 text-gray-600">
            <tr>
              <th class="text-left font-medium px-4 py-3">角色名称</th>
              <th class="text-left font-medium px-4 py-3">角色标识</th>
              <th class="text-left font-medium px-4 py-3">描述</th>
              <th class="text-left font-medium px-4 py-3">菜单权限</th>
              <th class="text-right font-medium px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!roles.length && !loading">
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">暂无角色</td>
            </tr>
            <tr
              v-for="role in roles"
              :key="role.id"
              class="border-t border-gray-100 hover:bg-gray-50/40 transition"
            >
              <td class="px-4 py-3 font-medium text-gray-900">{{ role.roleName }}</td>
              <td class="px-4 py-3 text-gray-600 font-mono">{{ role.roleKey }}</td>
              <td class="px-4 py-3 text-gray-600">{{ role.description || '-' }}</td>
              <td class="px-4 py-3 text-gray-600">{{ formatMenuCount(role) }}</td>
              <td class="px-4 py-3 text-right">
                <Button variant="outline" class="h-8" @click="openEditMenus(role)">
                  <Settings2 class="w-4 h-4 mr-2" />
                  配置菜单
                </Button>
              </td>
            </tr>
            <tr v-if="loading">
              <td colspan="5" class="px-4 py-8 text-center text-gray-500">加载中...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create role -->
    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>新建角色</DialogTitle>
          <DialogDescription>创建后可在「配置菜单」中继续调整权限。</DialogDescription>
        </DialogHeader>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>角色标识（roleKey）</Label>
            <Input v-model="newRoleKey" placeholder="例如: ops_admin" />
            <p class="text-xs text-gray-500 mt-1">仅支持小写字母/数字/下划线，长度 3-64。</p>
          </div>
          <div>
            <Label>角色名称</Label>
            <Input v-model="newRoleName" placeholder="例如: 运营管理员" />
          </div>
          <div class="md:col-span-2">
            <Label>描述</Label>
            <Input v-model="newRoleDesc" placeholder="可选" />
          </div>
        </div>

        <div class="mt-4">
          <div class="flex items-center justify-between">
            <Label>初始菜单权限</Label>
            <div class="text-xs text-gray-500">勾选后将写入 role_menus</div>
          </div>

          <div class="mt-2 max-h-[360px] overflow-auto rounded-xl border border-gray-200 bg-white">
            <div class="p-3 space-y-2">
              <div v-for="node in menuTree" :key="node.menuKey" class="space-y-1">
                <div class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    class="h-4 w-4"
                    :checked="getSubtreeState(newRoleMenuKeys, node).checked"
                    :ref="(el: any) => { if (el) el.indeterminate = getSubtreeState(newRoleMenuKeys, node).indeterminate }"
                    @change="newRoleMenuKeys = setSubtreeSelection(newRoleMenuKeys, node, !getSubtreeState(newRoleMenuKeys, node).checked)"
                  />
                  <span class="font-medium text-gray-900">
                    {{ node.label || node.menuKey }}
                    <span v-if="!node.isActive" class="ml-2 text-xs text-gray-400">已停用</span>
                  </span>
                  <span class="text-xs text-gray-400 font-mono">{{ node.menuKey }}</span>
                </div>

                <div v-if="node.children.length" class="pl-6 space-y-1">
                  <label
                    v-for="child in node.children"
                    :key="child.menuKey"
                    class="flex items-center gap-2 text-sm"
                    :class="child.isActive ? 'text-gray-700' : 'text-gray-400'"
                  >
                    <input
                      type="checkbox"
                      class="h-4 w-4"
                      :checked="newRoleMenuKeys.has(child.menuKey)"
                      @change="newRoleMenuKeys = toggleSelection(newRoleMenuKeys, child.menuKey)"
                    />
                    <span>{{ child.label || child.menuKey }}</span>
                    <span class="text-xs text-gray-400 font-mono">{{ child.menuKey }}</span>
                  </label>
                </div>
              </div>
              <div v-if="!menuTree.length" class="py-10 text-center text-gray-500">暂无菜单</div>
            </div>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="createSaving" @click="createDialogOpen = false">取消</Button>
          <Button :disabled="createSaving" @click="createRole">
            {{ createSaving ? '创建中...' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Edit role menus -->
    <Dialog v-model:open="editDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>配置菜单权限</DialogTitle>
          <DialogDescription>
            角色：{{ editingRole?.roleName }}（{{ editingRole?.roleKey }}）
          </DialogDescription>
        </DialogHeader>

        <div class="max-h-[440px] overflow-auto rounded-xl border border-gray-200 bg-white">
          <div class="p-3 space-y-2">
            <div v-for="node in menuTree" :key="node.menuKey" class="space-y-1">
              <div class="flex items-center gap-2">
                <input
                  type="checkbox"
                  class="h-4 w-4"
                  :checked="getSubtreeState(editingMenuKeys, node).checked"
                  :ref="(el: any) => { if (el) el.indeterminate = getSubtreeState(editingMenuKeys, node).indeterminate }"
                  @change="editingMenuKeys = setSubtreeSelection(editingMenuKeys, node, !getSubtreeState(editingMenuKeys, node).checked)"
                />
                <span class="font-medium text-gray-900">
                  {{ node.label || node.menuKey }}
                  <span v-if="!node.isActive" class="ml-2 text-xs text-gray-400">已停用</span>
                </span>
                <span class="text-xs text-gray-400 font-mono">{{ node.menuKey }}</span>
              </div>

              <div v-if="node.children.length" class="pl-6 space-y-1">
                <label
                  v-for="child in node.children"
                  :key="child.menuKey"
                  class="flex items-center gap-2 text-sm"
                  :class="child.isActive ? 'text-gray-700' : 'text-gray-400'"
                >
                  <input
                    type="checkbox"
                    class="h-4 w-4"
                    :checked="editingMenuKeys.has(child.menuKey)"
                    @change="editingMenuKeys = toggleSelection(editingMenuKeys, child.menuKey)"
                  />
                  <span>{{ child.label || child.menuKey }}</span>
                  <span class="text-xs text-gray-400 font-mono">{{ child.menuKey }}</span>
                </label>
              </div>
            </div>
            <div v-if="!menuTree.length" class="py-10 text-center text-gray-500">暂无菜单</div>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="editSaving" @click="editDialogOpen = false">取消</Button>
          <Button :disabled="editSaving" @click="saveRoleMenus">
            {{ editSaving ? '保存中...' : '保存' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
