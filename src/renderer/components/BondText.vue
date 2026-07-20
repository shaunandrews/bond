<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  as?: string
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl' | '3xl'
  weight?: 'normal' | 'medium' | 'semibold' | 'bold'
  color?: 'primary' | 'muted' | 'accent' | 'err' | 'ok' | 'inherit'
  align?: 'left' | 'center' | 'right'
  truncate?: boolean
  mono?: boolean
}>()

const tag = computed(() => props.as ?? 'span')

const classes = computed(() => {
  const c: string[] = []

  // Size
  const sizeMap: Record<string, string> = {
    xs: 'text-xs',
    sm: 'text-sm',
    base: 'text-base',
    lg: 'text-lg',
    xl: 'text-xl',
    '2xl': 'text-2xl',
    '3xl': 'text-3xl'
  }
  c.push(sizeMap[props.size ?? 'base'])

  // Weight
  const weightMap: Record<string, string> = {
    normal: 'font-normal',
    medium: 'font-medium',
    semibold: 'font-semibold',
    bold: 'font-bold'
  }
  c.push(weightMap[props.weight ?? 'normal'])

  // Color
  const colorMap: Record<string, string> = {
    primary: 'text-text-primary',
    muted: 'text-muted',
    accent: 'text-accent',
    err: 'text-err',
    ok: 'text-ok',
    inherit: 'text-inherit'
  }
  c.push(colorMap[props.color ?? 'inherit'])

  // Align
  if (props.align) {
    const alignMap: Record<string, string> = {
      left: 'text-left',
      center: 'text-center',
      right: 'text-right'
    }
    c.push(alignMap[props.align])
  }

  // Truncate. `block` comes along because text-overflow needs a block box —
  // the default `span` is inline, where overflow/ellipsis simply do nothing.
  if (props.truncate) c.push('truncate', 'block')

  // Mono
  if (props.mono) c.push('font-mono')

  return c
})
</script>

<template>
  <!--
    `text-wrap: pretty` is applied ONLY when not truncating. As an inline style
    it outranks the .truncate class, and because `text-wrap` and `white-space`
    share the text-wrap-mode longhand it silently reset nowrap back to wrap —
    which made the truncate prop a no-op everywhere it was used.
  -->
  <component :is="tag" :class="classes" :style="truncate ? undefined : 'text-wrap: pretty;'">
    <slot />
  </component>
</template>
