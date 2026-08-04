import { createServerFn } from "@tanstack/react-start";

import { systemInformation } from "../core/config/system.server";

export const getSystemInformation = createServerFn({ method: "GET" }).handler(async () => {
  return systemInformation();
});
