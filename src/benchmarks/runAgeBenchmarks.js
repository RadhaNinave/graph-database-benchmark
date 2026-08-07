import fs from "fs/promises";
import { performance } from "perf_hooks";
import {
  createAgeClient,
  initialiseAge,
  ensureAgeGraphExists,
  runAgeCypher,
} from "../config/age.js";
import { ageBenchmarkQueries } from "./benchmarkAgeQueries.js";
import { calculateStatistics } from "../utils/statistics.js";

const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 100;

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function replaceCypherParams(query, params = {}) {
  let finalQuery = query;

  for (const [key, value] of Object.entries(params)) {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Apache AGE benchmark parameter "${key}" must be numeric.`
      );
    }

    finalQuery = finalQuery.replaceAll(`$${key}`, String(value));
  }

  return finalQuery;
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

async function getTraversalStartNodeIds(client) {
  const result = await runAgeCypher(
    client,
    `
      MATCH (u:User)-[:VOTED_FOR]->()
      WITH u, count(*) AS outgoing_relationships
      WHERE outgoing_relationships > 0
      RETURN u.id
    `,
    ["id"]
  );

  return result.rows.map((row) =>
    parseAgtypeNumber(row.id)
  );
}

async function getRelationshipCount(client) {
  const result = await runAgeCypher(
    client,
    `
      MATCH ()-[r:VOTED_FOR]->()
      RETURN count(r)
    `,
    ["relationship_count"]
  );

  return parseAgtypeNumber(
    result.rows[0].relationship_count
  );
}

async function runQueryBenchmark({
  client,
  benchmark,
  createParams = () => ({}),
}) {
  console.log(`\nRunning: ${benchmark.name}`);
  console.log(
    `Warm-up iterations: ${WARMUP_ITERATIONS}`
  );
  console.log(
    `Measured iterations: ${MEASURED_ITERATIONS}`
  );

  for (
    let index = 0;
    index < WARMUP_ITERATIONS;
    index += 1
  ) {
    const params = createParams();

    const query = replaceCypherParams(
      benchmark.query,
      params
    );

    await runAgeCypher(
      client,
      query,
      benchmark.columns
    );
  }

  const latencies = [];

  for (
    let index = 0;
    index < MEASURED_ITERATIONS;
    index += 1
  ) {
    const params = createParams();

    const query = replaceCypherParams(
      benchmark.query,
      params
    );

    const startTime = performance.now();

    await runAgeCypher(
      client,
      query,
      benchmark.columns
    );

    const durationMs =
      performance.now() - startTime;

    latencies.push(durationMs);

    if ((index + 1) % 20 === 0) {
      console.log(
        `Completed ${index + 1}/${MEASURED_ITERATIONS} iterations`
      );
    }
  }

  return {
    benchmark: benchmark.name,
    ...calculateStatistics(latencies),
  };
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
    `./results/apache-age-read-benchmark-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runAgeBenchmarks() {
  const client = createAgeClient();

  try {
    await client.connect();
    await initialiseAge(client);
    await ensureAgeGraphExists(client);

    console.log("Connected to Apache AGE.");
    console.log(
      "Loading benchmark start-node IDs..."
    );

    const allUserIds =
      await getUserIds(client);

    const traversalUserIds =
      await getTraversalStartNodeIds(client);

    const relationshipCount =
      await getRelationshipCount(client);

    if (allUserIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the Apache AGE loader first."
      );
    }

    if (traversalUserIds.length === 0) {
      throw new Error(
        "No users with outgoing VOTED_FOR relationships found."
      );
    }

    console.log(
      `All user IDs: ${allUserIds.length}`
    );
    console.log(
      `Traversal start IDs: ${traversalUserIds.length}`
    );
    console.log(
      `Relationships: ${relationshipCount}`
    );

    const results = [];

    results.push(
      await runQueryBenchmark({
        client,
        benchmark:
          ageBenchmarkQueries.pointLookup,
        createParams: () => ({
          userId: randomItem(allUserIds),
        }),
      })
    );

    results.push(
      await runQueryBenchmark({
        client,
        benchmark:
          ageBenchmarkQueries.filteredLookup,
        createParams: () => {
          const minimumId =
            randomItem(allUserIds);

          return {
            minimumId,
            maximumId: minimumId + 100,
          };
        },
      })
    );

    for (const key of [
      "oneHop",
      "twoHop",
      "threeHop",
    ]) {
      results.push(
        await runQueryBenchmark({
          client,
          benchmark:
            ageBenchmarkQueries[key],
          createParams: () => ({
            userId: randomItem(
              traversalUserIds
            ),
          }),
        })
      );
    }

    results.push(
      await runQueryBenchmark({
        client,
        benchmark:
          ageBenchmarkQueries.aggregation,
      })
    );

    const output = {
      database: "Apache AGE",

      dataset: {
        name: "SNAP Wiki-Vote",
        nodes: allUserIds.length,
        relationships: relationshipCount,
        relationshipType: "VOTED_FOR",
      },

      methodology: {
        warmupIterations:
          WARMUP_ITERATIONS,
        measuredIterations:
          MEASURED_ITERATIONS,
        timingLocation:
          "Node.js client",
        startNodes:
          "Randomly selected per measured iteration",
        index:
          "User.id property lookup",
        deployment:
          "Local Docker container",
      },

      generatedAt:
        new Date().toISOString(),

      results,
    };

    console.log(
      "\nApache AGE benchmark results:"
    );

    console.table(
      results.map((result) => ({
        benchmark: result.benchmark,
        p50Ms: result.p50Ms,
        p95Ms: result.p95Ms,
        averageMs: result.averageMs,
        minMs: result.minMs,
        maxMs: result.maxMs,
      }))
    );

    await saveResults(output);
  } catch (error) {
    console.error(
      "\nApache AGE benchmark failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

runAgeBenchmarks();