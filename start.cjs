const { execSync } = require("child_process");
const { spawn } = require("child_process");

const child = spawn(
  "C:\\Users\\Derek DiCamillo\\.bun\\bin\\bun.exe",
  ["run", "src/relay.ts"],
  {
    cwd: "C:\\Users\\Derek DiCamillo\\atlas",
    stdio: "inherit",
    env: process.env,
  }
);

child.on("exit", (code) => process.exit(code || 0));
