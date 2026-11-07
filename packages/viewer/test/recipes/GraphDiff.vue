<script setup lang="ts">
import '@kgdiff/viewer';
import type { GraphSource, KgdiffViewerElement, ViewerPanels } from '@kgdiff/viewer';
import { onMounted, ref } from 'vue';

const props = defineProps<{ before: GraphSource; after: GraphSource }>();
const emit = defineEmits<{ select: [hunk: string | null] }>();
const viewer = ref<KgdiffViewerElement | null>(null);
const panels: ViewerPanels = { detail: 'collapsed' };

onMounted(() => viewer.value?.load({ before: props.before, after: props.after }));
const onSelect = (event: CustomEvent<{ hunk: string | null }>) => emit('select', event.detail.hunk);
</script>

<template>
  <kgdiff-viewer
    ref="viewer"
    theme="auto"
    :panels.prop="panels"
    :keymap.prop="{ x: null, r: 'review' }"
    style="height: 640px"
    @kgdiff-select="onSelect"
  />
</template>
