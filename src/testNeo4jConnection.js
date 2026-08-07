import driver from "./config/neo4j.js";

try {
  await driver.verifyConnectivity();
  console.log("Neo4j connected successfully!");
} catch (error) {
  console.error(error);
} finally {
  await driver.close();
}