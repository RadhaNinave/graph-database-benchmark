import fs from "fs";
import readline from "readline";
import { performance } from "perf_hooks";
import { createDatabaseAdapter } from "../config/databases.js";

const DATASET_PATH = "./data/Wiki-Vote.txt";
const BATCH_SIZE = 1000;

function getDatabaseKey() {
  const databaseKey = process.argv[2];

  if (!databaseKey) {
    throw new Error(
      "Database key is required. Example: node src/loaders/loadDatabase.js neo4j"
    );
  }

  return databaseKey.toLowerCase();
}

async function readDataset() {
  const nodeIds = new Set();
  const relationships = [];

  const fileStream =
    fs.createReadStream(DATASET_PATH);

  const lineReader =
    readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

  for await (const line of lineReader) {
    const trimmedLine = line.trim();

    if (
      !trimmedLine ||
      trimmedLine.startsWith("#")
    ) {
      continue;
    }

    const [fromId, toId] = trimmedLine
      .split(/\s+/)
      .map(Number);

    if (
      !Number.isInteger(fromId) ||
      !Number.isInteger(toId)
    ) {
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
    nodes: [...nodeIds].map((id) => ({
      id,
    })),
    relationships,
  };
}

async function clearDatabase(executeQuery) {
  console.log("Clearing existing data...");

  await executeQuery(`
    MATCH (n)
    DETACH DELETE n
  `);
}

async function createIndex(
  executeQuery,
  databaseKey
) {
  console.log("Creating User.id index...");

  await executeQuery(`
    CREATE INDEX user_id_index IF NOT EXISTS
    FOR (u:User)
    ON (u.id)
  `);

  // Neo4j Aura supports db.awaitIndexes().
  // CognoDB or Memgraph may not support the same procedure.
  if (databaseKey === "neo4j") {
    await executeQuery(`
      CALL db.awaitIndexes()
    `);
  }
}

async function insertNodes(
  executeQuery,
  nodes
) {
  console.log(
    `Inserting ${nodes.length} nodes...`
  );

  for (
    let index = 0;
    index < nodes.length;
    index += BATCH_SIZE
  ) {
    const batch = nodes.slice(
      index,
      index + BATCH_SIZE
    );

    await executeQuery(
      `
      UNWIND $nodes AS node
      CREATE (:User {id: node.id})
      `,
      { nodes: batch }
    );

    console.log(
      `Nodes inserted: ${Math.min(
        index + BATCH_SIZE,
        nodes.length
      )}/${nodes.length}`
    );
  }
}

async function insertRelationships(
  executeQuery,
  relationships
) {
  console.log(
    `Inserting ${relationships.length} relationships...`
  );

  for (
    let index = 0;
    index < relationships.length;
    index += BATCH_SIZE
  ) {
    const batch = relationships.slice(
      index,
      index + BATCH_SIZE
    );

    await executeQuery(
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
        relationships: batch,
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

function toNumber(value) {
  return typeof value?.toNumber ===
    "function"
    ? value.toNumber()
    : Number(value);
}

async function verifyCounts(executeQuery) {
  const result = await executeQuery(`
    MATCH (u:User)
    WITH count(u) AS nodeCount

    MATCH ()-[r:VOTED_FOR]->()

    RETURN
      nodeCount,
      count(r) AS relationshipCount
  `);

  if (result.records.length === 0) {
    throw new Error(
      "Count verification returned no records."
    );
  }

  const record = result.records[0];

  return {
    nodeCount: toNumber(
      record.get("nodeCount")
    ),
    relationshipCount: toNumber(
      record.get("relationshipCount")
    ),
  };
}

async function loadDatabase() {
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

    await driver.verifyConnectivity();

    console.log(
      `Connected to ${config.name}.`
    );
    console.log(
      "Reading Wiki-Vote dataset..."
    );

    const totalStartTime =
      performance.now();

    const { nodes, relationships } =
      await readDataset();

    console.log(
      `Unique nodes found: ${nodes.length}`
    );
    console.log(
      `Relationships found: ${relationships.length}`
    );

    await clearDatabase(executeQuery);

    await createIndex(
      executeQuery,
      databaseKey
    );

    const nodeStartTime =
      performance.now();

    await insertNodes(
      executeQuery,
      nodes
    );

    const nodeLoadSeconds =
      (performance.now() - nodeStartTime) /
      1000;

    const relationshipStartTime =
      performance.now();

    await insertRelationships(
      executeQuery,
      relationships
    );

    const relationshipLoadSeconds =
      (performance.now() -
        relationshipStartTime) /
      1000;

    const counts = await verifyCounts(
      executeQuery
    );

    const totalLoadSeconds =
      (performance.now() -
        totalStartTime) /
      1000;

    const results = {
      database: config.name,
      nodes: counts.nodeCount,
      relationships:
        counts.relationshipCount,

      nodeLoadSeconds: Number(
        nodeLoadSeconds.toFixed(2)
      ),

      relationshipLoadSeconds: Number(
        relationshipLoadSeconds.toFixed(2)
      ),

      totalLoadSeconds: Number(
        totalLoadSeconds.toFixed(2)
      ),

      nodesPerSecond: Number(
        (
          counts.nodeCount /
          nodeLoadSeconds
        ).toFixed(2)
      ),

      relationshipsPerSecond: Number(
        (
          counts.relationshipCount /
          relationshipLoadSeconds
        ).toFixed(2)
      ),
    };

    console.log(
      `\n${config.name} load results:`
    );
    console.table(results);
  } catch (error) {
    console.error(
      "\nDataset load failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

loadDatabase();