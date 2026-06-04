// tools/members.js — member management. Entire module is gated by GHOST_ALLOW_MEMBERS.
// Member records contain personal data (emails); delete additionally needs GHOST_ALLOW_DELETE.

import { z } from "zod";
import { ok, fail, slimMember } from "../helpers.js";

export function registerMemberTools(server, ghost, flags) {
  if (!flags.members) return;

  server.registerTool(
    "ghost_list_members",
    {
      title: "List members",
      description:
        "List members (subscribers). Contains personal data — only retrieve what the user actually needs.",
      inputSchema: {
        search: z.string().optional().describe("Search by name or email."),
        limit: z.number().int().min(1).max(50).default(15),
        page: z.number().int().min(1).default(1),
      },
    },
    async ({ search, limit, page }) => {
      try {
        const query = {
          limit: String(limit),
          page: String(page),
          order: "created_at desc",
          include: "labels,tiers",
        };
        if (search) query.search = search;
        const res = await ghost.list("members", query);
        return ok({ meta: res.meta?.pagination, members: (res.members || []).map(slimMember) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_get_member",
    {
      title: "Get a member",
      description: "Fetch a single member by id.",
      inputSchema: { id: z.string().min(1) },
    },
    async ({ id }) => {
      try {
        const res = await ghost.getById("members", id, { include: "labels,tiers" });
        const m = res.members?.[0];
        if (!m) return fail("Member not found.");
        return ok(slimMember(m));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_create_member",
    {
      title: "Create member",
      description: "Add a new member by email. Optionally name, note, labels, newsletter subscription.",
      inputSchema: {
        email: z.string().email().describe("Member email address."),
        name: z.string().optional(),
        note: z.string().max(500).optional(),
        labels: z.array(z.string()).optional().describe("Label names."),
        subscribed: z.boolean().optional().describe("Subscribe to the default newsletter."),
      },
    },
    async (args) => {
      try {
        const m = { email: args.email };
        if (args.name !== undefined) m.name = args.name;
        if (args.note !== undefined) m.note = args.note;
        if (args.labels !== undefined) m.labels = args.labels.map((name) => ({ name }));
        if (args.subscribed !== undefined) m.subscribed = args.subscribed;
        const res = await ghost.create("members", m);
        return ok({ created: slimMember(res.members?.[0]) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_update_member",
    {
      title: "Update member",
      description: "Update an existing member by id.",
      inputSchema: {
        id: z.string().min(1),
        email: z.string().email().optional(),
        name: z.string().optional(),
        note: z.string().max(500).optional(),
        labels: z.array(z.string()).optional(),
        subscribed: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        const m = {};
        if (args.email !== undefined) m.email = args.email;
        if (args.name !== undefined) m.name = args.name;
        if (args.note !== undefined) m.note = args.note;
        if (args.labels !== undefined) m.labels = args.labels.map((name) => ({ name }));
        if (args.subscribed !== undefined) m.subscribed = args.subscribed;
        const res = await ghost.update("members", args.id, m);
        return ok({ updated: slimMember(res.members?.[0]) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  if (flags.allowDelete) {
    server.registerTool(
      "ghost_delete_member",
      {
        title: "Delete member",
        description: "Permanently delete a member by id. IRREVERSIBLE — confirm with the user first.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await ghost.remove("members", id);
          return ok({ deleted: id, note: "Member deleted." });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }
}
