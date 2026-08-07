import dotenv from "dotenv";
import pg from "pg";

dotenv.config();

const { Client } = pg;

function validateEnvironment() {
  const requiredVariables = [
    "AGE_HOST",
    "AGE_PORT",
    "AGE_DATABASE",
    "AGE_USER",
    "AGE_PASSWORD",
    "AGE_GRAPH",
  ];

  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName]
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing Apache AGE environment variables: ${missingVariables.join(", ")}`
    );
  }
}

function createClient() {
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

async function initialiseAge(client) {
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

async function ensureGraphExists(client) {
  const graphName = process.env.AGE_GRAPH;

  const existingGraph = await client.query(
    `
    SELECT name
    FROM ag_catalog.ag_graph
    WHERE name = $1
    `,
    [graphName]
  );

  if (existingGraph.rowCount === 0) {
    await client.query(
      `
      SELECT create_graph($1)
      `,
      [graphName]
    );

    console.log(`Created Apache AGE graph: ${graphName}`);
  } else {
    console.log(`Apache AGE graph already exists: ${graphName}`);
  }
}

async function testAgeConnection() {
  const client = createClient();

  try {
    await client.connect();

    console.log("Connected to PostgreSQL.");

    await initialiseAge(client);

    console.log("Apache AGE extension loaded.");

    await ensureGraphExists(client);

    const result = await client.query(`
      SELECT current_database() AS database_name
    `);

    console.log("Apache AGE connected successfully.");
    console.log(`Database: ${result.rows[0].database_name}`);
    console.log(`Graph: ${process.env.AGE_GRAPH}`);
  } catch (error) {
    console.error("Apache AGE connection failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

testAgeConnection();