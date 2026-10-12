import { loadConfig } from "./config.js";
import { MessageStore } from "./store.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const store = new MessageStore(config.messagesFile);
  await store.init();

  const app = await buildApp(config, store);
  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
