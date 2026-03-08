<template>
  <div class="relative w-full" :class="props.disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'">
    <div
      class="relative w-full rounded-xl border bg-white px-4 flex items-center justify-between transition-all focus-within:ring-2 focus-within:ring-blue-100 focus-within:border-blue-500"
      :class="[sizeClass, props.borderClass || 'border-gray-200']"
    >
      <span v-if="displayValue" class="text-sm font-mono text-gray-700 truncate">{{ displayValue }}</span>
      <span v-else class="text-sm text-gray-400 truncate">{{ props.placeholder || '选择日期' }}</span>
      <Calendar class="w-4 h-4 text-gray-400 shrink-0 ml-3" />

      <input
        ref="inputRef"
        class="absolute inset-0 w-full h-full opacity-0"
        :class="props.disabled ? 'cursor-not-allowed' : 'cursor-pointer'"
        type="date"
        :value="props.modelValue || ''"
        :disabled="props.disabled"
        :aria-label="props.placeholder || '选择日期'"
        @input="handleInput"
        @click="handleClick"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { Calendar } from 'lucide-vue-next'

const props = defineProps<{
  modelValue?: string
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'default'
  borderClass?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const inputRef = ref<HTMLInputElement | null>(null)

const sizeClass = computed(() => props.size === 'sm' ? 'h-9' : 'h-10')

const displayValue = computed(() => {
  const value = String(props.modelValue || '').trim()
  if (!value) return ''
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return value
  return `${match[1]}年${match[2]}月${match[3]}日`
})

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement | null
  emit('update:modelValue', target?.value || '')
}

const handleClick = () => {
  if (props.disabled) return
  const input = inputRef.value as (HTMLInputElement & { showPicker?: () => void }) | null
  try {
    input?.showPicker?.()
  } catch {
    // 浏览器不支持 showPicker 时静默忽略
  }
}
</script>
