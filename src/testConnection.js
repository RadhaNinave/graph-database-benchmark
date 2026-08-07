import { createDatabaseAdapter } from "./config/databases.js";

async function testCognoDBConnection() {
  let driver;

  try {
    const adapter = createDatabaseAdapter("cognodb");

    driver = adapter.driver;

    await driver.verifyConnectivity();

    const result = await adapter.executeQuery(`
      RETURN "Connected to CognoDB successfully!" AS message
    `);

    console.log(result.records[0].get("message"));
  } catch (error) {
    console.error("CognoDB connection failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (driver) {
      await driver.close();
    }
  }
}

testCognoDBConnection();