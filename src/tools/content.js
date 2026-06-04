// tools/content.js — posts, pages, and tags.
// Reads are always available. Create/update need GHOST_WRITE_ENABLED.
// Status changes (publish/schedule) need GHOST_ALLOW_PUBLISH. Deletes need GHOST_ALLOW_DELETE.

import { z } from "zod";
import { ok, fail, slimPost, slimPage, slimTag } from "../helpers.js";

// Validate a requested status against the publish flag.
function guardStatus(status, publishedAt, flags) {
  if (status && status !== "draft" && !flags.publish) {
    return "Publishing is disabled this session (set GHOST_ALLOW_PUBLISH=true). No changes made.";
  }
  if (status === "scheduled" && !publishedAt) {
    return "status=scheduled requires 'published_at' (a future ISO date).";
  }
  return null;
}

// Build a Ghost doc (post/page) body from tool args.
function buildDoc(args) {
  const doc = {};
  if (args.title !== undefined) doc.title = args.title;
  if (args.html !== undefined) doc.html = args.html;
  if (args.excerpt !== undefined) doc.custom_excerpt = args.excerpt;
  if (args.featured !== undefined) doc.featured = args.featured;
  if (args.tags !== undefined) doc.tags = args.tags.map((name) => ({ name }));
  if (args.status !== undefined) doc.status = args.status;
  if (args.published_at !== undefined) doc.published_at = args.published_at;
  return doc;
}

// Register list/get (+ create/update/delete when allowed) for "posts" or "pages".
function registerDocTools(server, ghost, flags, { resource, singular, slim }) {
  server.registerTool(
    `ghost_list_${resource}`,
    {
      title: `List ${resource}`,
      description:
        `List ${resource} with optional status/tag filtering and pagination. ` +
        "Returns slimmed metadata (no full body) to keep results compact.",
      inputSchema: {
        status: z.enum(["all", "draft", "published", "scheduled"]).default("all").describe("Filter by status."),
        tag: z.string().optional().describe("Filter by tag slug, e.g. 'pmo'."),
        limit: z.number().int().min(1).max(50).default(15),
        page: z.number().int().min(1).default(1),
      },
    },
    async ({ status, tag, limit, page }) => {
      try {
        const filters = [];
        if (status !== "all") filters.push(`status:${status}`);
        if (tag) filters.push(`tag:${tag}`);
        const query = { limit: String(limit), page: String(page), order: "updated_at desc" };
        if (filters.length) query.filter = filters.join("+");
        const res = await ghost.list(resource, query);
        return ok({ meta: res.meta?.pagination, [resource]: (res[resource] || []).map(slim) });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    `ghost_get_${singular}`,
    {
      title: `Get a ${singular}`,
      description: `Fetch a single ${singular} by id or slug, including its full HTML body. Provide exactly one of id or slug.`,
      inputSchema: {
        id: z.string().optional().describe(`${singular} id.`),
        slug: z.string().optional().describe(`${singular} slug.`),
      },
    },
    async ({ id, slug }) => {
      if ((!id && !slug) || (id && slug)) return fail("Provide exactly one of 'id' or 'slug'.");
      try {
        const query = { formats: "html", include: "tags,authors" };
        const res = id
          ? await ghost.getById(resource, id, query)
          : await ghost.getBySlug(resource, slug, query);
        const doc = res[resource]?.[0];
        if (!doc) return fail(`${singular} not found.`);
        return ok({ ...slim(doc), html: doc.html });
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  if (flags.write) {
    const createStatus = flags.publish
      ? z.enum(["draft", "published", "scheduled"]).default("draft")
      : z.enum(["draft"]).default("draft");
    const updateStatus = flags.publish
      ? z.enum(["draft", "published", "scheduled"]).optional()
      : z.enum(["draft"]).optional();

    server.registerTool(
      `ghost_create_${singular}`,
      {
        title: `Create ${singular}`,
        description:
          `Create a NEW ${singular}. Defaults to DRAFT. ` +
          (flags.publish
            ? "Set status=published or status=scheduled (with published_at) to publish."
            : "Publishing is disabled this session; it stays a draft."),
        inputSchema: {
          title: z.string().min(1).max(255).describe(`${singular} title.`),
          html: z.string().min(1).describe("Body as HTML."),
          tags: z.array(z.string()).optional().describe("Tag names; created if they don't exist."),
          excerpt: z.string().max(300).optional().describe("Custom excerpt."),
          featured: z.boolean().optional().describe("Mark as featured."),
          status: createStatus.describe("Publish status."),
          published_at: z.string().optional().describe("ISO date; required when status=scheduled."),
        },
      },
      async (args) => {
        try {
          const guard = guardStatus(args.status, args.published_at, flags);
          if (guard) return fail(guard);
          const doc = buildDoc(args);
          const res = await ghost.create(resource, doc, { query: { source: "html" } });
          return ok({ created: slim(res[resource]?.[0]), note: `Created as ${doc.status || "draft"}.` });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      `ghost_update_${singular}`,
      {
        title: `Update ${singular}`,
        description:
          `Update an EXISTING ${singular} by id. Keeps current status unless you set 'status'. ` +
          (flags.publish ? "" : "Changing status to published/scheduled is rejected this session."),
        inputSchema: {
          id: z.string().min(1).describe(`Id of the ${singular} to update.`),
          title: z.string().min(1).max(255).optional(),
          html: z.string().optional().describe("New HTML body. Replaces existing body if provided."),
          tags: z.array(z.string()).optional().describe("Replaces the tags if provided."),
          excerpt: z.string().max(300).optional(),
          featured: z.boolean().optional(),
          status: updateStatus.describe("New publish status."),
          published_at: z.string().optional().describe("ISO date; required when status=scheduled."),
        },
      },
      async (args) => {
        try {
          if (args.status !== undefined) {
            const guard = guardStatus(args.status, args.published_at, flags);
            if (guard) return fail(guard);
          }
          // Ghost requires the current updated_at for optimistic concurrency control.
          const current = await ghost.getById(resource, args.id, { formats: "html" });
          const existing = current[resource]?.[0];
          if (!existing) return fail(`${singular} not found.`);
          const doc = buildDoc(args);
          doc.updated_at = existing.updated_at;
          const res = await ghost.update(resource, args.id, doc, { query: { source: "html" } });
          return ok({
            updated: slim(res[resource]?.[0]),
            note: args.status ? `Status set to ${args.status}.` : "Status unchanged.",
          });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  if (flags.allowDelete) {
    server.registerTool(
      `ghost_delete_${singular}`,
      {
        title: `Delete ${singular}`,
        description: `Permanently delete a ${singular} by id. IRREVERSIBLE — confirm with the user first.`,
        inputSchema: { id: z.string().min(1).describe(`Id of the ${singular} to delete.`) },
      },
      async ({ id }) => {
        try {
          await ghost.remove(resource, id);
          return ok({ deleted: id, note: `${singular} deleted.` });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }
}

function registerTagTools(server, ghost, flags) {
  server.registerTool(
    "ghost_list_tags",
    {
      title: "List tags",
      description: "List tags on the Ghost blog with their post counts.",
      inputSchema: { limit: z.number().int().min(1).max(100).default(50) },
    },
    async ({ limit }) => {
      try {
        const res = await ghost.list("tags", { limit: String(limit), order: "name asc", include: "count.posts" });
        return ok((res.tags || []).map(slimTag));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  server.registerTool(
    "ghost_get_tag",
    {
      title: "Get a tag",
      description: "Fetch a single tag by id or slug. Provide exactly one.",
      inputSchema: {
        id: z.string().optional(),
        slug: z.string().optional(),
      },
    },
    async ({ id, slug }) => {
      if ((!id && !slug) || (id && slug)) return fail("Provide exactly one of 'id' or 'slug'.");
      try {
        const q = { include: "count.posts" };
        const res = id ? await ghost.getById("tags", id, q) : await ghost.getBySlug("tags", slug, q);
        const tag = res.tags?.[0];
        if (!tag) return fail("Tag not found.");
        return ok(slimTag(tag));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  const tagFields = ["name", "slug", "description", "accent_color", "visibility"];

  if (flags.write) {
    server.registerTool(
      "ghost_create_tag",
      {
        title: "Create tag",
        description: "Create a new tag.",
        inputSchema: {
          name: z.string().min(1).max(191).describe("Tag name."),
          slug: z.string().optional(),
          description: z.string().max(500).optional(),
          accent_color: z.string().optional().describe("Hex color, e.g. #ff0000."),
          visibility: z.enum(["public", "internal"]).optional(),
        },
      },
      async (args) => {
        try {
          const tag = {};
          for (const k of tagFields) if (args[k] !== undefined) tag[k] = args[k];
          const res = await ghost.create("tags", tag);
          return ok({ created: slimTag(res.tags?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      "ghost_update_tag",
      {
        title: "Update tag",
        description: "Update an existing tag by id.",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().min(1).max(191).optional(),
          slug: z.string().optional(),
          description: z.string().max(500).optional(),
          accent_color: z.string().optional(),
          visibility: z.enum(["public", "internal"]).optional(),
        },
      },
      async (args) => {
        try {
          const tag = {};
          for (const k of tagFields) if (args[k] !== undefined) tag[k] = args[k];
          const res = await ghost.update("tags", args.id, tag);
          return ok({ updated: slimTag(res.tags?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  if (flags.allowDelete) {
    server.registerTool(
      "ghost_delete_tag",
      {
        title: "Delete tag",
        description: "Permanently delete a tag by id (posts are kept, they just lose the tag). IRREVERSIBLE.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }) => {
        try {
          await ghost.remove("tags", id);
          return ok({ deleted: id, note: "Tag deleted." });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }
}

export function registerContentTools(server, ghost, flags) {
  registerDocTools(server, ghost, flags, { resource: "posts", singular: "post", slim: slimPost });
  registerDocTools(server, ghost, flags, { resource: "pages", singular: "page", slim: slimPage });
  registerTagTools(server, ghost, flags);
}
