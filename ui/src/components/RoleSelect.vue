<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { Select } from '../design-system';

const items = [
  { label: 'Owner', value: 'owner' },
  { label: 'Contributor', value: 'contributor' },
  { label: 'Signed out', value: 'anon' },
];

const role = ref('owner');

onMounted(() => {
  role.value = document.documentElement.dataset.role ?? 'owner';
  watch(role, (value) => {
    document.documentElement.dataset.role = value;
    try {
      localStorage.setItem('role', value);
    } catch {}
  });
});
</script>

<template>
  <Select v-model="role" label="View as" size="sm" :items="items" />
</template>
