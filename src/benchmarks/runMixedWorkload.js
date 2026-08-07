import fs from "fs/promises";
import { performance } from "perf_hooks";
import { createDatabaseAdapter } from "../config/databases.js";
import { calculateStatistics } from "../utils/statistics.js";

const CONCURRENCY = 10;
const DURATION_SECONDS = 30;
const READ_RATIO = 0.9;

function getDatabaseKey() {
  const databaseKey = process.argv[2];

  if (!databaseKey) {
    throw new Error(
      "Database key is required. Example: node src/benchmarks/runMixedWorkload.js neo4j"
    );
  }

  return databaseKey.toLowerCase();
}

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function toNumber(value) {
  return typeof value?.toNumber === "function"
    ? value.toNumber()
    : Number(value);
}

async function getUserIds(executeQuery) {
  const result = await executeQuery(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return result.records.map((record) =>
    toNumber(record.get("id"))
  );
}

async function performRead(executeQuery, userId) {
  await executeQuery(
    `
    MATCH (u:User {id: $userId})
    RETURN u.id AS id
    `,
    {
      userId,
    }
  );
}

async function performWrite(executeQuery, userId) {
  await executeQuery(
    `
    MATCH (u:User {id: $userId})
    SET u.benchmarkCounter =
      coalesce(u.benchmarkCounter, 0) + 1
    RETURN u.benchmarkCounter AS counter
    `,
    {
      userId,
    }
  );
}

async function runClient({
  clientId,
  executeQuery,
  userIds,
  endTime,
  metrics,
}) {
  while (performance.now() < endTime) {
    const userId = randomItem(userIds);
    const isRead = Math.random() < READ_RATIO;
    const startTime = performance.now();

    try {
      if (isRead) {
        await performRead(executeQuery, userId);
        metrics.successfulReads += 1;
      } else {
        await performWrite(executeQuery, userId);
        metrics.successfulWrites += 1;
      }

      metrics.latencies.push(
        performance.now() - startTime
      );
    } catch (error) {
      metrics.failedOperations += 1;

      console.error(
        `Client ${clientId} operation failed:`,
        error.message
      );
    }
  }
}

async function cleanupBenchmarkProperty(executeQuery) {
  await executeQuery(`
    MATCH (u:User)
    REMOVE u.benchmarkCounter
  `);
}

async function saveResults({
  config,
  output,
}) {
  await fs.mkdir("./results", {
    recursive: true,
  });

  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputPath =
    `./results/${config.resultPrefix}-mixed-workload-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runMixedWorkload() {
  let driver;
  let executeQuery;
  let config;

  const metrics = {
    successfulReads: 0,
    successfulWrites: 0,
    failedOperations: 0,
    latencies: [],
  };

  try {
    const databaseKey = getDatabaseKey();

    const adapter =
      createDatabaseAdapter(databaseKey);

    driver = adapter.driver;
    executeQuery = adapter.executeQuery;
    config = adapter.config;

    await driver.verifyConnectivity();

    const userIds =
      await getUserIds(executeQuery);

    if (userIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the dataset loader first."
      );
    }

    console.log(
      `Connected to ${config.name}.`
    );
    console.log(
      "Starting mixed workload..."
    );
    console.log(
      `Concurrency: ${CONCURRENCY}`
    );
    console.log(
      `Duration: ${DURATION_SECONDS} seconds`
    );
    console.log(
      "Read/write mix: 90% reads / 10% writes"
    );

    const startTime = performance.now();

    const endTime =
      startTime +
      DURATION_SECONDS * 1000;

    const clients = Array.from(
      {
        length: CONCURRENCY,
      },
      (_, index) =>
        runClient({
          clientId: index + 1,
          executeQuery,
          userIds,
          endTime,
          metrics,
        })
    );

    await Promise.all(clients);

    const actualDurationSeconds =
      (performance.now() - startTime) /
      1000;

    const successfulOperations =
      metrics.successfulReads +
      metrics.successfulWrites;

    const totalOperations =
      successfulOperations +
      metrics.failedOperations;

    const latencyStats =
      metrics.latencies.length > 0
        ? calculateStatistics(
            metrics.latencies
          )
        : {
            iterations: 0,
            averageMs: 0,
            p50Ms: 0,
            p95Ms: 0,
            minMs: 0,
            maxMs: 0,
          };

    const queriesPerSecond =
      actualDurationSeconds > 0
        ? successfulOperations /
          actualDurationSeconds
        : 0;

    const output = {
      database: config.name,

      workload: "Mixed read/write",

      dataset: {
        name: "SNAP Wiki-Vote",
        userCount: userIds.length,
        relationshipType: "VOTED_FOR",
      },

      configuration: {
        concurrency: CONCURRENCY,

        requestedDurationSeconds:
          DURATION_SECONDS,

        actualDurationSeconds: Number(
          actualDurationSeconds.toFixed(2)
        ),

        readRatio: READ_RATIO,

        writeRatio: Number(
          (1 - READ_RATIO).toFixed(2)
        ),

        readOperation:
          "Indexed User.id point lookup",

        writeOperation:
          "Increment temporary benchmarkCounter property",
      },

      results: {
        totalOperations,

        successfulOperations,

        successfulReads:
          metrics.successfulReads,

        successfulWrites:
          metrics.successfulWrites,

        failedOperations:
          metrics.failedOperations,

        queriesPerSecond: Number(
          queriesPerSecond.toFixed(2)
        ),

        ...latencyStats,
      },

      generatedAt:
        new Date().toISOString(),
    };

    console.log(
      `\n${config.name} mixed workload results:`
    );

    console.table({
      database: config.name,

      concurrency:
        CONCURRENCY,

      durationSeconds: Number(
        actualDurationSeconds.toFixed(2)
      ),

      totalOperations,

      successfulReads:
        metrics.successfulReads,

      successfulWrites:
        metrics.successfulWrites,

      failedOperations:
        metrics.failedOperations,

      queriesPerSecond:
        output.results.queriesPerSecond,

      p50Ms:
        latencyStats.p50Ms,

      p95Ms:
        latencyStats.p95Ms,

      averageMs:
        latencyStats.averageMs,

      minMs:
        latencyStats.minMs,

      maxMs:
        latencyStats.maxMs,
    });

    await saveResults({
      config,
      output,
    });
  } catch (error) {
    console.error(
      "\nMixed workload failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (executeQuery) {
      try {
        await cleanupBenchmarkProperty(
          executeQuery
        );

        console.log(
          "Temporary benchmark properties removed."
        );
      } catch (cleanupError) {
        console.error(
          "Cleanup failed:",
          cleanupError.message
        );
      }
    }

    if (driver) {
      await driver.close();
    }
  }
}

runMixedWorkload();