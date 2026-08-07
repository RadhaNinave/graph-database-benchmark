import { createDatabaseAdapter } from "./config/databases.js";

async function testNeo4jConnection() {
  let driver;

  try {
    const adapter = createDatabaseAdapter("neo4j");

    driver = adapter.driver;

    await driver.verifyConnectivity();

    const result = await adapter.executeQuery(`
      RETURN "Connected to Neo4j successfully!" AS message
    `);

    console.log(result.records[0].get("message"));
  } catch (error) {
    console.error("Neo4j connection failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

testNeo4jConnection();