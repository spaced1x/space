import { createServerFn } from "@tanstack/react-start";

import { boot } from "../core/boot.server";
import { systemInformation } from "../core/config/system.server";

export const getSystemInformation = createServerFn({ method: "GET" }).handler(async () => {
  await boot();
  return systemInformation();
});