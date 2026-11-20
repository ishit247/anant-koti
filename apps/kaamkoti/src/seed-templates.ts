// Trade templates loaded by the development seed. Step 1.4 fills out the first real one (AC and appliance repair).
import type { TradeTemplate } from "./trade-template.ts";

export const seedTemplates: readonly TradeTemplate[] = [
  {
    key: "ac_repair",
    version: 1,
    body: {
      title: "AC and appliance repair",
      catalogue: [
        {
          key: "visit",
          name: "Inspection visit",
          unit: "visit",
          unitPriceMinor: 30_000,
          taxRateBp: 1800,
        },
        {
          key: "gas_refill",
          name: "AC gas refill",
          unit: "unit",
          unitPriceMinor: 250_000,
          taxRateBp: 1800,
        },
        {
          key: "service",
          name: "AC general service",
          unit: "unit",
          unitPriceMinor: 80_000,
          taxRateBp: 1800,
        },
      ],
      intake: [
        {
          key: "appliance",
          label: "Which appliance?",
          type: "choice",
          required: true,
          options: ["Split AC", "Window AC", "Refrigerator", "Washing machine"],
        },
        { key: "problem", label: "What is the problem?", type: "text", required: true },
        {
          key: "photo",
          label: "Photo of the appliance or error code",
          type: "photo",
          required: false,
        },
      ],
      checklist: [
        { key: "power_off", label: "Power isolated before opening" },
        { key: "tested", label: "Tested running after repair" },
      ],
      terms:
        "Quote is valid for 7 days. Parts replaced carry a 30-day warranty. Payment is due on completion.",
    },
  },
];
