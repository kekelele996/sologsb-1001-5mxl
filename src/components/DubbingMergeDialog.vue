<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { ElMessage } from 'element-plus'
import { Check, Close, RefreshRight, Warning } from '@element-plus/icons-vue'
import { useDubbingStore } from '../stores/dubbing'
import { formatTime } from '../utils/subtitle'

const store = useDubbingStore()
const { mergeOpen, results, committing, pendingImport, changedCount, unchangedCount, failureCount } = storeToRefs(store)

const statusLabel = (status: string) => store.t(`reconcile_${status}` as any)
const reasonLabel = (reason: string) => store.t(`reconcileReason_${reason}` as any)
const matchedByLabel = (matchedBy: string | null) => (matchedBy ? store.t(`matchedBy_${matchedBy}` as any) : '—')
const fieldLabel = (field: string) => store.t(`field_${field}` as any)

async function retry() {
  await store.retryReconcile()
}
async function apply() {
  await store.applyMerge()
  if (store.mergeError) {
    ElMessage.error(store.t(store.mergeError === 'reconcile-failed' ? 'reconcileFailed' : 'commitFailed'))
  } else {
    ElMessage.success(store.t('mergeSuccess', { count: changedCount.value }))
  }
}
</script>

<template>
  <el-dialog
    :model-value="mergeOpen"
    :title="store.t('mergeTitle')"
    width="760px"
    :close-on-click-modal="false"
    @update:model-value="(value: boolean) => { if (!value) store.closeMerge() }"
  >
    <div v-if="pendingImport" class="merge-summary">
      <span>{{ store.t('mergeFile', { name: pendingImport.filename }) }}</span>
      <span>{{ store.t('mergeTotal', { count: results.length }) }}</span>
      <span class="ok">{{ store.t('mergeWillWrite', { count: changedCount }) }}</span>
      <span class="skip">{{ store.t('mergeSkipUnchanged', { count: unchangedCount }) }}</span>
      <span v-if="failureCount" class="fail">{{ store.t('mergeFailures', { count: failureCount }) }}</span>
    </div>

    <div v-if="failureCount" class="merge-fail-banner">
      <el-icon><Warning /></el-icon>
      <div>
        <strong>{{ store.t('reconcileFailedTitle') }}</strong>
        <span>{{ store.t('reconcileFailedBody') }}</span>
      </div>
      <el-button size="small" :icon="RefreshRight" :loading="committing" @click="retry">{{ store.t('retryReconcile') }}</el-button>
    </div>

    <div v-if="store.mergeError && !failureCount" class="merge-fail-banner">
      <el-icon><Warning /></el-icon>
      <span>{{ store.t('commitFailed') }}</span>
    </div>

    <div class="merge-lines">
      <div v-for="result in results" :key="result.importedCueId" class="merge-line" :class="result.status">
        <div class="merge-line-status">
          <el-icon v-if="result.status === 'changed'" class="ok"><Check /></el-icon>
          <el-icon v-else-if="result.status === 'unchanged'" class="skip"><Check /></el-icon>
          <el-icon v-else class="fail"><Close /></el-icon>
        </div>
        <div class="merge-line-body">
          <div class="merge-line-head">
            <code>{{ result.importedCueId }}</code>
            <el-tag v-if="result.matchedBy" size="small" type="info">{{ matchedByLabel(result.matchedBy) }}</el-tag>
            <el-tag v-if="result.status === 'changed'" size="small" type="success">{{ statusLabel(result.status) }}</el-tag>
            <el-tag v-else-if="result.status === 'unchanged'" size="small" type="info">{{ statusLabel(result.status) }}</el-tag>
            <el-tag v-else size="small" type="danger">{{ statusLabel(result.status) }}</el-tag>
          </div>
          <div class="merge-line-detail">
            <span v-if="result.subtitleStart !== null">{{ formatTime(result.subtitleStart) }} → {{ formatTime(result.subtitleEnd ?? 0) }}</span>
            <span v-if="result.drift > 0.01" class="drift">{{ store.t('driftSeconds', { drift: result.drift.toFixed(2) }) }}</span>
            <span v-if="result.changedFields.length" class="changed-fields">
              <el-tag v-for="field in result.changedFields" :key="field" size="small" type="warning">{{ fieldLabel(field) }}</el-tag>
            </span>
            <span v-if="result.status === 'missing' || result.status === 'drifted'" class="fail reason">{{ reasonLabel(result.reason) }}</span>
          </div>
          <p class="merge-line-text">{{ result.dubbingText }}</p>
        </div>
      </div>
      <div v-if="!results.length" class="empty-state">{{ store.t('empty') }}</div>
    </div>

    <template #footer>
      <el-button @click="store.closeMerge()">{{ store.t('cancel') }}</el-button>
      <el-button type="primary" :loading="committing" :disabled="!results.length || !!failureCount || !changedCount" @click="apply">
        {{ store.t('applyMerge', { count: changedCount }) }}
      </el-button>
    </template>
  </el-dialog>
</template>
