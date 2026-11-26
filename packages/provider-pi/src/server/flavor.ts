import { ProviderDriverKind, type UsageProviderKind } from "@t3tools/contracts";

export interface PiFlavor {
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly binaryName: "pi" | "omp";
  readonly npmPackageName: string;
  readonly defaultAgentDirSegments: readonly [string, ...string[]];
  readonly usageProvider: UsageProviderKind;
  readonly probeDirName: string;
}

export const PI_FLAVOR: PiFlavor = {
  driverKind: ProviderDriverKind.make("pi"),
  displayName: "Pi",
  binaryName: "pi",
  npmPackageName: "@earendil-works/pi-coding-agent",
  defaultAgentDirSegments: [".pi", "agent"],
  usageProvider: "pi",
  probeDirName: "pi-status-probe",
};

export const OMP_FLAVOR: PiFlavor = {
  driverKind: ProviderDriverKind.make("omp"),
  displayName: "OMP",
  binaryName: "omp",
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  defaultAgentDirSegments: [".omp", "agent"],
  usageProvider: "omp",
  probeDirName: "omp-status-probe",
};
