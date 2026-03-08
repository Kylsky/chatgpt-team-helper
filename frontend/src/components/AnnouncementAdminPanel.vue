<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { adminService, type AdminAnnouncementItem } from '@/services/api'
import { formatShanghaiDate } from '@/lib/datetime'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PencilLine, Plus, RefreshCw, Trash2 } from 'lucide-vue-next'

const loading = ref(false)
const error = ref('')
const items = ref<AdminAnnouncementItem[]>([])
const page = reactive({ limit: 20, offset: 0, total: 0 })

const createDialogOpen = ref(false)
const createSaving = ref(false)
const createForm = reactive({
  title: '',
  content: '',
  pinned: false,
  isPublished: true,
})

const editDialogOpen = ref(false)
const editSaving = ref(false)
const editing = ref<AdminAnnouncementItem | null>(null)
const editForm = reactive({
  title: '',
  content: '',
  pinned: false,
  isPublished: true,
})

const canPrev = computed(() => page.offset > 0)
const canNext = computed(() => page.offset + page.limit < page.total)

const fetchList = async () => {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const response = await adminService.listAnnouncements({ limit: page.limit, offset: page.offset })
    items.value = Array.isArray(response.items) ? response.items : []
    page.total = Number(response.page?.total || 0)
  } catch (err: any) {
    error.value = err?.response?.data?.error || '加载公告失败'
  } finally {
    loading.value = false
  }
}

const refresh = async () => {
  page.offset = 0
  await fetchList()
}

const openCreate = () => {
  createForm.title = ''
  createForm.content = ''
  createForm.pinned = false
  createForm.isPublished = true
  createDialogOpen.value = true
}

const createAnnouncement = async () => {
  const title = String(createForm.title || '').trim()
  const content = String(createForm.content || '').trim()
  if (!title) {
    error.value = '请输入标题'
    return
  }
  if (!content) {
    error.value = '请输入内容'
    return
  }

  createSaving.value = true
  error.value = ''
  try {
    await adminService.createAnnouncement({
      title,
      content,
      pinned: Boolean(createForm.pinned),
      isPublished: Boolean(createForm.isPublished),
    })
    createDialogOpen.value = false
    await refresh()
  } catch (err: any) {
    error.value = err?.response?.data?.error || '创建公告失败'
  } finally {
    createSaving.value = false
  }
}

const openEdit = (item: AdminAnnouncementItem) => {
  editing.value = item
  editForm.title = item.title
  editForm.content = item.content
  editForm.pinned = Boolean(item.pinned)
  editForm.isPublished = Boolean(item.isPublished)
  editDialogOpen.value = true
}

const updateAnnouncement = async () => {
  const current = editing.value
  if (!current) return

  const title = String(editForm.title || '').trim()
  const content = String(editForm.content || '').trim()
  if (!title) {
    error.value = '请输入标题'
    return
  }
  if (!content) {
    error.value = '请输入内容'
    return
  }

  editSaving.value = true
  error.value = ''
  try {
    await adminService.updateAnnouncement(current.id, {
      title,
      content,
      pinned: Boolean(editForm.pinned),
      isPublished: Boolean(editForm.isPublished),
    })
    editDialogOpen.value = false
    editing.value = null
    await fetchList()
  } catch (err: any) {
    error.value = err?.response?.data?.error || '保存公告失败'
  } finally {
    editSaving.value = false
  }
}

const deleteAnnouncement = async (item: AdminAnnouncementItem) => {
  const ok = window.confirm(`确认删除公告「${item.title}」？`)
  if (!ok) return

  error.value = ''
  try {
    await adminService.deleteAnnouncement(item.id)
    await fetchList()
  } catch (err: any) {
    error.value = err?.response?.data?.error || '删除公告失败'
  }
}

const goPrev = async () => {
  if (!canPrev.value) return
  page.offset = Math.max(0, page.offset - page.limit)
  await fetchList()
}

const goNext = async () => {
  if (!canNext.value) return
  page.offset = page.offset + page.limit
  await fetchList()
}

onMounted(fetchList)
</script>

<template>
  <div class="space-y-8">
    <Card class="bg-white rounded-[32px] border border-gray-100 shadow-sm overflow-hidden">
      <CardHeader class="border-b border-gray-50 bg-gray-50/30 px-6 py-5 sm:px-8 sm:py-6">
        <div class="flex items-center justify-between gap-4">
          <div>
            <CardTitle class="text-xl font-bold text-gray-900">公告管理</CardTitle>
            <CardDescription class="text-gray-500">创建、编辑和删除系统公告（用户侧将显示未读提醒）。</CardDescription>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="outline" class="h-10 rounded-xl" :disabled="loading" @click="refresh">
              <RefreshCw class="w-4 h-4 mr-2" :class="loading ? 'animate-spin' : ''" />
              刷新
            </Button>
            <Button class="h-10 rounded-xl bg-black hover:bg-gray-800 text-white" @click="openCreate">
              <Plus class="w-4 h-4 mr-2" />
              新建公告
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent class="p-0">
        <div v-if="error" class="p-6 sm:p-8">
          <div class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
            {{ error }}
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full">
            <thead>
              <tr class="border-b border-gray-100 bg-gray-50/50">
                <th class="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">标题</th>
                <th class="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">状态</th>
                <th class="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">置顶</th>
                <th class="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">发布时间</th>
                <th class="px-6 py-4 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">操作</th>
              </tr>
            </thead>

            <tbody class="divide-y divide-gray-50">
              <tr v-for="item in items" :key="item.id">
                <td class="px-6 py-5 text-sm text-gray-900 font-medium">
                  <div class="flex items-center gap-2 min-w-0">
                    <span class="truncate">{{ item.title }}</span>
                    <span v-if="item.pinned" class="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-50 text-amber-700">
                      置顶
                    </span>
                  </div>
                </td>
                <td class="px-6 py-5">
                  <span
                    class="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium"
                    :class="item.isPublished ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'"
                  >
                    {{ item.isPublished ? '已发布' : '草稿' }}
                  </span>
                </td>
                <td class="px-6 py-5 text-sm text-gray-600">
                  {{ item.pinned ? '是' : '否' }}
                </td>
                <td class="px-6 py-5 text-sm text-gray-600">
                  {{ formatShanghaiDate(item.publishedAt) }}
                </td>
                <td class="px-6 py-5 text-right">
                  <div class="inline-flex items-center gap-2">
                    <Button variant="outline" class="h-8" @click="openEdit(item)">
                      <PencilLine class="w-4 h-4 mr-2" />
                      编辑
                    </Button>
                    <Button
                      variant="outline"
                      class="h-8 text-red-600 hover:text-red-700"
                      @click="deleteAnnouncement(item)"
                    >
                      <Trash2 class="w-4 h-4 mr-2" />
                      删除
                    </Button>
                  </div>
                </td>
              </tr>

              <tr v-if="loading">
                <td colspan="5" class="px-6 py-10 text-center text-sm text-gray-500">加载中...</td>
              </tr>
              <tr v-else-if="items.length === 0">
                <td colspan="5" class="px-6 py-10 text-center text-sm text-gray-500">暂无公告</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="p-4 border-t border-gray-100 flex items-center justify-between">
          <Button variant="ghost" class="rounded-xl" :disabled="!canPrev" @click="goPrev">上一页</Button>
          <div class="text-xs text-gray-500 tabular-nums">
            {{ page.total ? `${page.offset + 1}-${Math.min(page.offset + page.limit, page.total)} / ${page.total}` : '-' }}
          </div>
          <Button variant="ghost" class="rounded-xl" :disabled="!canNext" @click="goNext">下一页</Button>
        </div>
      </CardContent>
    </Card>

    <!-- Create -->
    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建公告</DialogTitle>
          <DialogDescription>用户侧将显示未读提醒；内容为纯文本，支持换行。</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2">
            <Label>标题</Label>
            <Input v-model="createForm.title" placeholder="请输入公告标题" />
          </div>

          <div class="space-y-2">
            <Label>内容</Label>
            <textarea
              v-model="createForm.content"
              rows="8"
              class="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
              placeholder="请输入公告内容（纯文本）"
            />
          </div>

          <div class="flex items-center gap-6">
            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
              <input v-model="createForm.isPublished" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              发布
            </label>
            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
              <input v-model="createForm.pinned" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              置顶
            </label>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="createSaving" @click="createDialogOpen = false">取消</Button>
          <Button :disabled="createSaving" @click="createAnnouncement">
            {{ createSaving ? '创建中...' : '创建' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Edit -->
    <Dialog v-model:open="editDialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑公告</DialogTitle>
          <DialogDescription>公告 ID：<span class="font-mono">#{{ editing?.id || '-' }}</span></DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="space-y-2">
            <Label>标题</Label>
            <Input v-model="editForm.title" placeholder="请输入公告标题" />
          </div>

          <div class="space-y-2">
            <Label>内容</Label>
            <textarea
              v-model="editForm.content"
              rows="10"
              class="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-500 transition-all"
              placeholder="请输入公告内容（纯文本）"
            />
          </div>

          <div class="flex items-center gap-6">
            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
              <input v-model="editForm.isPublished" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              发布
            </label>
            <label class="inline-flex items-center gap-2 text-sm text-gray-700">
              <input v-model="editForm.pinned" type="checkbox" class="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              置顶
            </label>
          </div>
        </div>

        <DialogFooter class="mt-4">
          <Button variant="outline" :disabled="editSaving" @click="editDialogOpen = false">取消</Button>
          <Button :disabled="editSaving" @click="updateAnnouncement">
            {{ editSaving ? '保存中...' : '保存' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

