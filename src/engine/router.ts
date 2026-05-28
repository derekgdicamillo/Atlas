export type EngineName = "cli" | "sdk";

/** Decide which inference engine to use. Default cli; fail safe to cli on bad input. */
export function selectEngine(options?: { engine?: EngineName }): EngineName {
  if (options?.engine === "cli" || options?.engine === "sdk") return options.engine;
  return process.env.ATLAS_ENGINE === "sdk" ? "sdk" : "cli";
}
