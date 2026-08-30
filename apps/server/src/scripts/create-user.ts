import path from "node:path";
import { AuthService } from "../auth.js";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";

const [username, password] = process.argv.slice(2);

if (!username || !password) {
  console.error("Usage: npm run create-user -- <username> <password>");
  console.error("Run this only while the server process is stopped —");
  console.error("the store is single-process, so a running server would");
  console.error("overwrite this script's write on its next save.");
  process.exit(1);
}

const config = loadConfig();
const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
await store.initialize();

const auth = new AuthService(store);
const user = await auth.createUser(username, password);

console.log(`Created user "${user.username}" (${user.id}).`);
