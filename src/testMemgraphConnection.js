import { createDatabaseAdapter } from "./config/databases.js";

async function testMemgraphConnection() {
  let driver;

  try {
    const adapter = createDatabaseAdapter("memgraph");

    driver = adapter.driver;

    await driver.verifyConnectivity();

    const result = await adapter.executeQuery(`
      RETURN "Connected to Memgraph successfully!" AS message
    `);

    console.log(result.records[0].get("message"));
  } catch (error) {
    console.error(error);
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

testMemgraphConnection();