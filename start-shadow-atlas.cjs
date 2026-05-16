// Atlas Prime Sprint 7: pm2 wrapper for shadow-atlas.
// pm2's ProcessContainerForkBun is incompatible with bun via direct
// interpreter:"bun" — spawning bun.exe from a CJS wrapper sidesteps that.
const { spawn } = require("child_process");

const child = spawn(
  "C:\\Users\\Derek DiCamillo\\.bun\\bin\\bun.exe",
  ["run", "src/shadow-atlas.ts"],
  {
    cwd: "C:\\Users\\Derek DiCamillo\\Projects\\atlas",
    stdio: "inherit",
    env: process.env,
  }
);

child.on("exit", (code) => process.exit(code || 0));
