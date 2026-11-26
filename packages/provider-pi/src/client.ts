import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings, PiSettings } from "./settings.ts";

export const piClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("pi"),
  label: "Pi",
  acpRegistryAgentIds: ["pi-acp"],
  settingsSchema: PiSettings,
  icon: {
    viewBox: "165.29 165.29 469.43 469.43",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
        fillRule: "evenodd",
      },
      { d: "M517.36 400H634.72V634.72H517.36Z" },
    ],
  },
});

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "OMP",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M12 2.5C6.753 2.5 2.5 6.753 2.5 12S6.753 21.5 12 21.5 21.5 17.247 21.5 12 17.247 2.5 12 2.5ZM12 6.25A5.75 5.75 0 1 1 6.25 12 5.756 5.756 0 0 1 12 6.25Z",
        fillRule: "evenodd",
      },
      { d: "M12 9.25A2.75 2.75 0 1 0 14.75 12 2.75 2.75 0 0 0 12 9.25Z" },
    ],
  },
});
