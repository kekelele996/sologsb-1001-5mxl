<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { Download, UploadFilled, Warning } from '@element-plus/icons-vue'
import { useDubbingStore } from '../stores/dubbing'
import { formatTime } from '../utils/subtitle'
import DubbingMergeDialog from './DubbingMergeDialog.vue'

const store = useDubbingStore()
const { document: dubbing, visibleCues, saveState, conflict, actors } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()

const saveLabel = () => ({
  saved: store.t('saved'), dirty: store.t('dirty'), saving: store.t('saving'), conflict: store.t('conflict'),
}[saveState.value])

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    await store.importDubbingFile(file)
  } catch (error) {
    const key = error instanceof Error && error.message === 'DUBBING_PARSE' ? 'dubbingParseError' : 'dubbingFormatError'
    ElMessage.error(store.t(key))
  } finally {
    input.value = ''
  }
}

async function exportDubbing() {
  try {
    await store.exportDubbing()
    ElMessage.success(store.t('dubbingExported'))
  } catch {
    ElMessage.error(store.t('saveError'))
  }
}

onMounted(async () => {
  await store.initialize()
  await store.syncFromSubtitle()
})
</script>

<template>
  <div class="workbench">
    <div v-if="conflict" class="conflict-banner">
      <div>
        <strong>{{ store.t('conflictTitle') }}</strong>
        <span>{{ store.t('dubbingConflictBody') }}</span>
      </div>
      <div class="conflict-actions">
        <el-button size="small" @click="store.loadLatest">{{ store.t('loadLatest') }}</el-button>
        <el-button size="small" type="danger" @click="store.keepMine">{{ store.t('keepMine') }}</el-button>
      </div>
    </div>

    <main class="workspace dubbing-workspace">
      <aside class="left-panel panel">
        <section>
          <div class="section-heading"><span>{{ store.t('actors') }}</span><small>{{ actors.length }}</small></div>
          <button class="actor-filter" :class="{ active: store.actorFilter === 'all' }" @click="store.actorFilter = 'all'">
            <span class="actor-dot all" />{{ store.t('allActors') }}
            <b>{{ dubbing?.cues.length ?? 0 }}</b>
          </button>
          <button v-for="actor in actors" :key="actor.id" class="actor-filter" :class="{ active: store.actorFilter === actor.id }" @click="store.actorFilter = actor.id">
            <span class="actor-dot" :style="{ background: actor.color }" />{{ actor.name }}
            <b>{{ (dubbing?.cues ?? []).filter((cue) => cue.actorId === actor.id).length }}</b>
          </button>
        </section>
      </aside>

      <section class="center-panel">
        <div class="project-strip">
          <div>
            <div class="project-meta">
              <span>{{ store.t('dubbingCueCount', { count: dubbing?.cues.length ?? 0 }) }}</span>
              <span>revision {{ dubbing?.revision ?? 0 }}</span>
              <span v-if="dubbing?.lastExportAt">{{ store.t('lastExportAt') }} {{ new Date(dubbing.lastExportAt).toLocaleString() }}</span>
            </div>
          </div>
          <div class="history-actions">
            <span class="save-state" :class="saveState"><i />{{ saveLabel() }}</span>
            <el-button :icon="Download" @click="exportDubbing">{{ store.t('exportDubbing') }}</el-button>
            <el-button type="primary" :icon="UploadFilled" @click="fileInput?.click()">{{ store.t('importDubbing') }}</el-button>
          </div>
        </div>

        <div class="dubbing-note">
          <el-icon><Warning /></el-icon>
          <span>{{ store.t('dubbingMergeNote') }}</span>
        </div>

        <div class="cue-list">
          <article v-for="cue in visibleCues" :key="cue.cueId" class="cue-row dubbing-row" :class="{ orphan: store.isOrphan(cue.cueId) }">
            <div class="cue-main">
              <div class="cue-topline">
                <span class="actor-pill" :style="{ '--actor': store.actorColor(cue.actorId) }">{{ store.actorName(cue.actorId) }}</span>
                <code>{{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</code>
                <el-tag v-if="cue.modified" size="small" type="warning">{{ store.t('dubbingModified') }}</el-tag>
                <el-tag v-if="store.isOrphan(cue.cueId)" size="small" type="danger">{{ store.t('dubbingOrphan') }}</el-tag>
                <el-tag v-if="store.isLockedOrReviewed(cue.cueId)" size="small" type="info">{{ store.t('subtitleLockedOrReviewed') }}</el-tag>
              </div>
              <el-input
                :model-value="cue.dubbingText"
                type="textarea"
                :rows="2"
                class="dubbing-text-input"
                @change="(value: any) => store.updateDubbingCue(cue.cueId, { dubbingText: String(value) })"
              />
              <div class="dubbing-meta">
                <label>{{ store.t('actor') }}</label>
                <el-select :model-value="cue.actorId" size="small" class="dubbing-actor-select" @change="(value: any) => store.updateDubbingCue(cue.cueId, { actorId: String(value) })">
                  <el-option v-for="actor in actors" :key="actor.id" :label="actor.name" :value="actor.id" />
                </el-select>
                <label>{{ store.t('speed') }}</label>
                <el-input-number :model-value="cue.speed" size="small" :min="0.5" :max="1.8" :step="0.01" controls-position="right" @change="(value: any) => store.updateDubbingCue(cue.cueId, { speed: Number(value) })" />
              </div>
            </div>
          </article>
          <div v-if="!visibleCues.length" class="empty-state">{{ store.t('empty') }}</div>
        </div>
      </section>
    </main>

    <input ref="fileInput" class="file-input" type="file" accept=".json,application/json" @change="importFile" />
    <DubbingMergeDialog />
  </div>
</template>
