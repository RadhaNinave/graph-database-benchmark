import fs from "fs";
import readline from "readline";
import { performance } from "perf_hooks";
import {
  createAgeClient,
  initialiseAge,
  ensureAgeGraphExists,
  runAgeCypher,
} from "../config/age.js";

const DATASET_PATH = "./data/Wiki-Vote.txt";
const NODE_BATCH_SIZE = 500;
const RELATIONSHIP_BATCH_SIZE = 250;

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
    nodes: [...nodeIds],
    relationships,
  };
}

async function clearGraph(client) {
  console.log("Clearing existing Apache AGE graph data...");

  await runAgeCypher(
    client,
    `
      MATCH (n)
      DETACH DELETE n
    `
  );
}

async function insertNodes(client, nodeIds) {
  console.log(`Inserting ${nodeIds.length} nodes...`);

  for (
    let index = 0;
    index < nodeIds.length;
    index += NODE_BATCH_SIZE
  ) {
    const batch = nodeIds.slice(
      index,
      index + NODE_BATCH_SIZE
    );

    const nodeList = batch
      .map((id) => `{id: ${id}}`)
      .join(", ");

    await runAgeCypher(
      client,
      `
        UNWIND [${nodeList}] AS node
        CREATE (:User {id: node.id})
      `
    );

    console.log(
      `Nodes inserted: ${Math.min(
        index + NODE_BATCH_SIZE,
        nodeIds.length
      )}/${nodeIds.length}`
    );
  }
}

async function insertRelationships(
  client,
  relationships
) {
  console.log(
    `Inserting ${relationships.length} relationships...`
  );

  for (
    let index = 0;
    index < relationships.length;
    index += RELATIONSHIP_BATCH_SIZE
  ) {
    const batch = relationships.slice(
      index,
      index + RELATIONSHIP_BATCH_SIZE
    );

    const relationshipList = batch
      .map(
        ({ fromId, toId }) =>
          `{fromId: ${fromId}, toId: ${toId}}`
      )
      .join(", ");

    await runAgeCypher(
      client,
      `
        UNWIND [${relationshipList}] AS relationship

        MATCH (from:User), (to:User)

        WHERE from.id = relationship.fromId
          AND to.id = relationship.toId

        CREATE (from)-[:VOTED_FOR]->(to)
      `
    );

    console.log(
      `Relationships inserted: ${Math.min(
        index + RELATIONSHIP_BATCH_SIZE,
        relationships.length
      )}/${relationships.length}`
    );
  }
}

function parseAgtypeNumber(value) {
  const parsed = Number(
    String(value).replace(/::[\w]+$/, "")
  );

  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Unable to convert AGE value to number: ${value}`
    );
  }

  return parsed;
}

async function verifyCounts(client) {
  const nodeResult = await runAgeCypher(
    client,
    `
      MATCH (u:User)
      RETURN count(u)
    `,
    ["node_count"]
  );

  const relationshipResult = await runAgeCypher(
    client,
    `
      MATCH ()-[r:VOTED_FOR]->()
      RETURN count(r)
    `,
    ["relationship_count"]
  );

  return {
    nodeCount: parseAgtypeNumber(
      nodeResult.rows[0].node_count
    ),
    relationshipCount: parseAgtypeNumber(
      relationshipResult.rows[0].relationship_count
    ),
  };
}

async function loadAgeDatabase() {
  const client = createAgeClient();

  try {
    await client.connect();

    await initialiseAge(client);
    await ensureAgeGraphExists(client);

    console.log("Connected to Apache AGE.");
    console.log("Reading Wiki-Vote dataset...");

    const {
      nodes,
      relationships,
    } = await readDataset();

    console.log(
      `Unique nodes found: ${nodes.length}`
    );

    console.log(
      `Relationships found: ${relationships.length}`
    );

    const totalStartTime = performance.now();

    await clearGraph(client);

    const nodeStartTime = performance.now();

    await insertNodes(client, nodes);

    const nodeLoadSeconds =
      (performance.now() - nodeStartTime) / 1000;

    const relationshipStartTime =
      performance.now();

    await insertRelationships(
      client,
      relationships
    );

    const relationshipLoadSeconds =
      (performance.now() -
        relationshipStartTime) /
      1000;

    const counts = await verifyCounts(client);

    const totalLoadSeconds =
      (performance.now() - totalStartTime) /
      1000;

    const results = {
      database: "Apache AGE",
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

    console.log("\nApache AGE load results:");
    console.table(results);
  } catch (error) {
    console.error(
      "\nApache AGE dataset load failed:"
    );
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

loadAgeDatabase();