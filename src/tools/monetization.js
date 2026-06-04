// tools/monetization.js — tiers, offers, newsletters. Gated by GHOST_ALLOW_MONETIZATION.
// Ghost has no hard-delete for these; they are archived (tiers: active=false,
// offers/newsletters: status="archived") via the update tools instead.

import { z } from "zod";
import { ok, fail, slimTier, slimOffer, slimNewsletter } from "../helpers.js";

function setIf(target, args, keys) {
  for (const k of keys) if (args[k] !== undefined) target[k] = args[k];
}

export function registerMonetizationTools(server, ghost, flags) {
  if (!flags.monetization) return;

  // ---------- Tiers ----------
  server.registerTool(
    "ghost_list_tiers",
    {
      title: "List tiers",
      description: "List subscription tiers (paid/free) with pricing.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      try {
        const res = await ghost.list("tiers", { limit: String(limit), include: "monthly_price,yearly_price" });
        return ok((res.tiers || []).map(slimTier));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  const tierFields = ["name", "description", "monthly_price", "yearly_price", "currency", "benefits", "welcome_page_url", "visibility", "trial_days", "active"];

  if (flags.write) {
    server.registerTool(
      "ghost_create_tier",
      {
        title: "Create tier",
        description: "Create a paid subscription tier. Prices are in the smallest currency unit (cents).",
        inputSchema: {
          name: z.string().min(1).describe("Tier name."),
          description: z.string().optional(),
          monthly_price: z.number().int().optional().describe("Monthly price in cents, e.g. 500 = $5.00."),
          yearly_price: z.number().int().optional().describe("Yearly price in cents."),
          currency: z.string().length(3).optional().describe("ISO currency, e.g. 'usd'."),
          benefits: z.array(z.string()).optional(),
          welcome_page_url: z.string().optional(),
          visibility: z.enum(["public", "none"]).optional(),
          trial_days: z.number().int().min(0).optional(),
        },
      },
      async (args) => {
        try {
          const tier = {};
          setIf(tier, args, tierFields);
          const res = await ghost.create("tiers", tier);
          return ok({ created: slimTier(res.tiers?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      "ghost_update_tier",
      {
        title: "Update tier",
        description: "Update a tier by id. Set active=false to archive it (tiers cannot be hard-deleted).",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().optional(),
          description: z.string().optional(),
          monthly_price: z.number().int().optional(),
          yearly_price: z.number().int().optional(),
          currency: z.string().length(3).optional(),
          benefits: z.array(z.string()).optional(),
          welcome_page_url: z.string().optional(),
          visibility: z.enum(["public", "none"]).optional(),
          trial_days: z.number().int().min(0).optional(),
          active: z.boolean().optional().describe("false archives the tier."),
        },
      },
      async (args) => {
        try {
          const tier = {};
          setIf(tier, args, tierFields);
          const res = await ghost.update("tiers", args.id, tier);
          return ok({ updated: slimTier(res.tiers?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  // ---------- Offers ----------
  server.registerTool(
    "ghost_list_offers",
    {
      title: "List offers",
      description: "List discount offers.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      try {
        const res = await ghost.list("offers", { limit: String(limit) });
        return ok((res.offers || []).map(slimOffer));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  if (flags.write) {
    server.registerTool(
      "ghost_create_offer",
      {
        title: "Create offer",
        description:
          "Create a discount offer tied to a tier. type=percent uses amount as a percentage; " +
          "type=fixed uses amount in cents and needs a currency.",
        inputSchema: {
          name: z.string().min(1).describe("Internal offer name."),
          code: z.string().min(1).describe("URL code, e.g. 'black-friday'."),
          tier_id: z.string().min(1).describe("Id of the tier this offer applies to."),
          cadence: z.enum(["month", "year"]).describe("Billing cadence the offer applies to."),
          type: z.enum(["percent", "fixed"]).describe("Discount type."),
          amount: z.number().int().describe("Percent (1-100) or fixed amount in cents."),
          duration: z.enum(["once", "forever", "repeating"]).default("once"),
          duration_in_months: z.number().int().optional().describe("Required when duration=repeating."),
          currency: z.string().length(3).optional().describe("Required when type=fixed."),
          display_title: z.string().optional(),
          display_description: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const offer = {
            name: args.name,
            code: args.code,
            tier: { id: args.tier_id },
            cadence: args.cadence,
            type: args.type,
            amount: args.amount,
            duration: args.duration,
          };
          setIf(offer, args, ["duration_in_months", "currency", "display_title", "display_description"]);
          const res = await ghost.create("offers", offer);
          return ok({ created: slimOffer(res.offers?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      "ghost_update_offer",
      {
        title: "Update offer",
        description: "Update an offer by id. Set status='archived' to retire it (offers cannot be hard-deleted).",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().optional(),
          code: z.string().optional(),
          display_title: z.string().optional(),
          display_description: z.string().optional(),
          status: z.enum(["active", "archived"]).optional(),
        },
      },
      async (args) => {
        try {
          const offer = {};
          setIf(offer, args, ["name", "code", "display_title", "display_description", "status"]);
          const res = await ghost.update("offers", args.id, offer);
          return ok({ updated: slimOffer(res.offers?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }

  // ---------- Newsletters ----------
  server.registerTool(
    "ghost_list_newsletters",
    {
      title: "List newsletters",
      description: "List newsletters.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(20) },
    },
    async ({ limit }) => {
      try {
        const res = await ghost.list("newsletters", { limit: String(limit) });
        return ok((res.newsletters || []).map(slimNewsletter));
      } catch (e) {
        return fail(e.message);
      }
    }
  );

  const newsletterFields = ["name", "description", "status", "subscribe_on_signup", "sender_name", "sender_reply_to", "show_header_title"];

  if (flags.write) {
    server.registerTool(
      "ghost_create_newsletter",
      {
        title: "Create newsletter",
        description: "Create a newsletter.",
        inputSchema: {
          name: z.string().min(1).describe("Newsletter name."),
          description: z.string().optional(),
          subscribe_on_signup: z.boolean().optional(),
          sender_name: z.string().optional(),
          sender_reply_to: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const nl = {};
          setIf(nl, args, newsletterFields);
          // opt_in_existing=true subscribes current members per Ghost convention; keep false-safe default off.
          const res = await ghost.create("newsletters", nl);
          return ok({ created: slimNewsletter(res.newsletters?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );

    server.registerTool(
      "ghost_update_newsletter",
      {
        title: "Update newsletter",
        description: "Update a newsletter by id. Set status='archived' to retire it.",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().optional(),
          description: z.string().optional(),
          status: z.enum(["active", "archived"]).optional(),
          subscribe_on_signup: z.boolean().optional(),
          sender_name: z.string().optional(),
          sender_reply_to: z.string().optional(),
        },
      },
      async (args) => {
        try {
          const nl = {};
          setIf(nl, args, newsletterFields);
          const res = await ghost.update("newsletters", args.id, nl);
          return ok({ updated: slimNewsletter(res.newsletters?.[0]) });
        } catch (e) {
          return fail(e.message);
        }
      }
    );
  }
}
