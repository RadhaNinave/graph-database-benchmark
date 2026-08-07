function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.ceil(
    (percentileValue / 100) * sortedValues.length
  ) - 1;

  return sortedValues[Math.max(0, index)];
}

export function calculateStatistics(latencies) {
  if (!Array.isArray(latencies) || latencies.length === 0) {
    throw new Error("Latency array cannot be empty.");
  }

  const sorted = [...latencies].sort((a, b) => a - b);

  const total = sorted.reduce((sum, value) => sum + value, 0);

  return {
    iterations: sorted.length,
    averageMs: Number((total / sorted.length).toFixed(3)),
    p50Ms: Number(percentile(sorted, 50).toFixed(3)),
    p95Ms: Number(percentile(sorted, 95).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
  };
}