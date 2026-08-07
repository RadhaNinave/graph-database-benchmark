import fs from "fs";
import readline from "readline";
import { performance } from "perf_hooks";
import driver from "../config/neo4j.js";

const DATASET_PATH = "./data/Wiki-Vote.txt";
const BATCH_SIZE = 1000;
const DATABASE = process.env.NEO4J_DATABASE || "neo4j";

function executeQuery(query, params = {}) {
  return driver.executeQuery(query, params, {
    database: DATABASE,
  });
}

async function readDataset() {
  const nodeIds = new Set();
  const relationships = [];

  const fileStream = fs.createReadStream(DATASET_PATH);

  const lineReader = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of lineReader) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
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
    nodes: [...nodeIds].map((id) => ({ id })),
    relationships,
  };
}

async function clearDatabase() {
  console.log("Clearing Neo4j database...");

  await executeQuery(`
    MATCH (n)
    DETACH DELETE n
  `);
}

async function createIndex() {
  console.log("Creating User.id index...");

  await executeQuery(`
    CREATE INDEX user_id_index IF NOT EXISTS
    FOR (u:User)
    ON (u.id)
  `);

  // Wait until Neo4j confirms that indexes are online.
  await executeQuery(`
    CALL db.awaitIndexes()
  `);
}

async function insertNodes(nodes) {
  console.log(`Inserting ${nodes.length} nodes...`);

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
      {
        nodes: batch,
      }
    );

    console.log(
      `Nodes inserted: ${Math.min(
        index + BATCH_SIZE,
        nodes.length
      )}/${nodes.length}`
    );
  }
}

async function insertRelationships(relationships) {
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

async function verifyCounts() {
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

  const nodeCountValue = record.get("nodeCount");
  const relationshipCountValue =
    record.get("relationshipCount");

  return {
    nodeCount:
      typeof nodeCountValue?.toNumber === "function"
        ? nodeCountValue.toNumber()
        : Number(nodeCountValue),

    relationshipCount:
      typeof relationshipCountValue?.toNumber ===
      "function"
        ? relationshipCountValue.toNumber()
        : Number(relationshipCountValue),
  };
}

async function loadNeo4j() {
  const totalStartTime = performance.now();

  try {
    await driver.verifyConnectivity({
      database: DATABASE,
    });

    console.log("Connected to Neo4j Aura.");
    console.log("Reading Wiki-Vote dataset...");

    const { nodes, relationships } =
      await readDataset();

    console.log(
      `Unique nodes found: ${nodes.length}`
    );

    console.log(
      `Relationships found: ${relationships.length}`
    );

    await clearDatabase();
    await createIndex();

    const nodeStartTime = performance.now();

    await insertNodes(nodes);

    const nodeLoadSeconds =
      (performance.now() - nodeStartTime) / 1000;

    const relationshipStartTime =
      performance.now();

    await insertRelationships(relationships);

    const relationshipLoadSeconds =
      (performance.now() -
        relationshipStartTime) /
      1000;

    const totalLoadSeconds =
      (performance.now() - totalStartTime) /
      1000;

    const counts = await verifyCounts();

    const results = {
      database: "Neo4j Aura",
      nodes: counts.nodeCount,
      relationships: counts.relationshipCount,

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
          counts.nodeCount / nodeLoadSeconds
        ).toFixed(2)
      ),

      relationshipsPerSecond: Number(
        (
          counts.relationshipCount /
          relationshipLoadSeconds
        ).toFixed(2)
      ),
    };

    console.log("\nNeo4j load results:");
    console.table(results);
  } catch (error) {
    console.error("\nNeo4j dataset load failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await driver.close();
  }
}

loadNeo4j();