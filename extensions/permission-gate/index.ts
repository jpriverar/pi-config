import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const commandStart = String.raw`(?:^|(?:&&|\|\||[;|])\s*)`;
const binary = (name: string) => String.raw`(?:/(?:[^\s/]+/)*${name}|${name})`;
const commandEnd = String.raw`(?=\s|$)`;
const rootArgumentEnd = String.raw`(?=\s*(?:$|&&|\|\||[;|]))`;

const denied: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("sudo")}${commandEnd}`,
    ),
    label: "sudo",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("rm")}\s+(?:-(?:rf|fr|r)|--recursive)\s+/${rootArgumentEnd}`,
    ),
    label: "recursive rm of /",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("killall")}${commandEnd}`,
    ),
    label: "killall",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("mkfs")}(?:\.[^\s]+)?${commandEnd}`,
    ),
    label: "mkfs",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("fdisk")}${commandEnd}`,
    ),
    label: "fdisk",
  },
  {
    pattern: new RegExp(String.raw`${commandStart}${binary("dd")}\s+if=`),
    label: "dd from device or file",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("chmod")}\s+-R\s+777\s+/${rootArgumentEnd}`,
    ),
    label: "recursive chmod of /",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("chown")}\s+-R\s+\S+\s+/${rootArgumentEnd}`,
    ),
    label: "recursive chown of /",
  },
  {
    pattern: new RegExp(
      String.raw`${commandStart}${binary("git")}\s+push\s+(?:--force|-f)${commandEnd}`,
    ),
    label: "force push",
  },
];

export default function permissionGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return undefined;

    const command = event.input.command;
    if (typeof command !== "string") return undefined;
    const normalized = command.trim().replace(/\s+/g, " ");
    const match = denied.find(({ pattern }) => pattern.test(normalized));
    if (!match) return undefined;

    return {
      block: true,
      reason: `Denied by permission gate: ${match.label}`,
    };
  });
}
