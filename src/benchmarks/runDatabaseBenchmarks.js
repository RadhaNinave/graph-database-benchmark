import fs from "fs/promises";
import { createDatabaseAdapter } from "../config/databases.js";
import { benchmarkQueries } from "./benchmarkQueries.js";
import { runQueryBenchmark } from "./benchmarkRunner.js";

const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 100;

function getDatabaseKey() {
  const databaseKey = process.argv[2];

  if (!databaseKey) {
    throw new Error(
      "Database key is required. Example: node src/benchmarks/runDatabaseBenchmarks.js neo4j"
    );
  }

  return databaseKey.toLowerCase();
}

function randomItem(values) {
  return values[
    Math.floor(Math.random() * values.length)
  ];
}

function toNumber(value) {
  return typeof value?.toNumber ===
    "function"
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

async function getTraversalStartNodeIds(
  executeQuery
) {
  const result = await executeQuery(`
    MATCH (u:User)-[:VOTED_FOR]->()
    WITH
      u,
      count(*) AS outgoingRelationships

    WHERE outgoingRelationships > 0

    RETURN u.id AS id
  `);

  return result.records.map((record) =>
    toNumber(record.get("id"))
  );
}

async function getRelationshipCount(
  executeQuery
) {
  const result = await executeQuery(`
    MATCH ()-[r:VOTED_FOR]->()
    RETURN count(r) AS relationshipCount
  `);

  if (result.records.length === 0) {
    return 0;
  }

  return toNumber(
    result.records[0].get(
      "relationshipCount"
    )
  );
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
    `./results/${config.resultPrefix}-read-benchmark-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runDatabaseBenchmarks() {
  let driver;

  try {
    const databaseKey = getDatabaseKey();

    const adapter =
      createDatabaseAdapter(databaseKey);

    driver = adapter.driver;

    const {
      config,
      executeQuery,
    } = adapter;

    const benchmarkAdapter = {
      executeQuery,
    };

    await driver.verifyConnectivity();

    console.log(
      `Connected to ${config.name}.`
    );
    console.log(
      "Loading benchmark start-node IDs..."
    );

    const allUserIds =
      await getUserIds(executeQuery);

    const traversalUserIds =
      await getTraversalStartNodeIds(
        executeQuery
      );

    const relationshipCount =
      await getRelationshipCount(
        executeQuery
      );

    if (allUserIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the loader first."
      );
    }

    if (
      traversalUserIds.length === 0
    ) {
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
        driver: benchmarkAdapter,
        name:
          benchmarkQueries.pointLookup
            .name,
        query:
          benchmarkQueries.pointLookup
            .query,
        warmupIterations:
          WARMUP_ITERATIONS,
        measuredIterations:
          MEASURED_ITERATIONS,
        createParams: () => ({
          userId:
            randomItem(allUserIds),
        }),
      })
    );

    results.push(
      await runQueryBenchmark({
        driver: benchmarkAdapter,
        name:
          benchmarkQueries.filteredLookup
            .name,
        query:
          benchmarkQueries.filteredLookup
            .query,
        warmupIterations:
          WARMUP_ITERATIONS,
        measuredIterations:
          MEASURED_ITERATIONS,
        createParams: () => {
          const minimumId =
            randomItem(allUserIds);

          return {
            minimumId,
            maximumId:
              minimumId + 100,
          };
        },
      })
    );

    for (const key of [
      "oneHop",
      "twoHop",
      "threeHop",
    ]) {
      const benchmark =
        benchmarkQueries[key];

      results.push(
        await runQueryBenchmark({
          driver: benchmarkAdapter,
          name: benchmark.name,
          query: benchmark.query,
          warmupIterations:
            WARMUP_ITERATIONS,
          measuredIterations:
            MEASURED_ITERATIONS,
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
        driver: benchmarkAdapter,
        name:
          benchmarkQueries.aggregation
            .name,
        query:
          benchmarkQueries.aggregation
            .query,
        warmupIterations:
          WARMUP_ITERATIONS,
        measuredIterations:
          MEASURED_ITERATIONS,
      })
    );

    const output = {
      database: config.name,

      dataset: {
        name: "SNAP Wiki-Vote",
        nodes: allUserIds.length,
        relationships:
          relationshipCount,
        relationshipType:
          "VOTED_FOR",
      },

      methodology: {
        warmupIterations:
          WARMUP_ITERATIONS,
        measuredIterations:
          MEASURED_ITERATIONS,
        timingLocation:
          "Node.js client",
        startNodes:
          "Randomly selected per iteration",
        index: "User.id",
        database:
          config.database ||
          "default",
      },

      generatedAt:
        new Date().toISOString(),

      results,
    };

    console.log(
      `\n${config.name} benchmark results:`
    );

    console.table(
      results.map((result) => ({
        benchmark:
          result.benchmark,
        p50Ms: result.p50Ms,
        p95Ms: result.p95Ms,
        averageMs:
          result.averageMs,
        minMs: result.minMs,
        maxMs: result.maxMs,
      }))
    );

    await saveResults({
      config,
      output,
    });
  } catch (error) {
    console.error(
      "\nBenchmark failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

runDatabaseBenchmarks();