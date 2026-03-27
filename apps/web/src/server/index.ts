import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { Hono } from "hono";
import { rpcRouter } from "./rpc/router";

const apiV1Prefix = "/api/v1";

const rpcHandler = new RPCHandler(rpcRouter, {
  interceptors: [
    onError((error) => {
      console.error("oRPC handler error", error);
    }),
  ],
});

const openApiHandler = new OpenAPIHandler(rpcRouter, {
  plugins: [
    new OpenAPIReferencePlugin({
      docsPath: "/docs",
      specPath: "/openapi.json",
      schemaConverters: [new ZodToJsonSchemaConverter()],
      specGenerateOptions: {
        info: {
          title: "Inbok API",
          version: "1.0.0",
        },
        servers: [{ url: apiV1Prefix }],
      },
    }),
  ],
  interceptors: [
    onError((error) => {
      console.error("oRPC OpenAPI handler error", error);
    }),
  ],
});

const apiApp = new Hono();

apiApp.get(`${apiV1Prefix}/health`, (c) =>
  c.json({
    status: "ok",
    service: "inbok-web-api",
  }),
);

apiApp.use(`${apiV1Prefix}/rpc/*`, async (c, next) => {
  const { matched, response } = await rpcHandler.handle(c.req.raw, {
    prefix: `${apiV1Prefix}/rpc`,
    context: {
      headers: c.req.raw.headers,
    },
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

apiApp.use(`${apiV1Prefix}/*`, async (c, next) => {
  const { matched, response } = await openApiHandler.handle(c.req.raw, {
    prefix: apiV1Prefix,
    context: {
      headers: c.req.raw.headers,
    },
  });

  if (matched) {
    return c.newResponse(response.body, response);
  }

  await next();
});

apiApp.notFound((c) => c.json({ error: "Not Found" }, 404));

export function handleApiRequest(request: Request) {
  return apiApp.fetch(request);
}
