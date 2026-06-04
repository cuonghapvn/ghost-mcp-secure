// tools/site.js — site info (always available, read-only).

import { ok, fail } from "../helpers.js";

export function registerSiteTools(server, ghost) {
  server.registerTool(
    "ghost_site_info",
    {
      title: "Site info",
      description: "Return basic information about the Ghost site (title, description, version, url).",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await ghost.list("site");
        return ok(res.site || res);
      } catch (e) {
        return fail(e.message);
      }
    }
  );
}
