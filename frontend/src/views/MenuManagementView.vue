<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { adminService, type RbacMenu } from '@/services/api'
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
import { Plus, RefreshCw, PencilLine, Trash2, Power, CornerDownRight } from 'lucide-vue-next'

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

const flatRows = computed(() => {
  const rows: Array<{ node: MenuNode; level: number }> = []
  for (const root of menuTree.value) {
    rows.push({ node: root, level: 0 })
    for (const child of root.children) {
      rows.push({ node: child, level: 1 })
    }
  }
  return rows
})

const rootMenuOptions = computed(() => {
  return menuTree.value.filter(node => node.parentId == null)
})

const loadMenus = async () => {
  loading.value = true
  try {
    const res = await adminService.getMenus()
    menus.value = res.menus || []
  } catch (err: any) {
    showError(err.response?.data?.error || '加载菜单失败')
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  await nextTick()
  teleportReady.value = !!document.getElementById('header-actions')
  await loadMenus()
})

onUnmounted(() => {
  teleportReady.value = false
})

const createDialogOpen = ref(false)
const createSaving = ref(false)
const createForm = ref({
  menuKey: '',
  label: '',
  path: '',
  parentId: null as number | null,
  sortOrder: 0,
  isActive: true,
})

const menuKeyPattern = /^[a-z][a-z0-9_]{2,63}$/

const openCreateDialog = (preset?: Partial<typeof createForm.value>) => {
  createForm.value = {
    menuKey: '',
    label: '',
    path: '',
    parentId: null,
    sortOrder: 0,
    isActive: true,
    ...(preset || {}),
  }
  createDialogOpen.value = true
}

const createMenu = async () => {
  const payload = {
    menuKey: createForm.value.menuKey.trim(),
    label: createForm.value.label.trim(),
    path: createForm.value.path.trim(),
    parentId: createForm.value.parentId,
    sortOrder: Number(createForm.value.sortOrder || 0),
    isActive: Boolean(createForm.value.isActive),
  }

  if (!menuKeyPattern.test(payload.menuKey)) {
    showError('menuKey 需为小写字母开头，且仅包含 a-z0-9_，长度 3-64')
    return
  }
  if (!payload.label) {
    showError('请输入菜单名称')
    return
  }

  createSaving.value = true
  try {
    await adminService.createMenu(payload)
    showSuccess('菜单已创建')
    createDialogOpen.value = false
    await loadMenus()
  } catch (err: any) {
    showError(err.response?.data?.error || '创建菜单失败')
  } finally {
    createSaving.value = false
  }
}

const editDialogOpen = ref(false)
const editSaving = ref(false)
const editingMenu = ref<MenuNode | null>(null)
const editForm = ref({
  label: '',
  path: '',
  parentId: null as number | null,
  sortOrder: 0,
  isActive: true,
})

const openEditDialog = (node: MenuNode) => {
  editingMenu.value = node
  editForm.value = {
    label: node.label,
    path: node.path || '',
    parentId: node.parentId,
    sortOrder: node.sortOrder || 0,
    isActive: Boolean(node.isActive),
  }
  editDialogOpen.value = true
}

const updateMenu = async () => {
  if (!editingMenu.value) return
  const payload = {
    label: editForm.value.label.trim(),
    path: editForm.value.path.trim(),
    parentId: editForm.value.parentId,
    sortOrder: Number(editForm.value.sortOrder || 0),
    isActive: Boolean(editForm.value.isActive),
  }
  if (!payload.label) {
    showError('请输入菜单名称')
    return
  }

  editSaving.value = true
  try {
    await adminService.updateMenu(editingMenu.value.id, payload)
    showSuccess('菜单已更新')
    editDialogOpen.value = false
    await loadMenus()
  } catch (err: any) {
    showError(err.response?.data?.error || '更新菜单失败')
  } finally {
    editSaving.value = false
  }
}

const toggleActive = async (node: MenuNode) => {
  try {
    await adminService.updateMenu(node.id, {
      label: node.label,
      path: node.path || '',
      parentId: node.parentId,
      sortOrder: node.sortOrder || 0,
      isActive: !node.isActive,
    })
    showSuccess(node.isActive ? '菜单已停用' : '菜单已启用')
    await loadMenus()
  } catch (err: any) {
    showError(err.response?.data?.error || '更新状态失败')
  }
}

const deleteMenu = async (node: MenuNode) => {
  const ok = window.confirm(`确认硬删除菜单「${node.label || node.menuKey}」？删除后不可恢复。`)
  if (!ok) return
  try {
    await adminService.deleteMenu(node.id)
    showSuccess('菜单已删除')
    await loadMenus()
  } catch (err: any) {
    showError(err.response?.data?.error || '删除菜单失败')
  }
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
          @click="loadMenus"
        >
          <RefreshCw class="h-4 w-4 mr-2" :class="loading ? 'animate-spin' : ''" />
          刷新列表
        </Button>
        <Button
          class="bg-black hover:bg-gray-800 text-white rounded-xl px-5 h-10 shadow-lg shadow-black/10"
          :disabled="loading"
          @click="openCreateDialog()"
        >
          <Plus class="w-4 h-4 mr-2" />
          新增一级菜单
        </Button>
      </div>
    </Teleport>

    <div>
      <h3 class="text-xl font-semibold text-gray-900">菜单管理</h3>
      <p class="text-sm text-gray-500 mt-1">管理系统菜单（支持一级/二级、相对路径、软删除）</p>
    </div>

    <div class="bg-white/70 border border-white/60 rounded-2xl shadow-sm overflow-hidden">
      <div class="overflow-auto">
        <table class="w-full text-sm">
          <thead class="bg-gray-50/60 text-gray-600">
            <tr>
              <th class="text-left font-medium px-4 py-3">菜单</th>
              <th class="text-left font-medium px-4 py-3">menuKey</th>
              <th class="text-left font-medium px-4 py-3">路径</th>
              <th class="text-left font-medium px-4 py-3">排序</th>
              <th class="text-left font-medium px-4 py-3">状态</th>
              <th class="text-right font-medium px-4 py-3">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="!flatRows.length && !loading">
              <td colspan="6" class="px-4 py-8 text-center text-gray-500">暂无菜单</td>
            </tr>

            <tr
              v-for="row in flatRows"
              :key="row.node.id"
              class="border-t border-gray-100 hover:bg-gray-50/40 transition"
            >
              <td class="px-4 py-3">
                <div class="flex items-center gap-2">
                  <CornerDownRight v-if="row.level === 1" class="w-4 h-4 text-gray-300" />
                  <span
                    class="font-medium"
                    :class="row.node.isActive ? 'text-gray-900' : 'text-gray-400 line-through'"
                  >
                    {{ row.node.label || row.node.menuKey }}
                  </span>
                </div>
              </td>
              <td class="px-4 py-3 text-gray-600 font-mono">{{ row.node.menuKey }}</td>
              <td class="px-4 py-3 text-gray-600 font-mono">
                <span v-if="row.node.path">{{ row.node.path }}</span>
                <span v-else class="text-gray-400">（分组/未配置）</span>
              </td>
              <td class="px-4 py-3 text-gray-600">{{ row.node.sortOrder || 0 }}</td>
              <td class="px-4 py-3">
                <span
                  class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                  :class="row.node.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'"
                >
                  {{ row.node.isActive ? '启用' : '已停用' }}
                </span>
              </td>
              <td class="px-4 py-3 text-right">
                <div class="inline-flex items-center gap-2">
                  <Button
                    v-if="row.level === 0"
                    variant="outline"
                    class="h-8"
                    @click="openCreateDialog({ parentId: row.node.id })"
                  >
                    <Plus class="w-4 h-4 mr-2" />
                    二级菜单
                  </Button>
                  <Button variant="outline" class="h-8" @click="openEditDialog(row.node)">
                    <PencilLine class="w-4 h-4 mr-2" />
                    编辑
                  </Button>
                  <Button variant="outline" class="h-8" @click="toggleActive(row.node)">
                    <Power class="w-4 h-4 mr-2" />
                    {{ row.node.isActive ? '停用' : '启用' }}
                  </Button>
                  <Button variant="outline" class="h-8 text-red-600 hover:text-red-700" @click="deleteMenu(row.node)">
                    <Trash2 class="w-4 h-4 mr-2" />
                    删除
                  </Button>
                </div>
              </td>
            </tr>

            <tr v-if="loading">
              <td colspan="6" class="px-4 py-8 text-center text-gray-500">加载中...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Create -->
    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新增菜单</DialogTitle>
          <DialogDescription>路径支持相对路径（如 users）或 /admin 开头绝对路径；留空表示分组菜单。</DialogDescription>
        </DialogHeader>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <Label>menuKey</Label>
            <Input v-model="createForm.menuKey" placeholder="例如: role_management" />
            <p class="text-xs text-gray-500 mt-1">创建后不可修改。</p>
          </div>
          <div>
            <Label>菜单名称</Label>
            <Input v-model="createForm.label" placeholder="例如: 角色管理" />
          </div>
          <div class="md:col-span-2">
            <Label>路径（可空）</Label>
            <Input v-model="createForm.path" placeholder="例如: roles 或 /admin/roles" />
          </div>
          <div>
            <Label>父菜单（可空）</Label>
            <select
              v-model="createForm.parentId"
              class="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option :value="null">一级菜单</option>
              <option v-for="root in rootMenuOptions" :key="root.id" :value="root.id">
                {{ root.label || root.menuKey }}
              </option>
            </select>
          </div>
          <div>
            <Label>排序</Label>
            <Input v-model="createForm.sortOrder" type="number" />
          </div>
          <div class="md:col-span-2 flex items-center gap-2">
            <input v-model="createForm.isActive" type="checkbox" class="h-4 w-4" />
            <span class="text-sm text-gray-700">启用</span>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="createSaving" @click="createDialogOpen = false">取消</Button>
          <Button :disabled="createSaving" @click="createMenu">
            {{ createSaving ? '创建中...' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Edit -->
    <Dialog v-model:open="editDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑菜单</DialogTitle>
          <DialogDescription>
            menuKey：<span class="font-mono">{{ editingMenu?.menuKey }}</span>
          </DialogDescription>
        </DialogHeader>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div class="md:col-span-2">
            <Label>菜单名称</Label>
            <Input v-model="editForm.label" />
          </div>
          <div class="md:col-span-2">
            <Label>路径（可空）</Label>
            <Input v-model="editForm.path" placeholder="例如: roles 或 /admin/roles" />
          </div>
          <div>
            <Label>父菜单（可空）</Label>
            <select
              v-model="editForm.parentId"
              class="w-full h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option :value="null">一级菜单</option>
              <option
                v-for="root in rootMenuOptions.filter(root => root.id !== (editingMenu?.id || 0))"
                :key="root.id"
                :value="root.id"
              >
                {{ root.label || root.menuKey }}
              </option>
            </select>
          </div>
          <div>
            <Label>排序</Label>
            <Input v-model="editForm.sortOrder" type="number" />
          </div>
          <div class="md:col-span-2 flex items-center gap-2">
            <input v-model="editForm.isActive" type="checkbox" class="h-4 w-4" />
            <span class="text-sm text-gray-700">启用</span>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="editSaving" @click="editDialogOpen = false">取消</Button>
          <Button :disabled="editSaving" @click="updateMenu">
            {{ editSaving ? '保存中...' : '保存' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
