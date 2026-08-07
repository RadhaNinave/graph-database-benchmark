import driver from "./config/cognodb.js";

async function testConnection() {
  try {
    await driver.verifyConnectivity();

    const result = await driver.executeQuery(`
      RETURN "Connected successfully" AS message
    `);

    console.log(result.records[0].get("message"));
  } catch (error) {
    console.error("Connection failed:", error.message);
  } finally {
    await driver.close();
  }
}

testConnection();