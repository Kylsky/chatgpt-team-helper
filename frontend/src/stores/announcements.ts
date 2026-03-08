import { ref } from 'vue'
import { defineStore } from 'pinia'
import { announcementService, type AnnouncementItem } from '@/services/api'

export const useAnnouncementsStore = defineStore('announcements', () => {
  const unreadCount = ref(0)
  const items = ref<AnnouncementItem[]>([])
  const listLoading = ref(false)
  const unreadLoading = ref(false)
  const error = ref('')
  const dialogOpen = ref(false)

  const reset = () => {
    unreadCount.value = 0
    items.value = []
    listLoading.value = false
    unreadLoading.value = false
    error.value = ''
    dialogOpen.value = false
  }

  const refreshUnreadCount = async () => {
    if (unreadLoading.value) return
    unreadLoading.value = true
    error.value = ''
    try {
      const response = await announcementService.unreadCount()
      unreadCount.value = Math.max(0, Number(response.unread || 0))
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 401 || status === 403) {
        unreadCount.value = 0
        return
      }
      error.value = err?.response?.data?.error || '获取未读公告失败'
    } finally {
      unreadLoading.value = false
    }
  }

  const fetchList = async () => {
    if (listLoading.value) return
    listLoading.value = true
    error.value = ''
    try {
      const response = await announcementService.list({ limit: 50, offset: 0 })
      items.value = Array.isArray(response.items) ? response.items : []
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 401 || status === 403) {
        items.value = []
        return
      }
      error.value = err?.response?.data?.error || '加载公告失败'
    } finally {
      listLoading.value = false
    }
  }

  const openDialog = async () => {
    dialogOpen.value = true
    await fetchList()
    await refreshUnreadCount()
  }

  const markRead = async (announcementId: number) => {
    const id = Number(announcementId)
    if (!Number.isFinite(id) || id <= 0) return

    const existing = items.value.find(item => item.id === id)
    if (existing?.read) return

    try {
      await announcementService.markRead(id)
      if (existing && !existing.read) {
        existing.read = true
        existing.readAt = existing.readAt || new Date().toISOString()
      }
      unreadCount.value = Math.max(0, unreadCount.value - 1)
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 401 || status === 403) {
        return
      }
      error.value = err?.response?.data?.error || '标记已读失败'
    }
  }

  const readAll = async () => {
    try {
      await announcementService.readAll()
      items.value = items.value.map(item => ({
        ...item,
        read: true,
        readAt: item.readAt || new Date().toISOString(),
      }))
      unreadCount.value = 0
    } catch (err: any) {
      const status = err?.response?.status
      if (status === 401 || status === 403) {
        return
      }
      error.value = err?.response?.data?.error || '全部已读失败'
    }
  }

  return {
    unreadCount,
    items,
    listLoading,
    unreadLoading,
    error,
    dialogOpen,
    reset,
    refreshUnreadCount,
    fetchList,
    openDialog,
    markRead,
    readAll,
  }
})

