const { execSync } = require("child_process");
const { spawn } = require("child_process");

const child = spawn(
  "C:\\Users\\derek\\.bun\\bin\\bun.exe",
  ["run", "src/relay.ts"],
  {
    cwd: "C:\\Users\\derek\\Projects\\atlas",
    stdio: "inherit",
    env: process.env,
  }
);

child.on("exit", (code) => process.exit(code || 0));
