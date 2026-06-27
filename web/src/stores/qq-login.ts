import { defineStore } from 'pinia'
import { ref } from 'vue'

type QqLoginStatus = 'idle' | 'qr_loading' | 'qr_ready' | 'scanning' | 'success' | 'error'

export const useQqLoginStore = defineStore('qq-login', () => {
  const isLoading = ref(false)
  const qrCode = ref<string | null>(null)
  const loginCode = ref('')
  const status = ref<QqLoginStatus>('idle')
  const statusMessage = ref('')
  const errorMessage = ref('')

  function resetState() {
    qrCode.value = null
    loginCode.value = ''
    status.value = 'idle'
    statusMessage.value = ''
    errorMessage.value = ''
  }

  async function getQRCode(): Promise<boolean> {
    isLoading.value = true
    status.value = 'qr_loading'
    statusMessage.value = '正在获取QQ扫码二维码...'
    errorMessage.value = ''

    try {
      const response = await fetch('/api/qr/create', { method: 'POST' })
      const result = await response.json()
      const data = result?.data || {}

      if (result.ok && data.code && data.image) {
        loginCode.value = String(data.code)
        qrCode.value = String(data.image)
        status.value = 'qr_ready'
        statusMessage.value = '请使用手机QQ扫码授权'
        return true
      }

      status.value = 'error'
      errorMessage.value = result.error || '获取QQ二维码失败'
      return false
    }
    catch (e: any) {
      status.value = 'error'
      errorMessage.value = `请求失败: ${e.message}`
      return false
    }
    finally {
      isLoading.value = false
    }
  }

  async function checkLogin(): Promise<{ success: boolean, code?: string, uin?: string, nickname?: string, avatar?: string }> {
    if (!loginCode.value) {
      return { success: false }
    }

    status.value = 'scanning'
    statusMessage.value = '正在检查QQ扫码状态...'

    try {
      const response = await fetch('/api/qr/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: loginCode.value }),
      })
      const result = await response.json()
      const data = result?.data || {}

      if (result.ok && data.status === 'OK' && data.code) {
        status.value = 'success'
        statusMessage.value = `登录成功${data.nickname ? `，${data.nickname}` : ''}`
        return {
          success: true,
          code: String(data.code),
          uin: data.uin ? String(data.uin) : '',
          nickname: data.nickname ? String(data.nickname) : '',
          avatar: data.avatar ? String(data.avatar) : '',
        }
      }

      if (result.ok && data.status === 'Wait') {
        status.value = 'qr_ready'
        statusMessage.value = '等待手机QQ扫码确认'
        return { success: false }
      }

      if (result.ok && data.status === 'Used') {
        status.value = 'error'
        errorMessage.value = '二维码已失效，请刷新'
        return { success: false }
      }

      status.value = 'error'
      errorMessage.value = data.error || result.error || 'QQ扫码登录失败'
      return { success: false }
    }
    catch (e: any) {
      status.value = 'error'
      errorMessage.value = `请求失败: ${e.message}`
      return { success: false }
    }
  }

  return {
    isLoading,
    qrCode,
    loginCode,
    status,
    statusMessage,
    errorMessage,
    resetState,
    getQRCode,
    checkLogin,
  }
})
