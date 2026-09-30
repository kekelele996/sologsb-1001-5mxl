<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Monitor } from '@element-plus/icons-vue'
import SubtitleWorkbench from './components/SubtitleWorkbench.vue'
import DubbingWorkbench from './components/DubbingWorkbench.vue'
import { useSubtitleStore } from './stores/subtitle'
import { useDubbingStore } from './stores/dubbing'
import type { Locale } from './types'

type Mode = 'subtitle' | 'dubbing'
const mode = ref<Mode>('subtitle')
const locale = ref<Locale>('zh-CN')

const subtitleStore = useSubtitleStore()
const dubbingStore = useDubbingStore()

const activeStore = computed(() => (mode.value === 'subtitle' ? subtitleStore : dubbingStore))

function onLocaleChange(value: Locale) {
  locale.value = value
  subtitleStore.setLocale(value)
  dubbingStore.setLocale(value)
}

onMounted(async () => {
  await subtitleStore.initialize()
  await dubbingStore.initialize()
  locale.value = subtitleStore.document?.language ?? 'zh-CN'
})

watch(mode, (value) => {
  if (value === 'dubbing') dubbingStore.syncFromSubtitle()
})
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><Monitor /></div>
        <div>
          <h1>{{ subtitleStore.t('appTitle') }}</h1>
          <p>{{ mode === 'subtitle' ? subtitleStore.t('subtitle') : dubbingStore.t('dubbingSubtitle') }}</p>
        </div>
      </div>
      <div class="top-actions">
        <el-radio-group :model-value="mode" size="small" @change="(value: Mode) => (mode = value)">
          <el-radio-button value="subtitle">{{ subtitleStore.t('modeSubtitle') }}</el-radio-button>
          <el-radio-button value="dubbing">{{ dubbingStore.t('modeDubbing') }}</el-radio-button>
        </el-radio-group>
        <el-select :model-value="locale" size="small" class="language-select" @change="onLocaleChange">
          <el-option label="简体中文" value="zh-CN" />
          <el-option label="English" value="en-US" />
          <el-option label="日本語" value="ja-JP" />
        </el-select>
      </div>
    </header>

    <SubtitleWorkbench v-if="mode === 'subtitle'" />
    <DubbingWorkbench v-else />
  </div>
</template>
