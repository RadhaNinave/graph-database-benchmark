import fs from "fs/promises";
import { performance } from "perf_hooks";
import dotenv from "dotenv";
import { FalkorDB } from "falkordb";
import { calculateStatistics } from "../utils/statistics.js";

dotenv.config();

const GRAPH_NAME =
  process.env.FALKORDB_GRAPH || "wiki_vote";

const CONCURRENCY = 10;
const DURATION_SECONDS = 30;
const READ_RATIO = 0.9;

function validateEnvironment() {
  const requiredVariables = [
    "FALKORDB_HOST",
    "FALKORDB_PORT",
    "FALKORDB_USERNAME",
    "FALKORDB_PASSWORD",
  ];

  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName]
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing FalkorDB environment variables: ${missingVariables.join(", ")}`
    );
  }
}

async function connectToFalkorDB() {
  validateEnvironment();

  const port = Number(process.env.FALKORDB_PORT);

  if (!Number.isInteger(port)) {
    throw new Error(
      "FALKORDB_PORT must be a valid integer."
    );
  }

  return FalkorDB.connect({
    username: process.env.FALKORDB_USERNAME,
    password: process.env.FALKORDB_PASSWORD,
    socket: {
      host: process.env.FALKORDB_HOST,
      port,
      tls: process.env.FALKORDB_TLS === "true",
      connectTimeout: 15000,
    },
  });
}

function randomItem(values) {
  return values[
    Math.floor(Math.random() * values.length)
  ];
}

function extractColumnValues(result, propertyName) {
  if (!result || !Array.isArray(result.data)) {
    throw new Error(
      `Invalid FalkorDB result for "${propertyName}".`
    );
  }

  return result.data
    .map((row) => Number(row[propertyName]))
    .filter((value) => Number.isFinite(value));
}

async function getUserIds(graph) {
  const result = await graph.query(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return extractColumnValues(result, "id");
}

async function performRead(graph, userId) {
  await graph.query(
    `
    MATCH (u:User {id: $userId})
    RETURN u.id AS id
    `,
    {
      params: {
        userId,
      },
    }
  );
}

async function performWrite(graph, userId) {
  await graph.query(
    `
    MATCH (u:User {id: $userId})
    SET u.benchmarkCounter =
      coalesce(u.benchmarkCounter, 0) + 1
    RETURN u.benchmarkCounter AS counter
    `,
    {
      params: {
        userId,
      },
    }
  );
}

async function runClient({
  clientId,
  graph,
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
        await performRead(graph, userId);
        metrics.successfulReads += 1;
      } else {
        await performWrite(graph, userId);
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

async function cleanupBenchmarkProperty(graph) {
  await graph.query(`
    MATCH (u:User)
    REMOVE u.benchmarkCounter
  `);
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
    `./results/falkordb-mixed-workload-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runFalkorDBMixedWorkload() {
  let client;
  let graph;

  const metrics = {
    successfulReads: 0,
    successfulWrites: 0,
    failedOperations: 0,
    latencies: [],
  };

  try {
    client = await connectToFalkorDB();

    graph = client.selectGraph(GRAPH_NAME);

    const userIds = await getUserIds(graph);

    if (userIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the FalkorDB loader first."
      );
    }

    console.log("Connected to FalkorDB.");
    console.log(`Graph name: ${GRAPH_NAME}`);
    console.log("Starting mixed workload...");
    console.log(`Concurrency: ${CONCURRENCY}`);
    console.log(`Duration: ${DURATION_SECONDS} seconds`);
    console.log(
      "Read/write mix: 90% reads / 10% writes"
    );

    const startTime = performance.now();

    const endTime =
      startTime + DURATION_SECONDS * 1000;

    const clients = Array.from(
      {
        length: CONCURRENCY,
      },
      (_, index) =>
        runClient({
          clientId: index + 1,
          graph,
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
      database: "FalkorDB",

      graph: GRAPH_NAME,

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
      "\nFalkorDB mixed workload results:"
    );

    console.table({
      database: "FalkorDB",

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
      "\nFalkorDB mixed workload failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (graph) {
      try {
        await cleanupBenchmarkProperty(graph);

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

    if (client) {
      await client.close();
    }
  }
}

runFalkorDBMixedWorkload();