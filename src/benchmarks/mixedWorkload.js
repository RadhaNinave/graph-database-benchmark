import fs from "fs/promises";
import { performance } from "perf_hooks";
import driver from "../config/cognodb.js";
import { calculateStatistics } from "../utils/statistics.js";

const CONCURRENCY = 10;
const DURATION_SECONDS = 30;
const READ_RATIO = 0.9;

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function toNumber(value) {
  return typeof value?.toNumber === "function"
    ? value.toNumber()
    : Number(value);
}

async function getUserIds() {
  const result = await driver.executeQuery(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return result.records.map((record) =>
    toNumber(record.get("id"))
  );
}

async function performRead(userId) {
  await driver.executeQuery(
    `
    MATCH (u:User {id: $userId})
    RETURN u.id AS id
    `,
    { userId }
  );
}

async function performWrite(userId) {
  await driver.executeQuery(
    `
    MATCH (u:User {id: $userId})
    SET u.benchmarkCounter =
      coalesce(u.benchmarkCounter, 0) + 1
    RETURN u.benchmarkCounter AS counter
    `,
    { userId }
  );
}

async function runClient({
  clientId,
  userIds,
  endTime,
  metrics,
}) {
  while (performance.now() < endTime) {
    const userId = randomItem(userIds);
    const isRead = Math.random() < READ_RATIO;

    const start = performance.now();

    try {
      if (isRead) {
        await performRead(userId);
        metrics.successfulReads += 1;
      } else {
        await performWrite(userId);
        metrics.successfulWrites += 1;
      }

      metrics.latencies.push(performance.now() - start);
    } catch (error) {
      metrics.failedOperations += 1;

      console.error(
        `Client ${clientId} operation failed:`,
        error.message
      );
    }
  }
}

async function saveResults(output) {
  await fs.mkdir("./results", {
    recursive: true,
  });

  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputPath =
    `./results/cognodb-mixed-workload-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(`Results saved to ${outputPath}`);
}

async function cleanupBenchmarkProperty() {
  await driver.executeQuery(`
    MATCH (u:User)
    REMOVE u.benchmarkCounter
  `);
}

async function runMixedWorkload() {
  const metrics = {
    successfulReads: 0,
    successfulWrites: 0,
    failedOperations: 0,
    latencies: [],
  };

  try {
    await driver.verifyConnectivity();

    const userIds = await getUserIds();

    if (userIds.length === 0) {
      throw new Error("No User nodes found.");
    }

    console.log("Starting mixed workload...");
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Duration: ${DURATION_SECONDS} seconds`);
    console.log("Read/write mix: 90% reads / 10% writes");

    const startTime = performance.now();
    const endTime =
      startTime + DURATION_SECONDS * 1000;

    const clients = Array.from(
      { length: CONCURRENCY },
      (_, index) =>
        runClient({
          clientId: index + 1,
          userIds,
          endTime,
          metrics,
        })
    );

    await Promise.all(clients);

    const actualDurationSeconds =
      (performance.now() - startTime) / 1000;

    const successfulOperations =
      metrics.successfulReads +
      metrics.successfulWrites;

    const totalOperations =
      successfulOperations +
      metrics.failedOperations;

    const latencyStats =
      metrics.latencies.length > 0
        ? calculateStatistics(metrics.latencies)
        : {
            averageMs: 0,
            p50Ms: 0,
            p95Ms: 0,
            minMs: 0,
            maxMs: 0,
          };

    const output = {
      database: "CognoDB",
      workload: "Mixed read/write",
      configuration: {
        concurrency: CONCURRENCY,
        requestedDurationSeconds: DURATION_SECONDS,
        actualDurationSeconds: Number(
          actualDurationSeconds.toFixed(2)
        ),
        readRatio: READ_RATIO,
        writeRatio: 1 - READ_RATIO,
      },
      results: {
        totalOperations,
        successfulOperations,
        successfulReads: metrics.successfulReads,
        successfulWrites: metrics.successfulWrites,
        failedOperations: metrics.failedOperations,
        queriesPerSecond: Number(
          (
            successfulOperations /
            actualDurationSeconds
          ).toFixed(2)
        ),
        ...latencyStats,
      },
      generatedAt: new Date().toISOString(),
    };

    console.log("\nMixed workload results:");

    console.table({
      concurrency: CONCURRENCY,
      durationSeconds: Number(
        actualDurationSeconds.toFixed(2)
      ),
      totalOperations,
      successfulReads: metrics.successfulReads,
      successfulWrites: metrics.successfulWrites,
      failedOperations: metrics.failedOperations,
      queriesPerSecond:
        output.results.queriesPerSecond,
      p50Ms: latencyStats.p50Ms,
      p95Ms: latencyStats.p95Ms,
      averageMs: latencyStats.averageMs,
    });

    await saveResults(output);
  } catch (error) {
    console.error("Mixed workload failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await cleanupBenchmarkProperty();
    } catch (cleanupError) {
      console.error(
        "Cleanup failed:",
        cleanupError.message
      );
    }

    await driver.close();
  }
}

runMixedWorkload();