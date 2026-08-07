import fs from "fs/promises";
import driver from "../config/cognodb.js";
import { benchmarkQueries } from "./benchmarkQueries.js";
import { runQueryBenchmark } from "./benchmarkRunner.js";

const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 100;

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}

async function getUserIds() {
  const result = await driver.executeQuery(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return result.records.map((record) => {
    const id = record.get("id");

    return typeof id?.toNumber === "function"
      ? id.toNumber()
      : Number(id);
  });
}

async function getTraversalStartNodeIds() {
  const result = await driver.executeQuery(`
    MATCH (u:User)-[:VOTED_FOR]->()
    WITH u, count(*) AS outgoingRelationships
    WHERE outgoingRelationships > 0
    RETURN u.id AS id
  `);

  return result.records.map((record) => {
    const id = record.get("id");

    return typeof id?.toNumber === "function"
      ? id.toNumber()
      : Number(id);
  });
}

async function saveResults(results) {
  await fs.mkdir("./results", {
    recursive: true,
  });

  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");

  const outputPath =
    `./results/cognodb-read-benchmark-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log(`\nResults saved to ${outputPath}`);
}

async function runBenchmarks() {
  try {
    await driver.verifyConnectivity();

    console.log("Connected to CognoDB.");
    console.log("Loading benchmark start-node IDs...");

    const allUserIds = await getUserIds();
    const traversalUserIds = await getTraversalStartNodeIds();

    if (allUserIds.length === 0) {
      throw new Error("No User nodes found.");
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

    const results = [];

    results.push(
      await runQueryBenchmark({
        driver,
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
        driver,
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

    for (const key of ["oneHop", "twoHop", "threeHop"]) {
      const benchmark = benchmarkQueries[key];

      results.push(
        await runQueryBenchmark({
          driver,
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
        driver,
        name: benchmarkQueries.aggregation.name,
        query: benchmarkQueries.aggregation.query,
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
      })
    );

    const output = {
      database: "CognoDB",
      dataset: {
        name: "SNAP Wiki-Vote",
        nodes: allUserIds.length,
        relationships: 103689,
        relationshipType: "VOTED_FOR",
      },
      methodology: {
        warmupIterations: WARMUP_ITERATIONS,
        measuredIterations: MEASURED_ITERATIONS,
        timingLocation: "Node.js client",
        startNodes: "Randomly selected per iteration",
        index: "User.id",
      },
      generatedAt: new Date().toISOString(),
      results,
    };

    console.log("\nBenchmark results:");

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
    console.error("\nBenchmark failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

runBenchmarks();