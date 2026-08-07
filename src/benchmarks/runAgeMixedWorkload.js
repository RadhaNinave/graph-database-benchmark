import fs from "fs/promises";
import { performance } from "perf_hooks";
import {
  createAgeClient,
  initialiseAge,
  ensureAgeGraphExists,
  runAgeCypher,
} from "../config/age.js";
import { calculateStatistics } from "../utils/statistics.js";

const CONCURRENCY = 10;
const DURATION_SECONDS = 30;
const READ_RATIO = 0.9;

function randomItem(values) {
  return values[
    Math.floor(Math.random() * values.length)
  ];
}

function parseAgtypeNumber(value) {
  const parsed = Number(
    String(value).replace(/::[\w]+$/, "")
  );

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Unable to convert Apache AGE value to number: ${value}`
    );
  }

  return parsed;
}

async function getUserIds(client) {
  const result = await runAgeCypher(
    client,
    `
      MATCH (u:User)
      RETURN u.id
    `,
    ["id"]
  );

  return result.rows.map((row) =>
    parseAgtypeNumber(row.id)
  );
}

async function performRead(client, userId) {
  await runAgeCypher(
    client,
    `
      MATCH (u:User {id: ${userId}})
      RETURN u.id
    `,
    ["id"]
  );
}

async function performWrite(client, userId) {
  await runAgeCypher(
    client,
    `
      MATCH (u:User {id: ${userId}})
      SET u.benchmarkCounter =
        coalesce(u.benchmarkCounter, 0) + 1
      RETURN u.benchmarkCounter
    `,
    ["counter"]
  );
}

async function runClient({
  clientId,
  userIds,
  endTime,
  metrics,
}) {
  const client = createAgeClient();

  try {
    await client.connect();
    await initialiseAge(client);
    await ensureAgeGraphExists(client);

    while (performance.now() < endTime) {
      const userId = randomItem(userIds);
      const isRead =
        Math.random() < READ_RATIO;

      const startTime = performance.now();

      try {
        if (isRead) {
          await performRead(client, userId);
          metrics.successfulReads += 1;
        } else {
          await performWrite(client, userId);
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
  } finally {
    await client.end();
  }
}

async function cleanupBenchmarkProperty(client) {
  await runAgeCypher(
    client,
    `
      MATCH (u:User)
      REMOVE u.benchmarkCounter
    `
  );
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
    `./results/apache-age-mixed-workload-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runAgeMixedWorkload() {
  const setupClient = createAgeClient();

  const metrics = {
    successfulReads: 0,
    successfulWrites: 0,
    failedOperations: 0,
    latencies: [],
  };

  try {
    await setupClient.connect();
    await initialiseAge(setupClient);
    await ensureAgeGraphExists(setupClient);

    const userIds =
      await getUserIds(setupClient);

    if (userIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the Apache AGE loader first."
      );
    }

    console.log("Connected to Apache AGE.");
    console.log("Starting mixed workload...");
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
      database: "Apache AGE",

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
          "User.id point lookup",

        writeOperation:
          "Increment temporary benchmarkCounter property",

        deployment:
          "Local Docker container",
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
      "\nApache AGE mixed workload results:"
    );

    console.table({
      database: "Apache AGE",

      concurrency: CONCURRENCY,

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

    await saveResults(output);
  } catch (error) {
    console.error(
      "\nApache AGE mixed workload failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await cleanupBenchmarkProperty(
        setupClient
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

    await setupClient.end();
  }
}

runAgeMixedWorkload();