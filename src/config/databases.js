import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

const databaseConfigs = {
  cognodb: {
    key: "cognodb",
    name: "CognoDB",
    uri: process.env.COGNODB_URI,
    username: process.env.COGNODB_USERNAME,
    password: process.env.COGNODB_PASSWORD,
    database: process.env.COGNODB_DATABASE || undefined,
    resultPrefix: "cognodb",
  },

  neo4j: {
    key: "neo4j",
    name: "Neo4j Aura",
    uri: process.env.NEO4J_URI,
    username: process.env.NEO4J_USERNAME,
    password: process.env.NEO4J_PASSWORD,
    database: process.env.NEO4J_DATABASE || "neo4j",
    resultPrefix: "neo4j",
  },

  memgraph: {
    key: "memgraph",
    name: "Memgraph",
    uri: process.env.MEMGRAPH_URI,
    username: process.env.MEMGRAPH_USERNAME,
    password: process.env.MEMGRAPH_PASSWORD,
    database: undefined,
    resultPrefix: "memgraph",
  },
};

export function getDatabaseConfig(databaseKey) {
  const config = databaseConfigs[databaseKey];

  if (!config) {
    throw new Error(
      `Unsupported database "${databaseKey}". Supported values: ${Object.keys(
        databaseConfigs
      ).join(", ")}`
    );
  }

  if (!config.uri || !config.username || !config.password) {
    throw new Error(
      `Missing environment variables for ${config.name}. Check your .env file.`
    );
  }

  return config;
}

export function createDatabaseAdapter(databaseKey) {
  const config = getDatabaseConfig(databaseKey);

  const driver = neo4j.driver(
    config.uri,
    neo4j.auth.basic(
      config.username,
      config.password
    )
  );

  const executeQuery = (
    query,
    params = {}
  ) => {
    const options = config.database
      ? { database: config.database }
      : {};

    return driver.executeQuery(
      query,
      params,
      options
    );
  };

  return {
    config,
    driver,
    executeQuery,
  };
}