// tools/images.js — image upload. Needs GHOST_WRITE_ENABLED.

import { z } from "zod";
import { ok, fail, loadBytes } from "../helpers.js";

export function registerImageTools(server, ghost, flags) {
  if (!flags.write) return;

  server.registerTool(
    "ghost_upload_image",
    {
      title: "Upload image",
      description:
        "Upload an image to Ghost and get back the hosted URL to embed in post/page HTML. " +
        "Provide EXACTLY ONE source: 'path' (local file), 'url' (remote image), or " +
        "'data_base64' (base64 bytes / data URI — use this for an image pasted or attached in chat). " +
        "Note: 'path' only works when the server can read your local disk (local stdio); for a remote-hosted " +
        "server use 'url' or 'data_base64'.",
      inputSchema: {
        path: z.string().optional().describe("Absolute local file path to the image."),
        url: z.string().optional().describe("Remote image URL to download, then upload."),
        data_base64: z
          .string()
          .optional()
          .describe("Base64-encoded image bytes, or a full 'data:<mime>;base64,...' URI."),
        filename: z
          .string()
          .optional()
          .describe("Filename with extension (e.g. 'photo.png'). Recommended with data_base64 so the type is detected."),
        purpose: z
          .enum(["image", "profile_image", "icon"])
          .optional()
          .describe("Ghost image purpose (default 'image')."),
        ref: z.string().optional().describe("Optional reference string returned alongside the URL."),
      },
    },
    async ({ path, url, data_base64, filename, purpose, ref }) => {
      try {
        const { data, filename: name, contentType } = await loadBytes({ path, url, data_base64, filename });
        const res = await ghost.uploadImage({ data, filename: name, contentType, purpose, ref });
        const img = res.images?.[0];
        if (!img?.url) return fail("Upload succeeded but no URL was returned.");
        return ok({ url: img.url, ref: img.ref });
      } catch (e) {
        return fail(e.message);
      }
    }
  );
}
