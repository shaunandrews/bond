<template>
  <div
    class="self-center px-3.5 py-2.5 rounded-[10px] text-xs text-muted border border-dashed border-border"
    role="status"
    aria-live="polite"
  >
    Bond is working<span class="thinking-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>
  </div>
</template>

<style scoped>
.thinking-dots span {
  animation: blink 1.4s infinite both;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; }
  40% { opacity: 1; }
}
</style>
