import type { BeadsExecResult } from "../beads.js";

export interface LaunchdState {
  loaded: boolean;
  disabled: boolean;
  pid: number | null;
}
export type LaunchdCommand = (
  args: readonly string[],
) => Promise<BeadsExecResult>;
export function launchAgent(
  label: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  const xml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(
      ([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`,
    )
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>30</integer><key>ExitTimeOut</key><integer>30</integer>
<key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
export async function inspectLaunchd(
  command: LaunchdCommand,
  domain: string,
  label: string,
  agent: string,
  expectedArgs: readonly string[],
): Promise<LaunchdState> {
  const overrides = await command(["print-disabled", domain]);
  const body = /^\s*disabled services = \{([\s\S]*)\}\s*$/.exec(
    overrides.stdout,
  );
  if (overrides.code !== 0 || !body)
    throw new Error(`unrecognized launchd disabled status for ${domain}`);
  const entries = [...body[1].matchAll(/"([^"\r\n]+)"\s*=>\s*(true|false)/g)];
  if (body[1].replace(/"([^"\r\n]+)"\s*=>\s*(true|false)/g, "").trim())
    throw new Error(`unrecognized launchd disabled status for ${domain}`);
  const matches = entries.filter((entry) => entry[1] === label);
  if (matches.length > 1)
    throw new Error(`ambiguous launchd disabled status for ${label}`);
  const disabled = matches[0]?.[2] === "true";
  const result = await command(["print", `${domain}/${label}`]);
  if (
    result.code === 113 &&
    result.stderr.includes(`Could not find service "${label}"`)
  )
    return { loaded: false, disabled, pid: null };
  if (
    result.code !== 0 ||
    !result.stdout.trimStart().startsWith(`${domain}/${label} = {`)
  )
    throw new Error(`unrecognized launchd service status for ${label}`);
  const value = (name: string) =>
    new RegExp(`^\\s*${name} = ([^\\r\\n]+)$`, "m")
      .exec(result.stdout)?.[1]
      .trim();
  const argumentsBody = /^\s*arguments = \{\s*\n([\s\S]*?)^\s*\}/m.exec(
    result.stdout,
  )?.[1];
  const args = argumentsBody
    ?.split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    value("path") !== agent ||
    (value("program") ?? value("program path")) !== expectedArgs[0] ||
    !args ||
    JSON.stringify(args) !== JSON.stringify(expectedArgs)
  )
    throw new Error(`unverifiable launchd ownership for ${label}`);
  const pidText = value("pid");
  const pid = pidText === undefined ? null : Number(pidText);
  if (pid !== null && (!Number.isSafeInteger(pid) || pid <= 0))
    throw new Error(`unrecognized launchd PID for ${label}`);
  return { loaded: true, disabled, pid };
}
