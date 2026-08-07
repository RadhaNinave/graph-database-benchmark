import fs from "fs/promises";
import driver from "../config/neo4j.js";
import { benchmarkQueries } from "./benchmarkQueries.js";
import { runQueryBenchmark } from "./benchmarkRunner.js";

const DATABASE = process.env.NEO4J_DATABASE || "neo4j";
const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 100;

function executeQuery(query, params = {}) {
  return driver.executeQuery(query, params, {
    database: DATABASE,
  });
}

const neo4jAdapter = {
  executeQuery,
};

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function toNumber(value) {
  return typeof value?.toNumber === "function"
    ? value.toNumber()
    : Number(value);
}

async function getUserIds() {
  const result = await executeQuery(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return result.records.map((record) =>
    toNumber(record.get("id"))
  );
}

async function getTraversalStartNodeIds() {
  const result = await executeQuery(`
    MATCH (u:User)-[:VOTED_FOR]->()
    WITH u, count(*) AS outgoingRelationships
    WHERE outgoingRelationships > 0
    RETURN u.id AS id
  `);

  return result.records.map((record) =>
    toNumber(record.get("id"))
  );
}

async function getRelationshipCount() {
  const result = await executeQuery(`
    MATCH ()-[r:VOTED_FOR]->()
    RETURN count(r) AS relationshipCount
  `);

  if (result.records.length === 0) {
    return 0;
  }

  return toNumber(
    result.records[0].get("relationshipCount")
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
    `./results/neo4j-read-benchmark-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(`\nResults saved to ${outputPath}`);
}

async function runNeo4jBenchmarks() {
  try {
    await driver.verifyConnectivity({
      database: DATABASE,
    });

    console.log("Connected to Neo4j Aura.");
    console.log("Loading benchmark start-node IDs...");

    const allUserIds = await getUserIds();
    const traversalUserIds =
      await getTraversalStartNodeIds();
    const relationshipCount =
      await getRelationshipCount();

    if (allUserIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the Neo4j loader first."
      );
    }

    if (traversalUserIds.length === 0) {
      throw new Error(
        "No users with outgoing VOTED_FOR relationships found."
      );
    }

    console.log(`All user IDs: ${allUserIds.length}`);
    console.log(
      `Traversal start IDs: ${traversalUserIds.length}`
    );
    console.log(
      `Relationships: ${relationshipCount}`
    );

    const results = [];

    results.push(
      await runQueryBenchmark({
        driver: neo4jAdapter,
        name: benchmarkQueries.pointLookup.name,
        query: benchmarkQueries.pointLookup.query,
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        createParams: () => ({
          userId: randomItem(allUserIds),
        }),
      })
    );

    results.push(
      await runQueryBenchmark({
        driver: neo4jAdapter,
        name: benchmarkQueries.filteredLookup.name,
        query: benchmarkQueries.filteredLookup.query,
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        createParams: () => {
          const minimumId = randomItem(allUserIds);

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
      const benchmark = benchmarkQueries[key];

      results.push(
        await runQueryBenchmark({
          driver: neo4jAdapter,
          name: benchmark.name,
          query: benchmark.query,
          warmupIterations: WARMUP_ITERATIONS,
          measuredIterations: MEASURED_ITERATIONS,
          createParams: () => ({
            userId: randomItem(traversalUserIds),
          }),
        })
      );
    }

    results.push(
      await runQueryBenchmark({
        driver: neo4jAdapter,
        name: benchmarkQueries.aggregation.name,
        query: benchmarkQueries.aggregation.query,
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
      })
    );

    const output = {
      database: "Neo4j Aura",
      dataset: {
        name: "SNAP Wiki-Vote",
        nodes: allUserIds.length,
        relationships: relationshipCount,
        relationshipType: "VOTED_FOR",
      },
      methodology: {
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        timingLocation: "Node.js client",
        startNodes:
          "Randomly selected per measured iteration",
        index: "User.id",
        database: DATABASE,
      },
      generatedAt: new Date().toISOString(),
      results,
    };

    console.log("\nNeo4j benchmark results:");

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
    console.error("\nNeo4j benchmark failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

runNeo4jBenchmarks();