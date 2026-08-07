import dotenv from "dotenv";
import { FalkorDB } from "falkordb";

dotenv.config();

async function testFalkorDBConnection() {
  let client;

  try {
    const port = Number(process.env.FALKORDB_PORT);

    if (!process.env.FALKORDB_HOST) {
      throw new Error("FALKORDB_HOST is missing.");
    }

    if (!Number.isInteger(port)) {
      throw new Error("FALKORDB_PORT must be a valid number.");
    }

    if (!process.env.FALKORDB_USERNAME) {
      throw new Error("FALKORDB_USERNAME is missing.");
    }

    if (!process.env.FALKORDB_PASSWORD) {
      throw new Error("FALKORDB_PASSWORD is missing.");
    }

    client = await FalkorDB.connect({
      username: process.env.FALKORDB_USERNAME,
      password: process.env.FALKORDB_PASSWORD,
      socket: {
        host: process.env.FALKORDB_HOST,
        port,
        tls: process.env.FALKORDB_TLS === "true",
        connectTimeout: 15000,
      },
    });

    const graph = client.selectGraph(
      process.env.FALKORDB_GRAPH || "wiki_vote"
    );

    const result = await graph.query(`
      RETURN "Connected to FalkorDB successfully" AS message
    `);

    console.log("Connected to FalkorDB successfully.");
    console.log(result);
  } catch (error) {
    console.error("FalkorDB connection failed:");
    console.error(error);
    process.exitCode = 1;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

testFalkorDBConnection();