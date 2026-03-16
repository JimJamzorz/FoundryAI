<script lang="ts">
  interface Props {
    used: number;
    total: number;
    isEstimate?: boolean;
  }

  let { used, total, isEstimate = true }: Props = $props();

  const percentage = $derived(total > 0 ? Math.min((used / total) * 100, 100) : 0);

  const color = $derived.by(() => {
    if (percentage >= 90) return 'var(--ctx-red, #f87171)';
    if (percentage >= 75) return 'var(--ctx-orange, #fb923c)';
    if (percentage >= 50) return 'var(--ctx-yellow, #fbbf24)';
    return 'var(--ctx-green, #4ade80)';
  });

  const label = $derived.by(() => {
    const prefix = isEstimate ? '~' : '';
    const usedK = used >= 1000 ? `${(used / 1000).toFixed(1)}k` : `${used}`;
    const totalK = total >= 1000 ? `${(total / 1000).toFixed(0)}k` : `${total}`;
    return `Context: ${prefix}${usedK} / ${totalK} tokens (${percentage.toFixed(0)}%)`;
  });

  // SVG circle math
  const size = 22;
  const strokeWidth = 2.5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = $derived(circumference - (percentage / 100) * circumference);
</script>

<div class="context-indicator" title={label}>
  <svg
    width={size}
    height={size}
    viewBox="0 0 {size} {size}"
    class="context-ring"
  >
    <!-- Background track -->
    <circle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      fill="none"
      stroke="rgba(255,255,255,0.1)"
      stroke-width={strokeWidth}
    />
    <!-- Fill arc -->
    <circle
      cx={size / 2}
      cy={size / 2}
      r={radius}
      fill="none"
      stroke={color}
      stroke-width={strokeWidth}
      stroke-dasharray={circumference}
      stroke-dashoffset={dashOffset}
      stroke-linecap="round"
      transform="rotate(-90 {size / 2} {size / 2})"
      class="context-fill"
    />
  </svg>
  <span class="context-pct">{percentage.toFixed(0)}%</span>
</div>

<style>
  .context-indicator {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: default;
    padding: 2px 4px;
    border-radius: 4px;
    transition: background 0.15s;
  }

  .context-indicator:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .context-ring {
    flex-shrink: 0;
  }

  .context-fill {
    transition: stroke-dashoffset 0.4s ease, stroke 0.3s ease;
  }

  .context-pct {
    font-size: 0.68em;
    opacity: 0.6;
    font-variant-numeric: tabular-nums;
    min-width: 2.2em;
    text-align: right;
  }
</style>
