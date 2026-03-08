import { computed, ref, unref, type Ref } from 'vue'
import { redemptionCodeService } from '@/services/api'
import { EMAIL_REGEX } from '@/lib/validation'

export interface RedeemSuccessInfo {
  accountEmail: string
  userCount: number
  inviteStatus?: string
}

type MaybeRef<T> = T | Ref<T>

export const useRedeemForm = (channel: MaybeRef<string> = 'common') => {
  const redeemChannel = computed(() => {
    const raw = String(unref(channel) ?? '').trim().toLowerCase()
    return raw || 'common'
  })
  const formData = ref({
    email: '',
    code: '',
  })

  const isLoading = ref(false)
  const errorMessage = ref('')
  const successInfo = ref<RedeemSuccessInfo | null>(null)

  const isValidEmail = computed(() => {
    const email = formData.value.email.trim()
    if (!email) return true
    return EMAIL_REGEX.test(email)
  })

  const isValidCode = computed(() => {
    if (!formData.value.code) return true
    const codeRegex = /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
    return codeRegex.test(formData.value.code)
  })

  const handleCodeInput = (value: string | Event) => {
    let val = ''
    if (typeof value === 'string') {
      val = value
    } else {
      val = (value.target as HTMLInputElement).value
    }

    let formatted = val.toUpperCase().replace(/[^A-Z0-9]/g, '')

    if (formatted.length > 4 && formatted.length <= 8) {
      formatted = `${formatted.slice(0, 4)}-${formatted.slice(4)}`
    } else if (formatted.length > 8) {
      formatted = `${formatted.slice(0, 4)}-${formatted.slice(4, 8)}-${formatted.slice(8, 12)}`
    }

    if (formatted.length > 14) {
      formatted = formatted.slice(0, 14)
    }

    formData.value.code = formatted
  }

  const handleRedeem = async (options?: { extraData?: Record<string, any>; linuxDoSessionToken?: string }) => {
    errorMessage.value = ''
    successInfo.value = null

    const normalizedEmail = formData.value.email.trim()

    if (!normalizedEmail) {
      console.debug('[RedeemForm] email missing before submit', { rawEmail: formData.value.email })
      errorMessage.value = '请输入邮箱地址'
      return
    }

    if (!isValidEmail.value) {
      console.debug('[RedeemForm] invalid email format', {
        rawEmail: formData.value.email,
        normalizedEmail
      })
      errorMessage.value = '请输入有效的邮箱地址'
      return
    }

    if (!formData.value.code) {
      errorMessage.value = '请输入兑换码'
      return
    }

    if (!isValidCode.value) {
      errorMessage.value = '兑换码格式不正确，应为 XXXX-XXXX-XXXX 格式'
      return
    }

    isLoading.value = true

    try {
      const payload: Record<string, any> = {
        email: normalizedEmail,
        code: formData.value.code.trim(),
        channel: redeemChannel.value,
      }

      if (options?.extraData) {
        Object.assign(payload, options.extraData)
      }

      console.debug('[RedeemForm] submitting redeem request', {
        email: payload.email,
        channel: payload.channel,
        hasCode: !!payload.code,
        hasExtraData: !!options?.extraData
      })

      const response = await redemptionCodeService.redeem(
        payload as { email: string; code: string; channel?: string; redeemerUid?: string },
        options?.linuxDoSessionToken ? { linuxDoSessionToken: options.linuxDoSessionToken } : undefined
      )

      successInfo.value = {
        accountEmail: response.data.data.accountEmail,
        userCount: response.data.data.userCount,
        inviteStatus: response.data.data.inviteStatus,
      }

      formData.value = {
        email: '',
        code: '',
      }
    } catch (error: any) {
      if (error.response?.data?.message) {
        errorMessage.value = error.response.data.message
      } else if (error.response?.status === 404) {
        errorMessage.value = '兑换码不存在或已被使用'
      } else if (error.response?.status === 400) {
        errorMessage.value = '请求参数错误，请检查输入'
      } else if (error.response?.status === 503) {
        errorMessage.value = '暂无可用账号，请稍后再试'
      } else {
        errorMessage.value = '网络错误，请稍后重试'
      }
    } finally {
      isLoading.value = false
    }
  }

  return {
    formData,
    isLoading,
    errorMessage,
    successInfo,
    isValidEmail,
    isValidCode,
    handleCodeInput,
    handleRedeem,
  }
}
