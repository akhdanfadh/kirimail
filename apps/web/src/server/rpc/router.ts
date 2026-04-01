import { implement } from "@orpc/server";

import { rpcContract } from "./contract";

const rpc = implement(rpcContract).$context<{ headers: Headers }>();

export const rpcRouter = {
  ping: rpc.ping.handler(async () => ({
    pong: true,
  })),
};
