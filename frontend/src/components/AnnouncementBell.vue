<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { Bell, CheckCheck } from 'lucide-vue-next'
import { useAnnouncementsStore } from '@/stores/announcements'
import { formatShanghaiDate } from '@/lib/datetime'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const store = useAnnouncementsStore()
const { unreadCount, items, listLoading, error, dialogOpen } = storeToRefs(store)

const expandedId = ref<number | null>(null)

const hasUnread = computed(() => (unreadCount.value || 0) > 0)
const badgeText = computed(() => {
  const value = Number(unreadCount.value || 0)
  if (!Number.isFinite(value) || value <= 0) return ''
  return value > 99 ? '99+' : String(value)
})

const openDialog = async () => {
  await store.openDialog()
}

const toggleItem = async (id: number) => {
  const next = expandedId.value === id ? null : id
  expandedId.value = next
  if (next !== null) {
    const item = items.value.find(entry => entry.id === id)
    if (item && !item.read) {
      await store.markRead(id)
    }
  }
}

watch(dialogOpen, (open) => {
  if (!open) {
    expandedId.value = null
  }
})
</script>

<template>
  <div>
    <Button
      variant="ghost"
      size="icon-sm"
      class="relative text-gray-500 hover:text-gray-700 hover:bg-white/60"
      aria-label="公告"
      title="公告"
      @click="openDialog"
    >
      <Bell class="w-4 h-4" />
      <span
        v-if="hasUnread"
        class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center leading-none shadow"
      >
        {{ badgeText }}
      </span>
    </Button>

    <Dialog v-model:open="dialogOpen">
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>公告</DialogTitle>
          <DialogDescription>点击公告可查看详情并自动标记已读。</DialogDescription>
        </DialogHeader>

        <div v-if="error" class="rounded-xl bg-red-50 p-4 text-red-600 border border-red-100 text-sm font-medium">
          {{ error }}
        </div>

        <div v-if="listLoading" class="py-10 text-center text-sm text-gray-500">加载中…</div>
        <div v-else-if="items.length === 0" class="py-10 text-center text-sm text-gray-500">暂无公告</div>
        <div v-else class="max-h-[60vh] overflow-auto space-y-3 pr-1">
          <div
            v-for="item in items"
            :key="item.id"
            class="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden"
            :class="item.read ? '' : 'ring-1 ring-blue-100'"
          >
            <button
              type="button"
              class="w-full text-left px-5 py-4 hover:bg-gray-50/60 transition-colors"
              @click="toggleItem(item.id)"
            >
              <div class="flex items-start gap-3">
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 min-w-0">
                    <span
                      class="text-sm text-gray-900 truncate"
                      :class="item.read ? 'font-medium' : 'font-semibold'"
                    >
                      {{ item.title }}
                    </span>
                    <span v-if="item.pinned" class="shrink-0 px-2 py-0.5 text-[10px] font-medium rounded-full bg-amber-50 text-amber-700">
                      置顶
                    </span>
                    <span v-if="!item.read" class="shrink-0 w-2 h-2 rounded-full bg-red-500" />
                  </div>
                  <div class="mt-1 text-xs text-gray-500">
                    {{ formatShanghaiDate(item.publishedAt) }}
                  </div>
                </div>

                <div class="shrink-0 flex items-center gap-2">
                  <Button
                    v-if="!item.read"
                    variant="outline"
                    class="h-7 px-2 text-xs rounded-lg"
                    @click.stop="store.markRead(item.id)"
                  >
                    标记已读
                  </Button>
                  <span v-else class="text-xs text-gray-400">已读</span>
                </div>
              </div>
            </button>

            <div v-if="expandedId === item.id" class="px-5 pb-5">
              <div class="rounded-2xl bg-gray-50 border border-gray-100 p-4 text-sm text-gray-700 whitespace-pre-wrap">
                {{ item.content }}
              </div>
            </div>
          </div>
        </div>

        <div class="mt-4 flex items-center justify-end gap-2">
          <Button
            variant="outline"
            class="rounded-xl"
            :disabled="!hasUnread"
            @click="store.readAll"
          >
            <CheckCheck class="w-4 h-4 mr-2" />
            全部已读
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
