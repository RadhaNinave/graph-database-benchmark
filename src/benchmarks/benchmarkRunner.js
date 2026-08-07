import { performance } from "perf_hooks";
import { calculateStatistics } from "../utils/statistics.js";

export async function runQueryBenchmark({
  driver,
  name,
  query,
  warmupIterations = 20,
  measuredIterations = 100,
  createParams = () => ({}),
}) {
  console.log(`\nRunning: ${name}`);
  console.log(`Warm-up iterations: ${warmupIterations}`);
  console.log(`Measured iterations: ${measuredIterations}`);

  for (let index = 0; index < warmupIterations; index += 1) {
    await driver.executeQuery(query, createParams());
  }

  const latencies = [];

  for (let index = 0; index < measuredIterations; index += 1) {
    const params = createParams();

    const startTime = performance.now();

    await driver.executeQuery(query, params);

    const durationMs = performance.now() - startTime;

    latencies.push(durationMs);

    if ((index + 1) % 20 === 0) {
      console.log(
        `Completed ${index + 1}/${measuredIterations} iterations`
      );
    }
  }

  return {
    benchmark: name,
    ...calculateStatistics(latencies),
  };
}