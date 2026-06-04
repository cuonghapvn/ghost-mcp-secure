// config.js — environment parsing and privilege flags.
// ------------------------------------------------------------------
// Secure-by-default: everything is read-only until a flag opts in.
// Each capability domain has its own env flag, plus two cross-cutting
// sub-gates (publish, delete) that further restrict dangerous actions.
// ------------------------------------------------------------------

const bool = (v) => String(v ?? "").toLowerCase() === "true";

export function loadConfig(env = process.env) {
  const {
    GHOST_API_URL,
    GHOST_ADMIN_API_KEY,
    GHOST_API_VERSION = "v6.0",
  } = env;

  const flags = {
    write: bool(env.GHOST_WRITE_ENABLED), // create/update content + upload images
    publish: bool(env.GHOST_ALLOW_PUBLISH), // allow status -> published/scheduled
    allowDelete: bool(env.GHOST_ALLOW_DELETE), // any delete tool
    members: bool(env.GHOST_ALLOW_MEMBERS), // member tools (PII)
    monetization: bool(env.GHOST_ALLOW_MONETIZATION), // tiers/offers/newsletters
    system: bool(env.GHOST_ALLOW_SYSTEM), // settings/webhooks/users/themes
  };

  return { GHOST_API_URL, GHOST_ADMIN_API_KEY, GHOST_API_VERSION, flags };
}

// Human-readable summary of the active privilege tier, for the startup log.
export function describeMode(flags) {
  const on = [];
  if (flags.write) on.push("write");
  if (flags.publish) on.push("publish");
  if (flags.allowDelete) on.push("delete");
  if (flags.members) on.push("members");
  if (flags.monetization) on.push("monetization");
  if (flags.system) on.push("system");
  return on.length ? on.join("+") : "read-only";
}

// Build the MCP server instructions string from the active flags so the
// model is told exactly what it can and cannot do this session.
export function buildInstructions(flags) {
  const lines = [
    "Tools for managing a Ghost CMS blog. Reading posts/pages/tags/site info is always allowed.",
    flags.write
      ? "Content writing is ENABLED: you may create and edit posts, pages, and tags, and upload images."
      : "Content writing is DISABLED: only read tools are available for content.",
    flags.publish
      ? "Publishing is permitted via an explicit status on create/update (draft/published/scheduled)."
      : "Publishing is disabled; new content stays draft and you cannot change a post's status to published.",
    flags.allowDelete
      ? "Deletion is ENABLED for this session. Always confirm with the user before deleting anything; deletes are irreversible."
      : "Deletion is DISABLED; no delete tool exists in this session.",
    flags.members
      ? "Member management is ENABLED. Member data is sensitive PII — never expose it unnecessarily and confirm before edits/deletes."
      : "Member management is DISABLED; member data is not accessible.",
    flags.monetization
      ? "Monetization tools (tiers/offers/newsletters) are ENABLED. These affect billing and bulk email — confirm before changes."
      : "Monetization tools are DISABLED.",
    flags.system
      ? "System tools (settings/webhooks/users/themes) are ENABLED. These are high-privilege admin actions — confirm before any change."
      : "System tools are DISABLED.",
    "Before creating, editing, or deleting, confirm the title/intent with the user if there is any ambiguity.",
  ];
  return lines.join(" ");
}
