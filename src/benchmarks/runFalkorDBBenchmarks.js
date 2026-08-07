import fs from "fs/promises";
import { performance } from "perf_hooks";
import dotenv from "dotenv";
import { FalkorDB } from "falkordb";
import { calculateStatistics } from "../utils/statistics.js";

dotenv.config();

const GRAPH_NAME =
  process.env.FALKORDB_GRAPH || "wiki_vote";

const WARMUP_ITERATIONS = 20;
const MEASURED_ITERATIONS = 100;

const benchmarkQueries = {
  pointLookup: {
    name: "Point lookup",
    query: `
      MATCH (u:User {id: $userId})
      RETURN u.id AS id
    `,
  },

  filteredLookup: {
    name: "Indexed range lookup",
    query: `
      MATCH (u:User)
      WHERE u.id >= $minimumId
        AND u.id < $maximumId
      RETURN count(u) AS matchedUsers
    `,
  },

  oneHop: {
    name: "1-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination) AS resultCount
    `,
  },

  twoHop: {
    name: "2-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination) AS resultCount
    `,
  },

  threeHop: {
    name: "3-hop traversal",
    query: `
      MATCH (:User {id: $userId})
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (:User)
            -[:VOTED_FOR]->
            (destination:User)
      RETURN count(destination) AS resultCount
    `,
  },

  aggregation: {
    name: "Vote count aggregation",
    query: `
      MATCH (candidate:User)<-[:VOTED_FOR]-(voter:User)
      RETURN
        candidate.id AS candidateId,
        count(voter) AS voteCount
      ORDER BY voteCount DESC
      LIMIT 20
    `,
  },
};

function validateEnvironment() {
  const requiredVariables = [
    "FALKORDB_HOST",
    "FALKORDB_PORT",
    "FALKORDB_USERNAME",
    "FALKORDB_PASSWORD",
  ];

  const missingVariables =
    requiredVariables.filter(
      (variableName) =>
        !process.env[variableName]
    );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing FalkorDB environment variables: ${missingVariables.join(
        ", "
      )}`
    );
  }
}

async function connectToFalkorDB() {
  validateEnvironment();

  const port = Number(
    process.env.FALKORDB_PORT
  );

  if (!Number.isInteger(port)) {
    throw new Error(
      "FALKORDB_PORT must be a valid integer."
    );
  }

  return FalkorDB.connect({
    username:
      process.env.FALKORDB_USERNAME,
    password:
      process.env.FALKORDB_PASSWORD,
    socket: {
      host: process.env.FALKORDB_HOST,
      port,
      tls:
        process.env.FALKORDB_TLS ===
        "true",
      connectTimeout: 15000,
    },
  });
}

function randomItem(values) {
  return values[
    Math.floor(Math.random() * values.length)
  ];
}

function extractColumnValues(
  result,
  propertyName
) {
  if (
    !result ||
    !Array.isArray(result.data)
  ) {
    throw new Error(
      `Invalid FalkorDB result for "${propertyName}".`
    );
  }

  return result.data
    .map((row) => Number(row[propertyName]))
    .filter((value) =>
      Number.isFinite(value)
    );
}

async function getUserIds(graph) {
  const result = await graph.query(`
    MATCH (u:User)
    RETURN u.id AS id
  `);

  return extractColumnValues(result, "id");
}

async function getTraversalStartNodeIds(
  graph
) {
  const result = await graph.query(`
    MATCH (u:User)-[:VOTED_FOR]->()
    WITH
      u,
      count(*) AS outgoingRelationships
    WHERE outgoingRelationships > 0
    RETURN u.id AS id
  `);

  return extractColumnValues(result, "id");
}

async function getRelationshipCount(
  graph
) {
  const result = await graph.query(`
    MATCH ()-[r:VOTED_FOR]->()
    RETURN count(r) AS relationshipCount
  `);

  const values = extractColumnValues(
    result,
    "relationshipCount"
  );

  return values[0] || 0;
}

async function runQueryBenchmark({
  graph,
  name,
  query,
  createParams = () => ({}),
}) {
  console.log(`\nRunning: ${name}`);
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
    await graph.query(query, {
      params: createParams(),
    });
  }

  const latencies = [];

  for (
    let index = 0;
    index < MEASURED_ITERATIONS;
    index += 1
  ) {
    const params = createParams();

    const startTime =
      performance.now();

    await graph.query(query, {
      params,
    });

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
    benchmark: name,
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
    `./results/falkordb-read-benchmark-${timestamp}.json`;

  await fs.writeFile(
    outputPath,
    JSON.stringify(output, null, 2),
    "utf8"
  );

  console.log(
    `\nResults saved to ${outputPath}`
  );
}

async function runFalkorDBBenchmarks() {
  let client;

  try {
    client =
      await connectToFalkorDB();

    const graph =
      client.selectGraph(GRAPH_NAME);

    console.log(
      "Connected to FalkorDB."
    );
    console.log(
      `Graph name: ${GRAPH_NAME}`
    );
    console.log(
      "Loading benchmark start-node IDs..."
    );

    const allUserIds =
      await getUserIds(graph);

    const traversalUserIds =
      await getTraversalStartNodeIds(
        graph
      );

    const relationshipCount =
      await getRelationshipCount(graph);

    if (allUserIds.length === 0) {
      throw new Error(
        "No User nodes found. Run the FalkorDB loader first."
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
        graph,
        name:
          benchmarkQueries.pointLookup
            .name,
        query:
          benchmarkQueries.pointLookup
            .query,
        createParams: () => ({
          userId:
            randomItem(allUserIds),
        }),
      })
    );

    results.push(
      await runQueryBenchmark({
        graph,
        name:
          benchmarkQueries.filteredLookup
            .name,
        query:
          benchmarkQueries.filteredLookup
            .query,
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
          graph,
          name: benchmark.name,
          query: benchmark.query,
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
        graph,
        name:
          benchmarkQueries.aggregation
            .name,
        query:
          benchmarkQueries.aggregation
            .query,
      })
    );

    const output = {
      database: "FalkorDB",

      graph: GRAPH_NAME,

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
          "Randomly selected per measured iteration",
        index: "User.id",
      },

      generatedAt:
        new Date().toISOString(),

      results,
    };

    console.log(
      "\nFalkorDB benchmark results:"
    );

    console.table(
      results.map((result) => ({
        benchmark:
          result.benchmark,
        p50Ms:
          result.p50Ms,
        p95Ms:
          result.p95Ms,
        averageMs:
          result.averageMs,
        minMs:
          result.minMs,
        maxMs:
          result.maxMs,
      }))
    );

    await saveResults(output);
  } catch (error) {
    console.error(
      "\nFalkorDB benchmark failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

runFalkorDBBenchmarks();