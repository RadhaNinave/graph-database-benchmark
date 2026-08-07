import fs from "fs";
import readline from "readline";
import { performance } from "perf_hooks";
import dotenv from "dotenv";
import { FalkorDB } from "falkordb";

dotenv.config();

const DATASET_PATH = "./data/Wiki-Vote.txt";
const BATCH_SIZE = 500;
const GRAPH_NAME = process.env.FALKORDB_GRAPH || "wiki_vote";

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
    throw new Error("FALKORDB_PORT must be a valid integer.");
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

async function readDataset() {
  const nodeIds = new Set();
  const relationships = [];

  const fileStream = fs.createReadStream(DATASET_PATH);

  fileStream.on("error", (error) => {
    throw new Error(`Failed to read dataset: ${error.message}`);
  });

  const lineReader = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of lineReader) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const [fromId, toId] = trimmedLine.split(/\s+/).map(Number);

    if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
      continue;
    }

    nodeIds.add(fromId);
    nodeIds.add(toId);

    relationships.push({
      fromId,
      toId,
    });
  }

  return {
    nodes: [...nodeIds].map((id) => ({ id })),
    relationships,
  };
}

async function clearGraph(graph) {
  console.log("Clearing existing FalkorDB graph...");

  await graph.query(`
    MATCH (n)
    DETACH DELETE n
  `);
}

async function createIndex(graph) {
  console.log("Creating User.id index...");

  try {
    await graph.query(`
      CREATE INDEX FOR (u:User)
      ON (u.id)
    `);
  } catch (error) {
    const message = String(error.message).toLowerCase();

    if (
      message.includes("already indexed") ||
      message.includes("already exists") ||
      message.includes("index already")
    ) {
      console.log("User.id index already exists.");
      return;
    }

    throw error;
  }
}

async function insertNodes(graph, nodes) {
  console.log(`Inserting ${nodes.length} nodes...`);

  for (let index = 0; index < nodes.length; index += BATCH_SIZE) {
    const batch = nodes.slice(index, index + BATCH_SIZE);

    await graph.query(
      `
      UNWIND $nodes AS node
      CREATE (:User {id: node.id})
      `,
      {
        params: {
          nodes: batch,
        },
      }
    );

    console.log(
      `Nodes inserted: ${Math.min(index + BATCH_SIZE, nodes.length)}/${nodes.length}`
    );
  }
}

async function insertRelationships(graph, relationships) {
  console.log(`Inserting ${relationships.length} relationships...`);

  for (
    let index = 0;
    index < relationships.length;
    index += BATCH_SIZE
  ) {
    const batch = relationships.slice(index, index + BATCH_SIZE);

    await graph.query(
      `
      UNWIND $relationships AS relationship

      MATCH (from:User {
        id: relationship.fromId
      })

      MATCH (to:User {
        id: relationship.toId
      })

      CREATE (from)-[:VOTED_FOR]->(to)
      `,
      {
        params: {
          relationships: batch,
        },
      }
    );

    console.log(
      `Relationships inserted: ${Math.min(
        index + BATCH_SIZE,
        relationships.length
      )}/${relationships.length}`
    );
  }
}

function readNumericResult(result, propertyName) {
  if (!result?.data || result.data.length === 0) {
    throw new Error(
      `FalkorDB query returned no result for "${propertyName}".`
    );
  }

  const value = result.data[0][propertyName];
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue)) {
    throw new Error(
      `Invalid numeric result for "${propertyName}": ${value}`
    );
  }

  return numericValue;
}

async function verifyCounts(graph) {
  const nodeResult = await graph.query(`
    MATCH (u:User)
    RETURN count(u) AS nodeCount
  `);

  const relationshipResult = await graph.query(`
    MATCH ()-[r:VOTED_FOR]->()
    RETURN count(r) AS relationshipCount
  `);

  return {
    nodeCount: readNumericResult(nodeResult, "nodeCount"),
    relationshipCount: readNumericResult(
      relationshipResult,
      "relationshipCount"
    ),
  };
}

async function loadFalkorDB() {
  let client;

  try {
    client = await connectToFalkorDB();

    const graph = client.selectGraph(GRAPH_NAME);

    console.log("Connected to FalkorDB.");
    console.log(`Graph name: ${GRAPH_NAME}`);
    console.log("Reading Wiki-Vote dataset...");

    const { nodes, relationships } = await readDataset();

    console.log(`Unique nodes found: ${nodes.length}`);
    console.log(`Relationships found: ${relationships.length}`);

    const totalStartTime = performance.now();

    await clearGraph(graph);
    await createIndex(graph);

    const nodeStartTime = performance.now();

    await insertNodes(graph, nodes);

    const nodeLoadSeconds =
      (performance.now() - nodeStartTime) / 1000;

    const relationshipStartTime = performance.now();

    await insertRelationships(graph, relationships);

    const relationshipLoadSeconds =
      (performance.now() - relationshipStartTime) / 1000;

    const counts = await verifyCounts(graph);

    const totalLoadSeconds =
      (performance.now() - totalStartTime) / 1000;

    const results = {
      database: "FalkorDB",
      graph: GRAPH_NAME,
      nodes: counts.nodeCount,
      relationships: counts.relationshipCount,
      nodeLoadSeconds: Number(nodeLoadSeconds.toFixed(2)),
      relationshipLoadSeconds: Number(
        relationshipLoadSeconds.toFixed(2)
      ),
      totalLoadSeconds: Number(totalLoadSeconds.toFixed(2)),
      nodesPerSecond: Number(
        (counts.nodeCount / nodeLoadSeconds).toFixed(2)
      ),
      relationshipsPerSecond: Number(
        (
          counts.relationshipCount / relationshipLoadSeconds
        ).toFixed(2)
      ),
    };

    console.log("\nFalkorDB load results:");
    console.table(results);
  } catch (error) {
    console.error("\nFalkorDB dataset load failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

loadFalkorDB();