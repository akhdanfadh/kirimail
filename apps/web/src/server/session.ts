import { auth } from "@kirimail/auth";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

export const getCurrentSessionFn = createServerFn({ method: "GET" }).handler(async () => {
  const request = getRequest();

  return auth.api.getSession({
    headers: request.headers,
  });
});
