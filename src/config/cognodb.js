import neo4j from "neo4j-driver";
import dotenv from "dotenv";

dotenv.config();

const {
  COGNODB_URI,
  COGNODB_USERNAME,
  COGNODB_PASSWORD,
} = process.env;

if (!COGNODB_URI || !COGNODB_USERNAME || !COGNODB_PASSWORD) {
  throw new Error("Missing CognoDB environment variables.");
}

const driver = neo4j.driver(
  COGNODB_URI,
  neo4j.auth.basic(COGNODB_USERNAME, COGNODB_PASSWORD)
);

export default driver;