import { cloudEnabled } from "@/lib/cloud/store";
import { serve } from "inngest/next";
import { inngest } from "@/lib/cloud/inngest";
import {
  generateDraft,
  expireBatches,
  dispatchQueued,
} from "@/lib/cloud/worker";
export const maxDuration = 300;
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: cloudEnabled()
    ? [generateDraft, expireBatches, dispatchQueued]
    : [],
});
