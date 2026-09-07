import { Inngest } from "inngest";
export const inngest = new Inngest({
  id: "hahm-ebay-lister",
  checkpointing: { maxRuntime: "260s" },
});
