import { handleApiRequest } from "@kirimail/api";
import { createFileRoute } from "@tanstack/react-router";

async function proxyRequestToApi(request: Request) {
  return handleApiRequest(request);
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyRequestToApi(request),
      POST: ({ request }) => proxyRequestToApi(request),
      PUT: ({ request }) => proxyRequestToApi(request),
      PATCH: ({ request }) => proxyRequestToApi(request),
      DELETE: ({ request }) => proxyRequestToApi(request),
      OPTIONS: ({ request }) => proxyRequestToApi(request),
      HEAD: ({ request }) => proxyRequestToApi(request),
    },
  },
});
