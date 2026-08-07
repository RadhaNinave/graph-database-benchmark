import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Client } = pg;

const requiredVariables = [
  "AGE_HOST",
  "AGE_PORT",
  "AGE_DATABASE",
  "AGE_USER",
  "AGE_PASSWORD",
  "AGE_GRAPH",
];

function validateEnvironment() {
  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName]
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing Apache AGE environment variables: ${missingVariables.join(", ")}`
    );
  }
}

export function createAgeClient() {
  validateEnvironment();

  const port = Number(process.env.AGE_PORT);

  if (!Number.isInteger(port)) {
    throw new Error("AGE_PORT must be a valid integer.");
  }

  return new Client({
    host: process.env.AGE_HOST,
    port,
    database: process.env.AGE_DATABASE,
    user: process.env.AGE_USER,
    password: process.env.AGE_PASSWORD,
  });
}

export async function initialiseAge(client) {
  await client.query(`
    CREATE EXTENSION IF NOT EXISTS age
  `);

  await client.query(`
    LOAD 'age'
  `);

  await client.query(`
    SET search_path = ag_catalog, "$user", public
  `);
}

export function getAgeGraphName() {
  return process.env.AGE_GRAPH || "wiki_vote";
}

function validateGraphName(graphName) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(graphName)) {
    throw new Error(`Invalid Apache AGE graph name: ${graphName}`);
  }
}

export async function ensureAgeGraphExists(client) {
  const graphName = getAgeGraphName();

  validateGraphName(graphName);

  const result = await client.query(
    `
    SELECT name
    FROM ag_catalog.ag_graph
    WHERE name = $1
    `,
    [graphName]
  );

  if (result.rowCount === 0) {
    await client.query(
      `
      SELECT ag_catalog.create_graph($1)
      `,
      [graphName]
    );
  }
}

export async function runAgeCypher(
  client,
  cypherQuery,
  columns = ["result"]
) {
  const graphName = getAgeGraphName();

  validateGraphName(graphName);

  if (cypherQuery.includes("$age_query$")) {
    throw new Error(
      "Cypher query contains the reserved AGE dollar-quote delimiter."
    );
  }

  const columnDefinition = columns
    .map((column) => `${column} agtype`)
    .join(", ");

  const sql = `
    SELECT *
    FROM ag_catalog.cypher(
      '${graphName}',
      $age_query$
        ${cypherQuery}
      $age_query$
    ) AS (${columnDefinition})
  `;

  return client.query(sql);
}