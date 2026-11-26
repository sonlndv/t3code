import type { ProviderDriverKind, ServerProvider } from "@t3tools/contracts";
import { OmpSettings, PiSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makePiUsageReader } from "./usage.ts";
import { makePiTextGeneration } from "./textGeneration.ts";
import { createPiAdapterV2Driver, type PiAdapterV2DriverEnv } from "./adapter.ts";
import { OMP_FLAVOR, PI_FLAVOR, type PiFlavor } from "./flavor.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialPiProviderSnapshot,
  checkPiProviderStatus,
  discoverPiCommandsForCwd,
  enrichPiSnapshot,
} from "./status.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";

export type PiDriverEnv =
  | PiAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const withInstanceIdentity =
  (input: {
    readonly driverKind: ProviderDriverKind;
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: input.driverKind,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function createPiDriver(
  flavor: PiFlavor,
  configSchema: typeof PiSettings,
): ProviderDriver<PiSettings, PiDriverEnv, Path.Path | FileSystem.FileSystem> {
  const decodeSettings = Schema.decodeSync(configSchema);
  const defaultConfig = () => decodeSettings({});
  const adapterDriver = createPiAdapterV2Driver({ flavor, configSchema, defaultConfig });
  const updateResolver = makePackageManagedProviderMaintenanceResolver({
    provider: flavor.driverKind,
    npmPackageName: flavor.npmPackageName,
    mise: { tool: flavor.binaryName === "omp" ? "oh-my-pi" : "pi" },
    nativeUpdate: flavor.binaryName === "pi" ? { args: ["update", "--self"] } : null,
  });
  return {
    driverKind: flavor.driverKind,
    metadata: {
      displayName: flavor.displayName,
      supportsMultipleInstances: true,
    },
    usage: makePiUsageReader(flavor),
    configSchema,
    defaultConfig,
    create: Effect.fn(`${flavor.displayName}Driver.create`)(function* ({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const host = yield* ProviderHost.ProviderHost;
      // Pi runs extensions' session_start in its cwd; the server's cwd is $HOME on packaged desktop.
      const probeCwd = pathService.join(host.paths.providerStatusCacheDir, flavor.probeDirName);
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: flavor.driverKind,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        driverKind: flavor.driverKind,
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(updateResolver, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* adapterDriver
        .create({
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: flavor.driverKind,
                instanceId,
                detail: `Failed to build ${flavor.displayName} orchestration adapter.`,
                cause,
              }),
          ),
        );
      const textGeneration = yield* makePiTextGeneration(
        effectiveConfig,
        processEnv,
        host.compatibility,
        flavor,
      );

      const checkProvider = fileSystem
        .makeDirectory(probeCwd, { recursive: true })
        .pipe(
          Effect.ignore,
          Effect.andThen(
            checkPiProviderStatus(
              effectiveConfig,
              processEnv,
              probeCwd,
              host.compatibility,
              flavor,
            ),
          ),
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<PiSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialPiProviderSnapshot(settings.provider, flavor).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichPiSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: flavor.driverKind,
              instanceId,
              detail: `Failed to build ${flavor.displayName} snapshot.`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: flavor.driverKind,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd: (workspaceCwd) =>
          !effectiveConfig.enabled || flavor.binaryName === "omp"
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                discoverPiCommandsForCwd(effectiveConfig, processEnv, workspaceCwd).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: flavor.driverKind,
                        instanceId,
                        detail: "Failed to discover Pi workspace commands.",
                        cause,
                      }),
                  ),
                ),
              ]).pipe(
                Effect.map(([machineSnapshot, commands]) => ({
                  ...machineSnapshot,
                  ...commands,
                  slashCommandsPending: false,
                })),
              ),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
  };
}

export const PiDriver = createPiDriver(PI_FLAVOR, PiSettings);
export const OmpDriver = createPiDriver(OMP_FLAVOR, OmpSettings);
