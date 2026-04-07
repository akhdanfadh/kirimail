import { oc } from "@orpc/contract";
import { z } from "zod";

const systemContract = oc.route({ tags: ["system"] });

export const rpcContract = {
  ping: systemContract
    .route({
      method: "GET",
      path: "/ping",
      summary: "Return a simple liveness response",
    })
    .output(
      z.object({
        pong: z.literal(true),
      }),
    ),
};
