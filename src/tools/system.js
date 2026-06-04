// tools/system.js — settings, webhooks, users, themes. Gated by GHOST_ALLOW_SYSTEM.
// These are the highest-privilege actions. Destructive ones (webhook/user delete)
// additionally require GHOST_ALLOW_DELETE.

import { z } from "zod";
import { ok, fail, slimUser, slimWebhook, loadBytes } from "../helpers.js";

export function registerSystemTools(server, ghost, flags) {
  if (!flags.system) return;

  // ---------- Settings ----------
  server.registerTool(
    "ghost_get_settings",
    {
      title: "Get site settings",
      description: "Return the site settings as a key→value map (title, description, navigation, locale, etc.).",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await ghost.getSettings();
        const map = {};
        for (const s of res.settings || []) map[s.key] = s.value;
        return ok(map);
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_update_settings",
    {
      title: "Update site settings",
      description:
        "Update site settings. Pass a 'settings' object of key→value pairs " +
        "(e.g. { \"title\": \"My Blog\", \"description\": \"...\" }). Confirm with the user first.",
      inputSchema: {
        settings: z.record(z.any()).describe("Key→value map of settings to change."),
      },
    },
    async ({ settings }) => {
      try {
        const payload = Object.entries(settings).map(([key, value]) => ({ key, value }));
        if (!payload.length) return fail("No settings provided.");
        const res = await ghost.updateSettings(payload);
        const map = {};
        for (const s of res.settings || []) map[s.key] = s.value;
        return ok({ updated: payload.map((p) => p.key), settings: map });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  // ---------- Webhooks (Admin API supports create/update/delete only) ----------
  server.registerTool(
    "ghost_create_webhook",
    {
      title: "Create webhook",
      description: "Register a webhook that POSTs to a target URL when an event fires (e.g. 'post.published').",
      inputSchema: {
        event: z.string().min(1).describe("Event name, e.g. 'post.published', 'member.added'."),
        target_url: z.string().min(1).describe("URL Ghost will POST to."),
        name: z.string().optional(),
        secret: z.string().optional().describe("Optional signing secret."),
      },
    },
    async (args) => {
      try {
        const wh = { event: args.event, target_url: args.target_url };
        if (args.name !== undefined) wh.name = args.name;
        if (args.secret !== undefined) wh.secret = args.secret;
        const res = await ghost.create("webhooks", wh);
        return ok({ created: slimWebhook(res.webhooks?.[0]) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_update_webhook",
    {
      title: "Update webhook",
      description: "Update an existing webhook by id.",
      inputSchema: {
        id: z.string().min(1),
        event: z.string().optional(),
        target_url: z.string().optional(),
        name: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const wh = {};
        if (args.event !== undefined) wh.event = args.event;
        if (args.target_url !== undefined) wh.target_url = args.target_url;
        if (args.name !== undefined) wh.name = args.name;
        const res = await ghost.update("webhooks", args.id, wh);
        return ok({ updated: slimWebhook(res.webhooks?.[0]) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  if (flags.allowDelete) {
    server.registerTool(
      "ghost_delete_webhook",
      {
        title: "Delete webhook",
        description: "Delete a webhook by id. IRREVERSIBLE.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await ghost.remove("webhooks", id);
          return ok({ deleted: id, note: "Webhook deleted." });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  // ---------- Users / staff (no create via Admin API; use invites in the UI) ----------
  server.registerTool(
    "ghost_list_users",
    {
      title: "List users",
      description: "List staff users (authors/editors/admins).",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      try {
        const res = await ghost.list("users", { limit: String(limit), include: "roles" });
        return ok((res.users || []).map(slimUser));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_get_user",
    {
      title: "Get a user",
      description: "Fetch a staff user by id or slug. Provide exactly one.",
      inputSchema: {
        id: z.string().optional(),
        slug: z.string().optional(),
      },
    },
    async ({ id, slug }) => {
      if ((!id && !slug) || (id && slug)) return fail("Provide exactly one of 'id' or 'slug'.");
      try {
        const res = id
          ? await ghost.getById("users", id, { include: "roles" })
          : await ghost.getBySlug("users", slug, { include: "roles" });
        const u = res.users?.[0];
        if (!u) return fail("User not found.");
        return ok(slimUser(u));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_update_user",
    {
      title: "Update user",
      description: "Update a staff user's profile by id (name, bio, website, location, etc.).",
      inputSchema: {
        id: z.string().min(1),
        name: z.string().optional(),
        bio: z.string().max(200).optional(),
        website: z.string().optional(),
        location: z.string().optional(),
      },
    },
    async (args) => {
      try {
        const u = {};
        for (const k of ["name", "bio", "website", "location"]) if (args[k] !== undefined) u[k] = args[k];
        const res = await ghost.update("users", args.id, u);
        return ok({ updated: slimUser(res.users?.[0]) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  if (flags.allowDelete) {
    server.registerTool(
      "ghost_delete_user",
      {
        title: "Delete user",
        description: "Permanently delete a staff user by id. IRREVERSIBLE and removes their content authorship. Confirm carefully.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await ghost.remove("users", id);
          return ok({ deleted: id, note: "User deleted." });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  // ---------- Themes ----------
  if (flags.write) {
    server.registerTool(
      "ghost_upload_theme",
      {
        title: "Upload theme",
        description: "Upload a theme .zip from a local path or URL. Does NOT activate it. Provide exactly one of path/url.",
        inputSchema: {
          path: z.string().optional().describe("Absolute local path to the theme .zip."),
          url: z.string().optional().describe("Remote URL of the theme .zip."),
        },
      },
      async ({ path, url }) => {
        try {
          const { data, filename } = await loadBytes({ path, url });
          const res = await ghost.uploadTheme({ data, filename });
          const theme = res.themes?.[0];
          return ok({ uploaded: theme?.name, active: theme?.active });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      "ghost_activate_theme",
      {
        title: "Activate theme",
        description: "Activate an already-uploaded theme by name.",
        inputSchema: { name: z.string().min(1).describe("Theme name (folder name).") },
      },
      async ({ name }) => {
        try {
          const res = await ghost.activateTheme(name);
          const theme = res.themes?.[0];
          return ok({ active: theme?.name, status: theme?.active ? "active" : "uploaded" });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }
}
