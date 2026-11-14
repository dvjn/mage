// Runs a throwaway Postgres for the journeys in a container, makes the databases their servers
// use, and says once they are there. It keeps nothing: the container goes when this stops.

import { execFileSync, spawn } from "node:child_process";

import pg from "pg";

import { databasePort, databases } from "./servers.ts";

const NAME = "mage-e2e-postgres";
const runtime = (() => {
  try {
    execFileSync("podman", ["--version"], { stdio: "ignore" });
    return "podman";
  } catch {
    return "docker";
  }
})();

function remove() {
  try {
    execFileSync(runtime, ["rm", "-f", NAME], { stdio: "ignore" });
  } catch {
    // It was not there.
  }
}

remove();
const container = spawn(
  runtime,
  [
    "run",
    "--rm",
    "--name",
    NAME,
    "-e",
    "POSTGRES_USER=mage",
    "-e",
    "POSTGRES_PASSWORD=mage",
    "-p",
    `${databasePort}:5432`,
    "--tmpfs",
    "/var/lib/postgresql",
    "docker.io/library/postgres:18.1",
  ],
  { stdio: "ignore" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    remove();
    process.exit(0);
  });
}
container.once("exit", (code) => process.exit(code ?? 1));

const admin = `postgres://mage:mage@localhost:${databasePort}/postgres`;
for (;;) {
  const client = new pg.Client({ connectionString: admin });
  try {
    await client.connect();
    for (const name of Object.keys(databases)) {
      const there = await client.query("select 1 from pg_database where datname = $1", [name]);
      if (there.rowCount === 0) await client.query(`create database "${name}"`);
    }
    await client.end();
    break;
  } catch {
    await client.end().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
console.log("databases ready");
