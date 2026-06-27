<script setup lang="ts">
import { useIntervalFn } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import api from '@/api'
import BaseButton from '@/components/ui/BaseButton.vue'
import BaseInput from '@/components/ui/BaseInput.vue'
import BaseTextarea from '@/components/ui/BaseTextarea.vue'
import { useQqLoginStore } from '@/stores/qq-login'
import { useWxLoginStore } from '@/stores/wx-login'

const props = defineProps<{
  show: boolean
  editData?: any
}>()

const emit = defineEmits(['close', 'saved'])

const wxLoginStore = useWxLoginStore()
const qqLoginStore = useQqLoginStore()

// 标签页：wx-微信扫码, manual-手动填码
const activeTab = ref<'qq' | 'wx' | 'manual'>('manual')
const loading = ref(false)
const errorMessage = ref('')
const qqQrLoginEnabled = false
const qqAccountName = ref('')

// 微信扫码相关
const wxAccountName = ref('')

// 表单数据
const form = reactive({
  name: '',
  code: '',
  platform: 'qq' as 'qq' | 'wx',
})

// 微信扫码轮询
const { pause: stopQqCheck, resume: startQqCheck } = useIntervalFn(async () => {
  if (qqLoginStore.status !== 'qr_ready')
    return

  const result = await qqLoginStore.checkLogin()
  if (result.success && result.code) {
    stopQqCheck()
    const name = qqAccountName.value.trim() || result.nickname || (result.uin ? `QQ${result.uin}` : `QQ账号${Date.now()}`)
    await addAccount({
      id: props.editData?.id,
      name: props.editData ? (props.editData.name || name) : name,
      code: result.code,
      platform: 'qq',
      loginType: 'qq_qr',
      qq: result.uin || '',
      uin: result.uin || '',
      avatar: result.avatar || '',
    })
  }
}, 2000, { immediate: false })

const { pause: stopWxCheck, resume: startWxCheck } = useIntervalFn(async () => {
  if (wxLoginStore.status !== 'qr_ready' && wxLoginStore.status !== 'confirming') {
    return
  }
  const result = await wxLoginStore.checkLogin()
  if (result.success && result.wxid) {
    stopWxCheck()
    // 获取Code并添加账号
    const codeResult = await wxLoginStore.getFarmCode()
    if (codeResult.success && codeResult.code) {
      const name = wxAccountName.value.trim() || result.nickname || `微信账号${Date.now()}`
      // 检查是否启用自动添加账号
      if (wxLoginStore.config.autoAddAccount) {
        await addAccount({
          id: props.editData?.id,
          name: props.editData ? (props.editData.name || name) : name,
          code: codeResult.code,
          platform: 'wx',
          loginType: 'wx_qr',
          wxid: result.wxid,
        })
      }
      else {
        // 不自动添加，只显示 code 让用户手动复制
        form.code = codeResult.code
        form.platform = 'wx'
        activeTab.value = 'manual'
      }
    }
  }
}, 2000, { immediate: false })

// 获取微信二维码
async function loadQqQRCode() {
  if (activeTab.value !== 'qq')
    return
  qqLoginStore.resetState()
  const success = await qqLoginStore.getQRCode()
  if (success)
    startQqCheck()
}

async function loadWxQRCode() {
  if (activeTab.value !== 'wx')
    return
  wxLoginStore.resetState()
  const success = await wxLoginStore.getQRCode()
  if (success) {
    startWxCheck()
  }
}

// 添加账号
async function addAccount(data: any) {
  loading.value = true
  errorMessage.value = ''
  try {
    const res = await api.post('/api/accounts', data)
    if (res.data.ok) {
      emit('saved')
      close()
    }
    else {
      errorMessage.value = `保存失败: ${res.data.error}`
    }
  }
  catch (e: any) {
    errorMessage.value = `保存失败: ${e.response?.data?.error || e.message}`
  }
  finally {
    loading.value = false
  }
}

// 手动提交
async function submitManual() {
  errorMessage.value = ''
  if (!form.code) {
    errorMessage.value = '请输入Code'
    return
  }

  let code = form.code.trim()
  const match = code.match(/[?&]code=([^&]+)/i)
  if (match && match[1]) {
    code = decodeURIComponent(match[1])
    form.code = code
  }

  let payload: any = {}
  if (props.editData) {
    const onlyNameChanged = form.name !== props.editData.name
      && form.code === (props.editData.code || '')
      && form.platform === (props.editData.platform || 'qq')

    if (onlyNameChanged) {
      payload = { id: props.editData.id, name: form.name }
    }
    else {
      payload = {
        id: props.editData.id,
        name: form.name,
        code,
        platform: form.platform,
        loginType: 'manual',
      }
    }
  }
  else {
    payload = {
      name: form.name,
      code,
      platform: form.platform,
      loginType: 'manual',
    }
  }

  await addAccount(payload)
}

// 微信二维码图片
const qqQrImageSrc = computed(() => {
  if (!qqLoginStore.qrCode)
    return ''
  if (qqLoginStore.qrCode.startsWith('data:'))
    return qqLoginStore.qrCode
  if (qqLoginStore.qrCode.startsWith('http'))
    return qqLoginStore.qrCode
  return `data:image/png;base64,${qqLoginStore.qrCode}`
})

const wxQrImageSrc = computed(() => {
  if (!wxLoginStore.qrCode)
    return ''
  if (wxLoginStore.qrCode.startsWith('data:'))
    return wxLoginStore.qrCode
  if (wxLoginStore.qrCode.startsWith('http'))
    return wxLoginStore.qrCode
  return `data:image/png;base64,${wxLoginStore.qrCode}`
})

function close() {
  stopQqCheck()
  stopWxCheck()
  qqLoginStore.resetState()
  wxLoginStore.resetState()
  emit('close')
}

watch(() => props.show, (newVal) => {
  if (newVal) {
    errorMessage.value = ''
    if (props.editData) {
      activeTab.value = 'manual'
      form.name = props.editData.name || ''
      form.code = props.editData.code || ''
      form.platform = props.editData.platform || 'qq'
      qqAccountName.value = props.editData.name || ''
      wxAccountName.value = props.editData.name || ''
    }
    else {
      activeTab.value = 'manual'
      form.name = ''
      form.code = ''
      form.platform = 'qq'
      qqAccountName.value = ''
      wxAccountName.value = ''
    }
  }
  else {
    stopQqCheck()
    stopWxCheck()
    qqLoginStore.resetState()
    wxLoginStore.resetState()
  }
})

watch(activeTab, (tab) => {
  stopQqCheck()
  stopWxCheck()
  if (tab === 'qq') {
    loadQqQRCode()
  }
  else if (tab === 'wx') {
    loadWxQRCode()
  }
})
</script>

<template>
  <div v-if="show" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
    <div class="max-h-[90vh] max-w-md w-full overflow-hidden rounded-lg shadow-xl" :style="{ background: 'var(--theme-bg)' }">
      <!-- Header -->
      <div class="flex items-center justify-between border-b p-4" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
        <h3 class="text-lg font-semibold" :style="{ color: 'var(--theme-text)' }">
          {{ editData ? '编辑账号' : '添加账号' }}
        </h3>
        <BaseButton variant="ghost" class="!p-1" @click="close">
          <div class="i-carbon-close text-xl" :style="{ color: 'var(--theme-text)' }" />
        </BaseButton>
      </div>

      <div class="max-h-[calc(90vh-80px)] overflow-y-auto p-4">
        <!-- 错误信息 -->
        <div v-if="errorMessage" class="mb-4 rounded p-3 text-sm" :style="{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444' }">
          {{ errorMessage }}
        </div>

        <!-- Tabs -->
        <div class="mb-4 flex border-b" :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 10%, transparent)' }">
          <button
            v-if="qqQrLoginEnabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'qq' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'qq' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'qq'"
          >
            QQ扫码
          </button>
          <button
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'manual' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'manual' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'manual'"
          >
            手动填码
          </button>
          <button
            v-if="wxLoginStore.config.enabled"
            class="flex-1 py-2 text-center text-sm font-medium transition-colors"
            :class="activeTab === 'wx' ? 'border-b-2' : 'opacity-60'"
            :style="{
              color: activeTab === 'wx' ? 'var(--theme-primary)' : 'var(--theme-text)',
              borderColor: 'var(--theme-primary)',
            }"
            @click="activeTab = 'wx'"
          >
            微信扫码
          </button>
        </div>

        <!-- 微信扫码 Tab -->
        <div v-if="qqQrLoginEnabled && activeTab === 'qq'" class="space-y-4">
          <BaseInput
            v-model="qqAccountName"
            label="账号备注（可选）"
            placeholder="留空使用QQ昵称"
          />

          <div class="flex flex-col items-center justify-center py-4 space-y-4">
            <div
              v-if="qqQrImageSrc"
              class="border rounded-lg p-2"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)', background: '#fff' }"
            >
              <img :src="qqQrImageSrc" class="h-48 w-48">
            </div>
            <div
              v-else
              class="h-48 w-48 flex items-center justify-center rounded-lg"
              :style="{ background: 'color-mix(in srgb, var(--theme-bg) 90%, var(--theme-text))' }"
            >
              <div v-if="qqLoginStore.isLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else class="text-sm" :style="{ color: 'var(--theme-text)' }">点击获取二维码</span>
            </div>

            <p class="text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ qqLoginStore.statusMessage }}
            </p>

            <p v-if="qqLoginStore.errorMessage" class="text-center text-sm text-red-600">
              {{ qqLoginStore.errorMessage }}
            </p>

            <BaseButton variant="secondary" size="sm" :loading="qqLoginStore.isLoading" @click="loadQqQRCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用手机QQ扫描二维码授权，登录成功后将自动添加QQ小程序账号
          </div>
        </div>

        <div v-if="activeTab === 'wx'" class="space-y-4">
          <BaseInput
            v-model="wxAccountName"
            label="账号备注（可选）"
            placeholder="留空使用微信昵称"
          />

          <div class="flex flex-col items-center justify-center py-4 space-y-4">
            <div
              v-if="wxQrImageSrc"
              class="border rounded-lg p-2"
              :style="{ borderColor: 'color-mix(in srgb, var(--theme-text) 20%, transparent)', background: '#fff' }"
            >
              <img :src="wxQrImageSrc" class="h-48 w-48">
            </div>
            <div
              v-else
              class="h-48 w-48 flex items-center justify-center rounded-lg"
              :style="{ background: 'color-mix(in srgb, var(--theme-bg) 90%, var(--theme-text))' }"
            >
              <div v-if="wxLoginStore.isLoading" i-svg-spinners-90-ring-with-bg class="text-3xl" :style="{ color: 'var(--theme-primary)' }" />
              <span v-else class="text-sm" :style="{ color: 'var(--theme-text)' }">点击获取二维码</span>
            </div>

            <p class="text-center text-sm" :style="{ color: 'var(--theme-text)' }">
              {{ wxLoginStore.statusMessage }}
            </p>

            <p v-if="wxLoginStore.errorMessage" class="text-center text-sm text-red-600">
              {{ wxLoginStore.errorMessage }}
            </p>

            <BaseButton variant="secondary" size="sm" :loading="wxLoginStore.isLoading" @click="loadWxQRCode">
              刷新二维码
            </BaseButton>
          </div>

          <div class="text-center text-xs opacity-60" :style="{ color: 'var(--theme-text)' }">
            使用微信扫描二维码登录，登录成功后将自动添加账号
          </div>
        </div>

        <!-- 手动填码 Tab -->
        <div v-if="activeTab === 'manual'" class="space-y-4">
          <BaseInput
            v-model="form.name"
            label="账号备注（可选）"
            placeholder="留空默认账号"
          />

          <BaseTextarea
            v-model="form.code"
            label="Code"
            placeholder="请输入登录 Code"
            :rows="3"
          />

          <div v-if="!editData" class="flex gap-4">
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="qq"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">QQ小程序</span>
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input
                v-model="form.platform"
                type="radio"
                value="wx"
                class="h-4 w-4"
                :style="{ accentColor: 'var(--theme-primary)' }"
              >
              <span class="text-sm" :style="{ color: 'var(--theme-text)' }">微信小程序</span>
            </label>
          </div>

          <div class="flex justify-end gap-2 pt-4">
            <BaseButton variant="outline" @click="close">
              取消
            </BaseButton>
            <BaseButton variant="primary" :loading="loading" @click="submitManual">
              {{ editData ? '保存' : '添加' }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
