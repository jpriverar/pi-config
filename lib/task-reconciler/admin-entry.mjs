export const ADMIN_SOURCE = `export async function runCli(argv, options) {
  if (typeof options?.deployment !== "string" || !/^[a-z0-9][a-z0-9-]{0,95}$/.test(options.deployment)) throw new Error("invalid installed deployment");
  const entry = new URL("./runtimes/" + options.deployment + "/lib/task-reconciler/cli.js", import.meta.url);
  return (await import(entry.href)).runCli(argv, { sourceRoot: options.sourceRoot });
}
`;
